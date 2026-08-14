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
import { AdapterError, normalizeErrorPayload } from '../../core/contracts/errors.mjs';
import { PROTOCOL_VERSION } from '../../core/contracts/provider.mjs';
import { correctionsFor } from '../../core/generation/correction.mjs';
import {
  HOST_JUDGE,
  KIND_SUBPROCESS,
  OUTCOME_REASONS,
  applySubmission,
  boundOf,
  describeRemaining,
  detectJudge,
  discoverJudges,
  issueFirstRound,
  lastRoundOf,
  parseDeadline,
  parsePanelNames,
  pendingRequestFile,
  pendingRequestFor,
  promoteArtifact,
  resolvePanel,
  resolveRetakeBound,
  specDigestFor,
} from '../../core/judge/index.mjs';
import { REJECTED, createRun, finaliseRun, readRun, recordAttempt } from '../../core/run/index.mjs';
import { semanticAssertions } from '../../core/spec/load-v1.mjs';
import { printChecklist, printCorrections, printVerdicts } from './format-judge.mjs';
import { readVersion } from './version.mjs';

const defaultOutput = globalThis.console;

/** Exit 2 — an outstanding judgement. Never a pass (ADR 0009 §1). */
export const PENDING_JUDGEMENT_EXIT = 2;

/**
 * The judge modules this build bundles (ADR 0021 §1, §8).
 *
 * Imported **lazily**, and only when `--judge` names something that is not
 * `host`, for two reasons: a bare `generate` and `--judge host` never load a
 * vendor module they will not use, and a judge module that throws on load
 * cannot take down a path that never needed it. That is the same discipline
 * `doctor` already applies to providers.
 *
 * Built-ins keep the order listed here. It is a decision made once, not an
 * accident of directory listing.
 */
const BUILTIN_JUDGE_LOADERS = Object.freeze([
  { id: 'codex', load: () => import('../../judges/codex.mjs') },
]);

let judgeRegistryPromise = null;

/**
 * The bundled judge registry, built once per process.
 *
 * `core/` never imports `judges/` (ADR 0002). This is the composition layer that
 * does, and it hands the modules over the same way `defaultProviderProbe` hands
 * over providers.
 */
export async function builtinJudgeRegistry() {
  judgeRegistryPromise ??= (async () => {
    const builtins = [];
    for (const { id, load } of BUILTIN_JUDGE_LOADERS) {
      const module = await load();
      builtins.push({
        id,
        manifest: module.manifest,
        detect: module.detect,
        judge: module.judge,
      });
    }
    return discoverJudges({ builtins });
  })();

  return judgeRegistryPromise;
}

/**
 * Validate `--judge` and `--judge-deadline` and decide whether this run is
 * judged at all. Returns `null` when no judge was asked for, which is the path
 * that must stay byte-identical to v1.
 */
/**
 * @param {{retakes?: boolean}} context `retakes: false` for a command that can
 *   never spend a second attempt. `verify` inspects an image somebody else made:
 *   there is no provider call to repeat and no prompt to correct, so it must not
 *   even *validate* `spec.retakes`. Reading a field it cannot act on would let a
 *   spec that verified under v0.3.0 start failing, which is a regression ADR
 *   0003 does not permit and ADR 0020 §6 never asked for.
 */
