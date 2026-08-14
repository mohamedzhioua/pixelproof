/**
 * Judge adapter contract (ADR 0010, ADR 0011).
 *
 * A judge reports a verdict per check and nothing else. "Looks good" without a
 * per-assertion verdict is a protocol violation, not a pass — a model's summary
 * opinion is exactly the thing this project exists to stop trusting.
 *
 * Verdicts are tri-state. `unsure` is never silently promoted to `pass`; the
 * whole point of having a third state is that "I could not tell" is different
 * from "it is fine", and collapsing them would reintroduce the failure mode.
 */

import { AdapterError, normalizeErrorPayload } from './errors.mjs';
import { isCheckId } from './check-id.mjs';
import { ARTIFACT_KINDS, ID_PATTERN, PROTOCOL_VERSION } from './provider.mjs';

export const VERDICTS = Object.freeze(['pass', 'fail', 'unsure']);
export const CONSENSUS_POLICIES = Object.freeze(['all', 'any', 'majority']);
export const UNSURE_POLICIES = Object.freeze(['escalate', 'fail']);

/** The transports a judge may declare. Only one exists (ADR 0021 §8). */
export const JUDGE_TRANSPORTS = Object.freeze(['subprocess']);

/** Declared, never probed: `known` requires proof at zero cost (ADR 0016). */
export const AUTH_STATES = Object.freeze(['known', 'unknown']);

/**
 * Names no judge adapter may register under (ADR 0021 §1).
 *
 * `host` is a *run state*, not a registry entry — ADR 0009 §1 models it as two
 * invocations precisely because it is not a synchronous adapter. A module
 * registering under that name would create a second thing that could disagree
 * with the first about what `--judge host` means.
 */
export const RESERVED_JUDGE_IDS = Object.freeze(['host']);

const VERDICT_SET = new Set(VERDICTS);

/**
 * A malformed *request*: the caller asked for something impossible.
 * `INVALID_REQUEST` is aimed at whoever built the request.
 */
function invalid(message, details) {
  return new AdapterError('INVALID_REQUEST', message, { retryable: false, details: details ?? null });
}

/**
 * A malformed *response*: the judge broke the protocol.
 *
 * This is `INTERNAL`, not `INVALID_REQUEST`, and the distinction is about who
 * is at fault. When a judge answers checks nobody asked about, the caller's
 * request was fine — blaming it points the operator at the wrong thing, and
 * `INVALID_REQUEST` additionally carries a different exit code.
 * `core/adapters/subprocess.mjs` already treats an adapter's protocol violation
 * as `INTERNAL`; this makes the judge boundary agree with the transport it runs
 * over instead of contradicting it.
 */
function violation(message, details) {
  return new AdapterError('INTERNAL', message, { retryable: false, details: details ?? null });
}

function requirePlainObject(value, label, fault = invalid) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fault(`${label} must be a JSON object`);
  }
  return value;
}

export function validateJudgeRequest(raw) {
  const request = requirePlainObject(raw, 'Judge request');
  if (request.protocol !== PROTOCOL_VERSION) {
    throw invalid(
      `Judge request declares protocol ${JSON.stringify(request.protocol ?? null)}, but this build speaks protocol ${PROTOCOL_VERSION}`,
    );
  }
  if (typeof request.file !== 'string' || request.file.trim() === '') {
    throw invalid('Judge request file must be a non-empty path');
  }
  if (!Array.isArray(request.checks) || request.checks.length === 0) {
    throw invalid('Judge request must carry at least one check');
  }

  const seen = new Set();
  const checks = request.checks.map((entry) => {
    const check = requirePlainObject(entry, 'Judge check');
    if (!isCheckId(check.id)) {
      throw invalid('Judge check id is not a well-formed check identity', { id: check.id ?? null });
    }
    if (seen.has(check.id)) {
      throw invalid('Judge request contains a duplicate check id', { id: check.id });
    }
    seen.add(check.id);
    if (typeof check.assertion !== 'string' || check.assertion.trim() === '') {
      throw invalid(`Judge check ${check.id} must carry a non-empty assertion`);
    }
    return { id: check.id, assertion: check.assertion };
  });

  return {
    protocol: PROTOCOL_VERSION,
    file: request.file,
    context: typeof request.context === 'string' ? request.context : null,
    checks,
  };
}

