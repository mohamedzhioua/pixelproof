/**
 * The pending envelope: `judge-request-<round>.json` and
 * `judge-result-<round>.json` (ADR 0009 §2).
 *
 * **The envelope wraps the protocol, it does not extend it.** The `request`
 * block is exactly what `validateJudgeRequest()` accepts today and the
 * `response` block is exactly what `parseJudgeResponse()` accepts today;
 * everything the handoff needs — the nonce, the deadline, the round, the
 * digests — sits *outside* them. Sibling fields on a bare judge request were
 * rejected as an option because ADR 0006's policy is to reject unknown
 * same-version fields, so that shape would break the moment the validator
 * matches its own ADR. Nothing in `core/contracts/judge.mjs` changes to support
 * any of this; if a change there ever looks necessary, that is a finding
 * against ADR 0009 rather than a licence.
 *
 * One asymmetry is deliberate and is the only place this module departs from a
 * verbatim round-trip. `artifact.path` and `request.file` are stored
 * **relative** to the run directory, per ADR 0014 §2, so a run directory that is
 * archived, copied, or mounted somewhere else in a container stays readable —
 * ADR 0009 §3 declines to pin a run to a hostname, and pinning it to an absolute
 * path would take that back with the other hand. But a judge process cannot open
 * a path relative to a directory it was never told about, so
 * `pendingRequestFor()` resolves `file` against the directory it just read from.
 * The record is portable; the emitted request is consumable.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateJudgeRequest } from '../contracts/judge.mjs';
import { PROTOCOL_VERSION } from '../contracts/provider.mjs';
import { serialiseJson, writeAtomic } from '../run/store.mjs';
import { DEFAULT_DEADLINE_MS, expiryFrom } from './deadline.mjs';
import { PendingError } from './errors.mjs';
import { checksDigestFor, isNonce, newNonce } from './digest.mjs';

export const JUDGE_PENDING_SCHEMA = 'pixelproof.judge-pending/1';
export const JUDGE_RESULT_SCHEMA = 'pixelproof.judge-result/1';

/**
 * ADR 0009 §5 bounds escalation at two rounds. There is no round 3: a genuinely
 * ambiguous assertion terminates in `fail` rather than in an endless re-ask.
 */
export const MAX_ROUNDS = 2;

/** The name this handoff answers to, and the only judge kind this build wires. */
export const HOST_JUDGE = 'host';

function assertRound(round) {
  if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) {
    throw new TypeError(`round must be an integer from 1 through ${MAX_ROUNDS}`);
  }
  return round;
}

export function pendingRequestFile(round) {
  return `judge-request-${assertRound(round)}.json`;
}

export function pendingResultFile(round) {
  return `judge-result-${assertRound(round)}.json`;
}

/** POSIX separators inside the envelope, so it reads the same on either platform. */
function toEnvelopePath(relative) {
  return relative.split(path.sep).join('/');
}

/**
 * Build a pending record.
 *
 * `escalationTerminal` is recorded rather than inferred from the round number:
 * ADR 0009 §5 says a round issued with `onUnsure` forced to `fail` is marked as
 * such in the record, and a reader should not have to re-derive a policy
 * decision from a counter.
 */
export function buildPendingRecord({
  runId,
  round = 1,
  checks,
  artifactPath,
  artifactSha256,
  artifactBytes,
  context = null,
  issuedAt,
  deadlineMs = DEFAULT_DEADLINE_MS,
  expiresAt,
  pixelproofVersion = null,
  specDigest = null,
  onUnsure = 'escalate',
  nonce = newNonce(),
  escalationTerminal = false,
  issuer,
} = {}) {
  assertRound(round);
  if (!isNonce(nonce)) throw new TypeError('a pending record needs a 32-byte hex nonce');
  if (typeof artifactPath !== 'string' || artifactPath.trim() === '') {
    throw new TypeError('a pending record needs the artifact path, relative to the run directory');
  }

  const issued = issuedAt ?? new Date().toISOString();
  const file = toEnvelopePath(artifactPath);

  // Validated here, at the cheapest possible moment, so a malformed checklist
  // fails before a run is ever moved to pending-judgement and a host is asked to
  // look at something the protocol would refuse on return.
  const request = validateJudgeRequest({
    protocol: PROTOCOL_VERSION,
    file,
    context,
    checks,
  });

  return {
    schema: JUDGE_PENDING_SCHEMA,
    protocol: PROTOCOL_VERSION,
    runId,
    round,
    maxRounds: MAX_ROUNDS,
    escalationTerminal,
    onUnsure,
    judge: HOST_JUDGE,
    nonce,
    issuedAt: issued,
    expiresAt: expiresAt ?? expiryFrom(issued, deadlineMs),
    pixelproofVersion,
    issuer: issuer ?? {
      pid: process.pid,
      hostname: os.hostname(),
      cwd: process.cwd(),
    },
    artifact: {
      path: file,
      sha256: artifactSha256,
      bytes: artifactBytes,
    },
    specDigest,
    checksDigest: checksDigestFor(request.checks),
    request,
  };
}

