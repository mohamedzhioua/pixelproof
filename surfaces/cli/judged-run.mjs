/**
 * The `--judge host` path shared by `generate` and `verify` (ADR 0009 §1, §2).
 *
 * Both commands do the same three things once a judge is asked for: open a run
 * directory, put the artifact and its mechanical result inside it, and either
 * finish the run or hand a checklist to the host. Only the first step differs —
 * `generate` produces the artifact into the run directory, `verify` copies an
 * existing one in — so that is the only part left to the callers.
 *
 * ## What this path refuses, and why
 *
 * **A raster target.** `--judge host` is an explicit request for a semantic
 * judgement, and there is nothing for a vision capability to open in a vector
 * file. Silently degrading the request to `SKIP` would report success without
 * evidence, which is the failure this project exists to prevent. ADR 0019 leaves
 * degraded SVG semantics open, and pre-empting it here would be inventing the
 * answer rather than making it.
 *
 * **A spec with at least one `semantic` assertion.** Asking a host to judge a
 * checklist with nothing on it is a mistake, not a state worth modelling. ADR
 * 0009 §6's "no judge configured" row is a different case: there the assertions
 * exist and nobody judged them, so they report `SKIP` and are unverified.
 *
 * Both refusals happen *before* a provider is invoked, so neither costs a
 * generation.
 *
 * ## Where the file appears
 *
 * Under `--judge`, the generator writes into the run directory and the artifact
 * appears at `--out` only when the run is accepted (ADR 0009 §2). An abandoned
 * run therefore leaves no file where a caller would look for one. This is the
 * mechanical form of "an unanswered checklist is not a pass".
 */

import path from 'node:path';

import { assignCheckIds } from '../../core/contracts/check-id.mjs';
import {
  HOST_JUDGE,
  OUTCOME_REASONS,
  describeRemaining,
  issueFirstRound,
  parseDeadline,
  pendingRequestFile,
  specDigestFor,
} from '../../core/judge/index.mjs';
import { REJECTED, createRun, finaliseRun, recordAttempt } from '../../core/run/index.mjs';
import { semanticAssertions } from '../../core/spec/load-v1.mjs';
import { printChecklist } from './format-judge.mjs';
import { readVersion } from './version.mjs';

const defaultOutput = globalThis.console;

/** Exit 2 — an outstanding judgement. Never a pass (ADR 0009 §1). */
export const PENDING_JUDGEMENT_EXIT = 2;

/** The judge names this build wires. ADR 0009's subprocess panel is not one of them yet. */
export const SUPPORTED_JUDGES = Object.freeze([HOST_JUDGE]);

/**
 * Validate `--judge` and `--judge-deadline` and decide whether this run is
 * judged at all. Returns `null` when no judge was asked for, which is the path
 * that must stay byte-identical to v1.
 */
export function resolveJudgeOptions(options, { artifact, requireSpec = true, spec = null } = {}) {
  const requested = options.judge ?? null;
  if (requested === null) {
    if (options.judgeDeadline) {
      throw new Error('--judge-deadline only means something with --judge');
    }
    return null;
  }

  if (!SUPPORTED_JUDGES.includes(requested)) {
    throw new Error(
      `--judge must be one of ${SUPPORTED_JUDGES.join(', ')}, not "${requested}". `
        + 'Subprocess judges are built but are not wired to this command yet.',
    );
  }

  if (path.extname(artifact ?? '').toLowerCase() !== '.png') {
    throw new Error(
      `--judge ${requested} needs a raster target; ${artifact} is not a .png. `
        + 'A vector file has nothing for a vision capability to open, and reporting the '
        + 'assertions as skipped would call an unverified image verified.',
    );
  }

  const assertions = semanticAssertions(spec);
  if (requireSpec && assertions.length === 0) {
    throw new Error(
      `--judge ${requested} needs a spec with at least one entry in its "semantic" array; `
        + 'there is nothing to judge otherwise.',
    );
  }

  return {
    judge: requested,
    deadlineMs: options.judgeDeadline ? parseDeadline(options.judgeDeadline) : undefined,
    assertions,
  };
}

/**
 * Open the run directory a judged run lives in.
 *
 * `resolved` records what this invocation decided, including where the artifact
 * is promoted to on acceptance. Its interior is a diagnostic bag whose shape is
 * not versioned (ADR 0014 §3), which is exactly why it may hold the absolute
 * `--out` a later `judge submit` has to write to.
 */
export async function openJudgedRun({
  command,
  runDir = null,
  out = null,
  specPath = null,
  provider = null,
  strict = false,
  judge,
  now,
}) {
  return createRun({
    runDir,
    command,
    now,
    pixelproofVersion: await readVersion(),
    resolved: {
      judge,
      out: out === null ? null : path.resolve(out),
      spec: specPath === null ? null : path.resolve(specPath),
      provider,
      strict,
    },
  });
}

/** `<runDir>/attempt-1.png` — where the generator is pointed. */
export function attemptTarget(directory, out, attempt = 1) {
  return path.join(directory, `attempt-${attempt}${path.extname(out) || '.png'}`);
}

/**
 * Record the attempt and either finish the run or issue the checklist.
 *
 * A mechanical failure ends the run here and no checklist is written. Semantic
 * assertions are hard gates (ADR 0011), so a mechanically failed artifact is
 * already rejected — spending a host round on it could only produce the
 * confusing case where every assertion passes and the run is still rejected.
 *
 * @returns {Promise<number>} the exit code: 1 rejected, 2 pending.
 */
export async function completeJudgedRun(directory, {
  run,
  artifactPath,
  copy,
  verification,
  spec,
  specPath = null,
  assertions,
  deadlineMs,
  out = null,
  attempt = 1,
  now = new Date(),
  output = defaultOutput,
}) {
  const recorded = await recordAttempt(directory, {
    artifact: { path: artifactPath },
    verification,
    copy,
    number: attempt,
    now,
  });

  if (verification.ok !== true) {
    await finaliseRun(directory, {
      state: REJECTED,
      reason: {
        code: OUTCOME_REASONS.mechanicalFailed,
        message: `${verification.failed} mechanical check(s) failed; no host round was spent on a rejected artifact`,
      },
      now,
    });
    output.log('');
    output.log(`Rejected on the mechanical tier. Nothing was written to ${out ?? 'the target'}.`);
    output.log(`The candidate and its report are in ${directory}.`);
    return 1;
  }

  const { record } = await issueFirstRound(directory, {
    run: recorded.run,
    checks: assignCheckIds(assertions),
    artifactPath: recorded.attempt.artifact.path,
    artifactSha256: recorded.attempt.artifact.sha256,
    artifactBytes: recorded.attempt.artifact.bytes,
    context: typeof spec?.description === 'string' ? spec.description : null,
    specDigest: specDigestFor(spec ?? null),
    deadlineMs,
    pixelproofVersion: await readVersion(),
    attempt,
    now,
  });

  output.log('');
  printChecklist(record, {
    artifact: path.resolve(directory, record.artifact.path),
    requestFile: path.join(directory, pendingRequestFile(record.round)),
    remaining: `in ${describeRemaining(record.expiresAt, now)}`,
    out: out === null ? null : path.resolve(out),
  }, output);

  return PENDING_JUDGEMENT_EXIT;
}