/**
 * Parse a judge reply against the exact set of checks that were asked. Missing
 * or extra results are rejected rather than tolerated: a partial answer that is
 * silently treated as complete is indistinguishable from a pass.
 */
export function parseJudgeResponse(raw, { expectedIds } = {}) {
  const response = requirePlainObject(raw, 'Judge response', violation);
  if (response.protocol !== PROTOCOL_VERSION) {
    throw violation(
      `Judge response declares protocol ${JSON.stringify(response.protocol ?? null)}, but this build speaks protocol ${PROTOCOL_VERSION}`,
    );
  }

  if (response.ok === false) {
    // Narrow the judge's own code into the closed taxonomy, exactly as the
    // subprocess transport does. Handing back an unvalidated vendor code lets a
    // careless caller propagate a string nobody downstream has to handle.
    const reported = requirePlainObject(response.error, 'Judge response error', violation);
    return {
      ok: false,
      error: normalizeErrorPayload(reported, { fallbackMessage: 'Judge reported a failure' }),
    };
  }
  if (response.ok !== true) {
    throw violation('Judge response ok must be a boolean');
  }
  if (!Array.isArray(response.results)) {
    throw violation('Judge response results must be an array');
  }

  const byId = new Map();
  for (const entry of response.results) {
    const result = requirePlainObject(entry, 'Judge result', violation);
    if (!isCheckId(result.id)) {
      throw violation('Judge result id is not a well-formed check identity', { id: result.id ?? null });
    }
    if (byId.has(result.id)) {
      throw violation('Judge returned duplicate results for one check', { id: result.id });
    }
    if (!VERDICT_SET.has(result.verdict)) {
      throw violation(
        `Judge result ${result.id} verdict must be one of ${VERDICTS.join(', ')}`,
        { verdict: result.verdict ?? null },
      );
    }
    const confidence = result.confidence;
    if (confidence !== undefined && confidence !== null) {
      if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw violation(`Judge result ${result.id} confidence must be a number in [0, 1]`, { confidence });
      }
    }
    byId.set(result.id, {
      id: result.id,
      verdict: result.verdict,
      confidence: typeof confidence === 'number' ? confidence : null,
      evidence: typeof result.evidence === 'string' ? result.evidence : null,
    });
  }

  if (expectedIds !== undefined) {
    const expected = new Set(expectedIds);
    const missing = [...expected].filter((id) => !byId.has(id));
    const unexpected = [...byId.keys()].filter((id) => !expected.has(id));
    if (missing.length > 0 || unexpected.length > 0) {
      throw violation('Judge response does not answer exactly the checks that were asked', {
        missing,
        unexpected,
      });
    }
  }

  return {
    ok: true,
    judge: typeof response.judge === 'string' ? response.judge : null,
    results: [...byId.values()],
  };
}

/**
 * Combine several judges' verdicts for one check.
 *
 * Disagreement is reported, never averaged: two vendors' vision models
 * contradicting each other is a signal about the artifact, and flattening it to
 * a score would discard the most interesting thing the panel produced.
 */