export async function resolveJudgeOptions(options, { artifact, requireSpec = true, spec = null, retakes = true } = {}) {
  const requested = options.judge ?? null;
  if (requested === null) {
    if (options.judgeDeadline) {
      throw new Error('--judge-deadline only means something with --judge');
    }
    // Refused for the same reason and in the same place: without a judge there
    // is nothing to correct, and honouring a bound here would change what a
    // bare `generate` spends (ADR 0020 §6).
    if (retakes) resolveRetakeBound({ option: options.retakes ?? null, spec, judged: false });
    return null;
  }

  const names = parsePanelNames(requested);

  // The registry is built only when a name other than `host` needs looking up,
  // so `--judge host` still loads no vendor module.
  const registry = names.every((name) => name === HOST_JUDGE) ? null : await builtinJudgeRegistry();
  const panel = resolvePanel({ names, registry, kind: 'raster' });

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

  // A judge that is not installed is refused **here**, before a provider is
  // invoked, so a missing CLI never costs a generation — the same discipline as
  // the raster and spec refusals above. It is also the honest place for it: a
  // judge that cannot run is not a verdict about an artifact, and letting the
  // failure land after generation would reject an image nothing ever looked at.
  //
  // Availability is not authentication (ADR 0016). This proves the executable
  // exists and stops; whether its subscription will answer is unknown until a
  // paid call, and claiming otherwise is what this project exists to prevent.
  for (const member of panel.subprocess) {
    const detected = await detectJudge(member.entry);
    if (detected.available) continue;
    throw new Error(
      `--judge ${member.id} is not usable here: ${detected.reason ?? 'it reported itself unavailable'}.\n`
        + member.entry.manifest.remediation.map((line) => `  ${line}`).join('\n'),
    );
  }

  // A deadline governs how long a checklist stays *answerable*, and nothing is
  // answerable when the judge answers in this process (ADR 0021 §3). Refused in
  // the same place, and for the same reason, as `--judge-deadline` without
  // `--judge`: a flag that cannot act is a claim the tool cannot keep. The
  // subprocess bound is a timeout — PIXELPROOF_JUDGE_TIMEOUT_MS.
  if (options.judgeDeadline && !panel.hasHost) {
    throw new Error(
      `--judge-deadline only means something with a host in the panel; ${requested} answers in this `
        + 'process, so nothing stays outstanding. Use PIXELPROOF_JUDGE_TIMEOUT_MS to bound the call.',
    );
  }

  return {
    judge: requested,
    panel,
    deadlineMs: options.judgeDeadline ? parseDeadline(options.judgeDeadline) : undefined,
    retakes: retakes ? resolveRetakeBound({ option: options.retakes ?? null, spec, judged: true }) : 1,
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
 *
 * ADR 0020 §4 leans on the same property for the retake: `prompt`, `size`,
 * `provider` and `retakes` are everything `pixelproof retake` needs to build
 * attempt *n+1* the way attempt *n* was built. The prompt recorded here is the
 * **original**, before spec folding, because folding is deterministic and
 * re-running it costs nothing, while a folded prompt could not be re-folded
 * against a corrected spec later.
 */
export async function openJudgedRun({
  command,
  runDir = null,
  out = null,
  specPath = null,
  provider = null,
  strict = false,
  judge,
  prompt = null,
  size = null,
  retakes = 1,
  deadlineMs = null,
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
      prompt,
      size,
      retakes,
      deadlineMs,
    },
  });
}

/**
 * One subprocess judging turn, with every failure turned into a protocol reply.
 *
 * `judges/codex.mjs` rejects with an `AdapterError` for a timeout, a non-zero
 * exit, an unparseable reply or a vendor `ok: false` — there is deliberately no
 * path on which it returns partial results. Every one of those means the same
 * thing to a run: **the judging failed, and no verdicts exist**. So they are
 * normalized into the `ok: false` reply the protocol already has a rule for
 * (ADR 0009 §5: a judge that errored finalises the run as rejected, not as a
 * skipped tier), and handed to the same `applySubmission` a host submission
 * reaches.
 *
 * That is what keeps a failed judge on one code path instead of two. It also
 * means the failure is *written down*: `judge-result-<round>.json` records what
 * went wrong, rather than the run dying with the reason only on the terminal.
 *
 * A thrown non-`AdapterError` is rethrown untouched. A bug in this process is
 * not a verdict about the artifact, and dressing one up as a judge reply would
 * record a rejection that nothing judged.
 */
async function judgeOnce(entry, record, directory) {
  const request = pendingRequestFor(record, directory);

  try {
    return await entry.judge(request);
  } catch (error) {
    if (!(error instanceof AdapterError)) throw error;
    const payload = normalizeErrorPayload(error, {
      fallbackMessage: `judge "${entry.id}" failed without a message`,
    });
    return { protocol: PROTOCOL_VERSION, ok: false, judge: entry.id, error: payload };
  }
}

/**
 * Ask one subprocess judge about one attempt, and turn its answer into either an
 * exit code or a correction to retake with (ADR 0021 §3, §4, §7).
 *
 * Returns `{ exit: <code> }` when the run is over, and `{ exit: null,
 * corrections }` when it is not — the one case where the caller has work left.
 * The decision itself is not made here: `applySubmission` makes it, exactly as
 * it does for a host submission, which is what keeps one implementation of what
 * a set of verdicts means.
 */