/**
 * Refuse an envelope this build does not speak.
 *
 * `PENDING_SCHEMA_UNSUPPORTED` covers both halves of the mismatch — a different
 * envelope means something read the wrong file, a newer major means this build
 * is older than the run it found — because from the submitter's side the
 * consequence is identical: this build must not act on it.
 */
export function assertPendingSchema(document, expected, { file = null } = {}) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new PendingError('PENDING_SCHEMA_UNSUPPORTED', `${file ?? 'Document'} is not a JSON object`, {
      details: { file, expected },
    });
  }
  if (document.schema !== expected) {
    throw new PendingError(
      'PENDING_SCHEMA_UNSUPPORTED',
      `Refusing to read ${file ?? 'document'} as ${expected}: it declares ${JSON.stringify(document.schema ?? null)}`,
      { details: { file, expected, declared: document.schema ?? null } },
    );
  }
  if (document.protocol !== PROTOCOL_VERSION) {
    throw new PendingError(
      'PENDING_SCHEMA_UNSUPPORTED',
      `${file ?? 'Document'} declares protocol ${JSON.stringify(document.protocol ?? null)}, but this build speaks protocol ${PROTOCOL_VERSION}`,
      { details: { file, protocol: document.protocol ?? null, expected: PROTOCOL_VERSION } },
    );
  }
  return document;
}

export async function writePendingRecord(directory, record) {
  const file = path.join(directory, pendingRequestFile(record.round));
  await writeAtomic(file, serialiseJson(record));
  return file;
}

export async function readPendingRecord(directory, round) {
  const file = path.join(directory, pendingRequestFile(round));

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new PendingError('PENDING_NOT_FOUND', `No ${pendingRequestFile(round)} in ${directory}`, {
        details: { directory, file, round },
        cause: error,
      });
    }
    throw error;
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new PendingError('PENDING_SCHEMA_UNSUPPORTED', `${file} is not valid JSON`, {
      details: { file },
      cause: error,
    });
  }

  return assertPendingSchema(document, JUDGE_PENDING_SCHEMA, { file });
}

/**
 * The bare protocol-1 request a judge consumes, with `file` resolved against
 * the run directory it was read from.
 *
 * This is what `judge show --request` prints, and it is deliberately identical
 * to what a subprocess judge would be handed — one piece of host prose serves
 * both judge kinds (ADR 0009 §2).
 */
export function pendingRequestFor(record, directory) {
  return validateJudgeRequest({
    ...record.request,
    file: path.resolve(directory, record.request.file),
  });
}

/**
 * The persisted submission.
 *
 * The nonce is **not** carried into the result file. It was proven at submit
 * time and its whole job is done; writing a used identity secret into retained
 * evidence would leave it lying around in every archived run directory for no
 * further benefit. "Verdicts as submitted" is what ADR 0009 §2 asks for, and
 * that is what this records.
 */
export function buildResultRecord({ runId, round, checksDigest, response, submittedAt }) {
  return {
    schema: JUDGE_RESULT_SCHEMA,
    protocol: PROTOCOL_VERSION,
    runId,
    round: assertRound(round),
    submittedAt: submittedAt ?? new Date().toISOString(),
    checksDigest,
    response,
  };
}

export async function writeResultRecord(directory, record) {
  const file = path.join(directory, pendingResultFile(record.round));
  await writeAtomic(file, serialiseJson(record));
  return file;
}