export function combineVerdicts(verdicts, policy = 'all') {
  if (!CONSENSUS_POLICIES.includes(policy)) {
    throw invalid(`Consensus policy must be one of ${CONSENSUS_POLICIES.join(', ')}`, { policy });
  }
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    throw invalid('At least one verdict is required to reach consensus');
  }
  if (verdicts.some((verdict) => !VERDICT_SET.has(verdict))) {
    throw invalid('Every verdict must be pass, fail, or unsure');
  }

  const passes = verdicts.filter((verdict) => verdict === 'pass').length;
  const fails = verdicts.filter((verdict) => verdict === 'fail').length;
  const unsures = verdicts.length - passes - fails;
  const disagreement = (passes > 0 && fails > 0)
    || (unsures > 0 && (passes > 0 || fails > 0));

  let verdict;
  if (policy === 'all') {
    if (fails > 0) verdict = 'fail';
    else if (unsures > 0) verdict = 'unsure';
    else verdict = 'pass';
  } else if (policy === 'any') {
    if (passes > 0) verdict = 'pass';
    else if (fails > 0) verdict = 'fail';
    else verdict = 'unsure';
  } else {
    const decided = passes + fails;
    if (decided === 0) verdict = 'unsure';
    else if (passes > fails) verdict = 'pass';
    else if (fails > passes) verdict = 'fail';
    else verdict = 'unsure';
  }

  return { verdict, passes, fails, unsures, disagreement, policy };
}

/** Every key a judge manifest may carry. Anything else is refused, not dropped. */
const MANIFEST_KEYS = new Set([
  'protocol', 'id', 'role', 'transport', 'kinds', 'capabilities', 'auth', 'remediation',
]);

const CAPABILITY_FLAGS = Object.freeze([
  'vision', 'attachesArtifact', 'batchesChecks', 'confidence', 'evidence', 'constrainedOutput',
]);

const CAPABILITY_KEYS = new Set([...CAPABILITY_FLAGS, 'verdicts', 'maxChecks']);

function requireBooleanFlag(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalid(`Judge capability ${label} must be a boolean when present`, { [label]: value });
  return value;
}

function refuseUnknownKeys(object, allowed, label, id) {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw invalid(
      `${label} for "${id}" carries unknown field(s): ${unknown.join(', ')}. `
        + 'A field this build does not know is refused rather than ignored, because a silently '
        + 'dropped capability claims less than the judge can do and nothing ever says so.',
      { id, unknown },
    );
  }
}

/**
 * Validate a judge manifest as data (ADR 0021 §2).
 *
 * This is deliberately **not** `validateManifest()` from the provider contract.
 * That one is a normalizing allowlist over generation geometry — `minWidth`,
 * `dimensionMultiple`, `seed`, `transparency` — and handed a judge manifest it
 * would discard `role`, `transport`, `auth`, `remediation` and every verdict
 * capability, then hand back a fabricated record describing image generation
 * that no judge performs. The bundled judge adapter says as much in a comment
 * and declines to use it. Reusing a validator that lies about half its input
 * would put that lie in the report `doctor` prints.
 *
 * Two differences from the provider validator are deliberate:
 *
 * 1. **Unknown keys are refused, not dropped.** ADR 0006's policy applied to a
 *    manifest: a typo'd capability that is silently ignored produces a judge
 *    that claims less than it can do, with nothing to say so.
 * 2. **`verdicts` must be all three.** A judge that cannot say `unsure` has no
 *    way to answer "I cannot tell", and ADR 0010's whole point is that it must
 *    not have to guess instead.
 */