async function judgeAttempt(directory, { entry, record, attempt, out, output, now }) {
  output.log('');
  output.log(
    `Judging attempt ${attempt} with "${entry.id}": `
      + `${record.request.checks.length} assertion(s), round ${record.round}.`,
  );

  const response = await judgeOnce(entry, record, directory);
  const applied = await applySubmission(directory, {
    // Re-read rather than reused: `issueFirstRound` has just written the judge
    // block and the round summary, and `applySubmission` folds its verdicts into
    // that table. Handing it the pre-issue record would fold into a run that did
    // not yet know it was being judged.
    run: await readRun(directory),
    record,
    response,
    attempt,
    judgeId: entry.id,
    pixelproofVersion: await readVersion(),
    now,
  });

  if (applied.checks.length > 0) {
    output.log('');
    printVerdicts(applied.checks, output);
  }
  output.log('');

  if (applied.outcome === 'accepted') {
    // The judgement is accepted either way; delivery is a separate fact. A
    // failed copy exits non-zero because the caller asked for a file at --out
    // and does not have one, and says where the accepted artifact actually is.
    try {
      const promoted = await promoteArtifact(directory, { run: applied.run, attempt });
      output.log(`Accepted: ${applied.reason}.`);
      output.log(promoted ? `Promoted to ${promoted}` : `The accepted artifact is in ${directory}.`);
      return { exit: 0, corrections: null };
    } catch (error) {
      output.error(`Accepted, but promoting the artifact failed: ${error.message}`);
      output.error(`The accepted artifact is in ${directory}.`);
      return { exit: 1, corrections: null };
    }
  }

  // Unreachable while a panel is one judge — a subprocess-only panel has no
  // escalation authority, so `decideOutcome` never returns `escalate` (ADR 0021
  // §6). Handled rather than asserted against, because the mixed panel of ADR
  // 0009 §5 will reach it, and a silent fall-through to "rejected" would report
  // an outstanding judgement as a verdict.
  if (applied.outcome === 'escalated') {
    printChecklist(applied.record, {
      artifact: path.resolve(directory, applied.record.artifact.path),
      requestFile: path.join(directory, pendingRequestFile(applied.record.round)),
      remaining: `in ${describeRemaining(applied.record.expiresAt, now)}`,
      out: out === null ? null : path.resolve(out),
    }, output);
    return { exit: PENDING_JUDGEMENT_EXIT, corrections: null };
  }

  if (applied.outcome === 'retakeable') {
    return {
      exit: null,
      // Assembled from the verdicts just recorded rather than re-read from disk:
      // the same objects `applySubmission` wrote into `attempt-<n>.json`. The
      // mechanical half is empty by construction — a mechanically failed attempt
      // never reaches a judge.
      corrections: correctionsFor({ verification: null, semantic: { checks: applied.checks } }),
    };
  }

  output.log(`Rejected: ${applied.reason}. Nothing was written to ${out ?? 'the target'}.`);
  if (applied.noEscalationAuthority === true) {
    // The one rejection an operator can act on directly, so it says how.
    output.log(
      'At least one assertion was unsure, and this panel has no escalation authority. '
        + `Add ,host to --judge to escalate an unsure verdict to the calling agent.`,
    );
  }
  output.log(`The candidate and its report are in ${directory}.`);
  return { exit: 1, corrections: null };
}

/** `<runDir>/attempt-1.png` — where the generator is pointed. */
export function attemptTarget(directory, out, attempt = 1) {
  return path.join(directory, `attempt-${attempt}${path.extname(out) || '.png'}`);
}

/**
 * Record the attempt and either finish the run, retake it, or issue the
 * checklist.
 *
 * A mechanical failure never reaches a host. Semantic assertions are hard gates
 * (ADR 0011), so a mechanically failed artifact is already rejected — spending a
 * host round on it could only produce the confusing case where every assertion
 * passes and the run is still rejected.
 *
 * What ADR 0020 §2 adds is what happens *instead*, when the retake bound is
 * unspent: the failure is recorded, corrected from that attempt's own measured
 * values, and regenerated **in the same process**. No host is involved in a
 * mechanical failure, so nothing has to wait, and asking an operator to type
 * `pixelproof retake` for a size the tool measured itself would be ceremony. The
 * semantic half is the opposite case and is deliberately handled elsewhere:
 * there the two verdicts arrive in different processes, so `judge submit` prints
 * the retake command rather than spending a generation nobody authorised.
 *
 * `regenerate` is what makes this a loop. `verify --judge host` passes none, so
 * its behaviour is unchanged: one attempt, then finish or hand off.
 *
 * @param {{regenerate?: ((step: {attempt: number, corrections: object}) =>
 *   Promise<{verification: object, artifactPath: string}>)|null}} options
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
  regenerate = null,
  panel = null,
  now = new Date(),
  output = defaultOutput,
}) {
  // Read from the run record rather than taken as a parameter, so this and
  // `applySubmission` — which reads `boundOf` too — cannot disagree about the
  // same run's bound. They agreed before only because two call sites happened to
  // pass the number that was written.
  const bound = boundOf(run);
  const pending = panel === null || panel.hasHost;
  let currentAttempt = attempt;
  let currentArtifact = artifactPath;
  let currentVerification = verification;
  let currentCopy = copy;

  for (;;) {
    const recorded = await recordAttempt(directory, {
      artifact: { path: currentArtifact },
      verification: currentVerification,
      copy: currentCopy,
      number: currentAttempt,
      now,
    });

    if (currentVerification.ok === true) {
      // Rounds are numbered across the whole run, so a retake continues the
      // counter rather than overwriting an earlier attempt's checklist (ADR 0020
      // §5). Read per iteration rather than once before the loop: a subprocess
      // attempt issues *and answers* a round before the next attempt begins, so
      // a counter computed once would give attempt 2 the round number attempt 1
      // already used, and its request file would overwrite the first.
      const round = lastRoundOf(recorded.run) + 1;
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
        attempt: currentAttempt,
        round,
        kind: panel?.kind ?? HOST_JUDGE,
        panel: panel?.members ?? null,
        // The request file is written either way, before anything is asked. What
        // `pending` decides is whether the run *pauses* on it (ADR 0021 §3).
        pending,
        now,
      });

      if (pending) {
        output.log('');
        printChecklist(record, {
          artifact: path.resolve(directory, record.artifact.path),
          requestFile: path.join(directory, pendingRequestFile(record.round)),
          remaining: `in ${describeRemaining(record.expiresAt, now)}`,
          out: out === null ? null : path.resolve(out),
        }, output);

        return PENDING_JUDGEMENT_EXIT;
      }

      const judged = await judgeAttempt(directory, {
        entry: panel.subprocess[0].entry,
        record,
        attempt: currentAttempt,
        out,
        output,
        now,
      });

      if (judged.exit !== null) return judged.exit;

      // Unreachable through the CLI: `verify` is the only caller that passes no
      // `regenerate`, and it resolves its bound to 1, so `applySubmission`
      // finalises rather than offering a retake. Named rather than left to a
      // TypeError, because the alternative failure is a run that says it is
      // retakeable and nothing that can retake it.
      if (regenerate === null) {
        throw new Error(
          `Attempt ${currentAttempt} is retakeable, but this command cannot regenerate. `
            + 'A retake bound above 1 needs a generating command.',
        );
      }

      // Rejected with the bound unspent: correct from the judge's own evidence
      // and spend the next attempt here (ADR 0021 §7). Unlike the host path,
      // both verdicts are in this process, so there is nobody to hand the
      // decision back to — `--retakes` already authorised it.
      output.log('');
      output.log(
        `Attempt ${currentAttempt} was rejected by "${panel.subprocess[0].id}". `
          + `Retaking: attempt ${currentAttempt + 1} of ${bound}.`,
      );
      printCorrections(judged.corrections, { attempt: currentAttempt }, output);

      const retaken = await regenerate({ attempt: currentAttempt + 1, corrections: judged.corrections });
      currentAttempt += 1;
      currentArtifact = retaken.artifactPath;
      currentVerification = retaken.verification;
      currentCopy = false;
      continue;
    }

    const left = bound - currentAttempt;
    if (left > 0 && regenerate !== null) {
      const corrections = correctionsFor(recorded.attempt);
      output.log('');
      output.log(
        `Attempt ${currentAttempt} failed ${currentVerification.failed} mechanical check(s). `
          + `Retaking: attempt ${currentAttempt + 1} of ${bound}.`,
      );
      printCorrections(corrections, { attempt: currentAttempt }, output);

      const next = await regenerate({ attempt: currentAttempt + 1, corrections });
      currentAttempt += 1;
      currentArtifact = next.artifactPath;
      currentVerification = next.verification;
      // The retake was written into the run directory already; copying it onto
      // itself would only create a second name for the same bytes.
      currentCopy = false;
      continue;
    }

    // Nothing is promoted on exhaustion (ADR 0020 §7): `--out` stays empty and
    // the report lists every attempt, so an operator can choose one by hand.
    // There is no ranking function to appeal to — scoring is unbuilt — and
    // "best" would silently mean "last".
    const exhausted = bound > 1;
    await finaliseRun(directory, {
      state: REJECTED,
      reason: {
        code: exhausted ? OUTCOME_REASONS.exhausted : OUTCOME_REASONS.mechanicalFailed,
        message: exhausted
          ? `${currentAttempt} attempt(s) failed the mechanical tier; the retake bound of ${bound} is spent`
          : `${currentVerification.failed} mechanical check(s) failed; no host round was spent on a rejected artifact`,
      },
      now,
    });
    output.log('');
    output.log(`Rejected on the mechanical tier. Nothing was written to ${out ?? 'the target'}.`);
    output.log(`The candidate and its report are in ${directory}.`);
    return 1;
  }
}