export function validateJudgeManifest(raw) {
  const manifest = requirePlainObject(raw, 'Judge manifest');

  if (manifest.protocol !== PROTOCOL_VERSION) {
    throw invalid(
      `Judge manifest declares protocol ${JSON.stringify(manifest.protocol ?? null)}, but this build speaks protocol ${PROTOCOL_VERSION}`,
      { protocol: manifest.protocol ?? null },
    );
  }
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
    throw invalid('Judge manifest id must be lowercase kebab-case', { id: manifest.id ?? null });
  }
  if (RESERVED_JUDGE_IDS.includes(manifest.id)) {
    throw invalid(
      `"${manifest.id}" is a reserved judge name: it is a run state (ADR 0009 §1), not an adapter`,
      { id: manifest.id, reserved: [...RESERVED_JUDGE_IDS] },
    );
  }

  refuseUnknownKeys(manifest, MANIFEST_KEYS, 'Judge manifest', manifest.id);

  if (manifest.role !== 'judge') {
    throw invalid(`Judge manifest "${manifest.id}" must declare role "judge"`, { role: manifest.role ?? null });
  }
  if (!JUDGE_TRANSPORTS.includes(manifest.transport)) {
    throw invalid(
      `Judge "${manifest.id}" must declare a transport from ${JUDGE_TRANSPORTS.join(', ')}`,
      { transport: manifest.transport ?? null },
    );
  }

  const kinds = Array.isArray(manifest.kinds) ? manifest.kinds : [];
  if (kinds.length === 0 || !kinds.every((kind) => ARTIFACT_KINDS.has(kind))) {
    throw invalid(
      `Judge "${manifest.id}" must declare at least one kind from ${[...ARTIFACT_KINDS].join(', ')}`,
      { kinds },
    );
  }

  const capabilities = requirePlainObject(manifest.capabilities ?? {}, `Judge capabilities for "${manifest.id}"`);
  refuseUnknownKeys(capabilities, CAPABILITY_KEYS, 'Judge capabilities', manifest.id);

  const verdicts = Array.isArray(capabilities.verdicts) ? capabilities.verdicts : [];
  if (verdicts.length !== VERDICTS.length || !VERDICTS.every((verdict) => verdicts.includes(verdict))) {
    throw invalid(
      `Judge "${manifest.id}" must speak every verdict in ${VERDICTS.join(', ')}: a judge that cannot say `
        + '"unsure" has to guess instead, which is what the tri-state exists to prevent',
      { verdicts },
    );
  }

  // Absent means *undeclared*, not infinite (ADR 0005). A vendor that has not
  // said how many checks it will answer has not promised to answer any number.
  const maxChecks = capabilities.maxChecks ?? null;
  if (maxChecks !== null && (!Number.isInteger(maxChecks) || maxChecks <= 0)) {
    throw invalid(`Judge "${manifest.id}" maxChecks must be a positive integer or null`, { maxChecks });
  }

  const auth = requirePlainObject(manifest.auth ?? {}, `Judge auth for "${manifest.id}"`);
  if (!AUTH_STATES.includes(auth.state)) {
    throw invalid(
      `Judge "${manifest.id}" must declare auth.state as one of ${AUTH_STATES.join(', ')}`,
      { state: auth.state ?? null },
    );
  }

  const remediation = manifest.remediation ?? [];
  if (!Array.isArray(remediation) || !remediation.every((line) => typeof line === 'string')) {
    throw invalid(`Judge "${manifest.id}" remediation must be an array of strings`, { remediation });
  }

  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    id: manifest.id,
    role: 'judge',
    transport: manifest.transport,
    kinds: Object.freeze([...new Set(kinds)]),
    capabilities: Object.freeze({
      ...Object.fromEntries(CAPABILITY_FLAGS.map((flag) => [flag, requireBooleanFlag(capabilities[flag], flag)])),
      verdicts: VERDICTS,
      maxChecks,
    }),
    auth: Object.freeze({
      state: auth.state,
      detail: typeof auth.detail === 'string' ? auth.detail : null,
      advice: typeof auth.advice === 'string' ? auth.advice : null,
    }),
    remediation: Object.freeze([...remediation]),
  });
}

/**
 * Turn a consensus verdict into an acceptance decision. Semantic assertions are
 * hard gates (ADR 0011): scoring ranks eligible candidates, it never waives a
 * failure, and `unsure` resolves to escalation or failure but never to accepted.
 */
export function acceptanceFor(verdict, { onUnsure = 'escalate' } = {}) {
  if (!UNSURE_POLICIES.includes(onUnsure)) {
    throw invalid(`onUnsure must be one of ${UNSURE_POLICIES.join(', ')}`, { onUnsure });
  }
  if (verdict === 'pass') return { accepted: true, escalate: false };
  if (verdict === 'fail') return { accepted: false, escalate: false };
  return { accepted: false, escalate: onUnsure === 'escalate' };
}
