/**
 * Human presentation of the host handoff (ADR 0009 §6).
 *
 * This module exists so that one piece of prose serves both audiences the ADR
 * names. An **agent host** reads the checklist, opens the artifact with its own
 * vision capability, and submits; a **human at a terminal** reads the same text
 * and either writes the same file by hand or reaches for `--interactive`. Making
 * them two different messages would guarantee that one of them goes stale.
 *
 * The wording carries one line that is not decoration: exit code 2 means an
 * outstanding judgement, not a pass. Every gate already written as "non-zero is
 * failure" is correct by default, and a reader who meets `2` for the first time
 * must not have to guess which side of the line it falls on.
 *
 * The `--out` promotion note is here for the reason ADR 0009's Consequences
 * predicted: `--judge host` and bare `generate` differ in *when* the file
 * appears at `--out`, and that is the part of the design most likely to
 * surprise, so it is said out loud at the moment it matters.
 */

import { renderCorrections } from '../../core/generation/correction.mjs';

const defaultOutput = globalThis.console;

/** The skeleton a submitter fills in. Real ids, real nonce, real digest. */
export function submissionTemplate(record) {
  return {
    runId: record.runId,
    nonce: record.nonce,
    checksDigest: record.checksDigest,
    response: {
      protocol: record.protocol,
      ok: true,
      judge: 'host',
      results: record.request.checks.map((check) => ({
        id: check.id,
        verdict: 'pass',
        evidence: '<one line naming what you actually saw>',
      })),
    },
  };
}

function field(label, value) {
  return `  ${`${label}:`.padEnd(11)}${value}`;
}

/**
 * The checklist, in plain English, plus the exact command to run.
 *
 * @param {object} record the pending record
 * @param {{artifact: string, requestFile: string, remaining: string, out?: string|null}} context
 */
export function renderChecklist(record, { artifact, requestFile, remaining, out = null }) {
  const lines = [];

  lines.push('Pending host judgement — exit code 2 means an outstanding judgement, not a pass.');
  lines.push('');
  lines.push(field('Run', record.runId));
  // `round` is numbered across the whole run and `roundInAttempt` inside the
  // attempt (ADR 0020 §5); on the first attempt they are equal, which is why
  // this line is byte-identical to what it always printed for a single-attempt
  // run. The `Attempt` line appears only when there is more than one attempt to
  // distinguish.
  if ((record.attempt ?? 1) > 1) {
    lines.push(field('Attempt', `${record.attempt} (run round ${record.round})`));
  }
  lines.push(field('Round', `${record.roundInAttempt ?? record.round} of ${record.maxRounds}`));
  lines.push(field('Artifact', artifact));
  lines.push(field('Expires', `${record.expiresAt} (${remaining})`));
  if (record.escalationTerminal) {
    lines.push(field('Escalation', 'final round — an unsure verdict here resolves to fail'));
  }
  if (out) {
    lines.push(field('On accept', `the artifact is copied to ${out}; nothing is written there until then`));
  }
  lines.push('');
  lines.push('Open the artifact with your own image-reading capability and judge every');
  lines.push('assertion below. A verdict is pass, fail or unsure. unsure is never a pass,');
  lines.push('and an assertion nobody judged is unverified rather than satisfied.');
  lines.push('');
  for (const check of record.request.checks) {
    lines.push(`  ${check.id}  ${check.assertion}`);
  }
  lines.push('');
  lines.push('Write these verdicts to a file:');
  lines.push('');
  for (const line of JSON.stringify(submissionTemplate(record), null, 2).split('\n')) {
    lines.push(`  ${line}`);
  }
  lines.push('');
  lines.push('Then submit it:');
  lines.push('');
  lines.push(`  pixelproof judge submit --run ${record.runId} --results verdicts.json`);
  lines.push('');
  lines.push(`The pending record is ${requestFile}.`);
  lines.push('`pixelproof judge show --run <id> --request` prints the bare protocol-1 request;');
  lines.push('at a terminal, `pixelproof judge submit --interactive` prompts for each check.');

  return lines.join('\n');
}

export function printChecklist(record, context, output = defaultOutput) {
  output.log(renderChecklist(record, context));
}

/** One line per open run, for `judge pending`. */
export function renderPendingList(entries, { describeRemaining, hasExpired, now }) {
  if (entries.length === 0) return 'No run is waiting on a host judgement.';

  const lines = [`${entries.length} pending host judgement${entries.length === 1 ? '' : 's'}:`, ''];

  for (const entry of entries) {
    if (entry.error !== null) {
      lines.push(`  ${entry.runId}  UNREADABLE  ${entry.error.code}: ${entry.error.message}`);
      continue;
    }
    const expired = hasExpired(entry.record.expiresAt, now);
    const marker = expired ? 'EXPIRED' : describeRemaining(entry.record.expiresAt, now);
    const attempt = (entry.record.attempt ?? 1) > 1 ? `attempt ${entry.record.attempt}  ` : '';
    lines.push(
      `  ${entry.runId}  ${attempt}round ${entry.record.roundInAttempt ?? entry.record.round}/${entry.record.maxRounds}  `
        + `${entry.record.request.checks.length} check(s)  ${marker}`,
    );
  }

  lines.push('');
  lines.push('An unanswered checklist is never a pass. Answer one with:');
  lines.push('  pixelproof judge submit --run <id> --results verdicts.json');
  lines.push('or close it on the record with:');
  lines.push('  pixelproof judge abandon --run <id> --reason "<why>"');

  return lines.join('\n');
}

/** What the host actually said, after a submission. */
export function renderVerdicts(checks) {
  const lines = ['Semantic verdicts:'];
  for (const check of checks) {
    const escalated = check.escalatedFrom
      ? ` (round ${check.escalatedFrom.round} said ${check.escalatedFrom.verdict}; the escalation round replaced it)`
      : '';
    lines.push(`  ${check.verdict.toUpperCase().padEnd(6)} ${check.id}  ${check.assertion ?? ''}`.trimEnd());
    if (check.evidence) lines.push(`         evidence: ${check.evidence}`);
    if (escalated) lines.push(`         ${escalated.trim()}`);
  }
  return lines.join('\n');
}

export function printVerdicts(checks, output = defaultOutput) {
  output.log(renderVerdicts(checks));
}

/**
 * The corrections a retake will carry, shown before it is spent.
 *
 * Rendered by `core/generation/correction.mjs`, not by this module, so what the
 * operator reads is the same text the generator is given — a summary written
 * here would be a second version of the correction that could disagree with the
 * one that was actually sent.
 */
export function printCorrections(corrections, { attempt }, output = defaultOutput) {
  const block = renderCorrections(corrections, { attempt });
  if (block.trim() !== '') output.log(block.replace(/^\n/, ''));
}

/**
 * What `judge submit` prints when a rejected attempt leaves the run open
 * (ADR 0020 §2).
 *
 * `judge submit` never generates: it records, decides, and prints. The next
 * generation is a separate invocation the operator chooses to spend, which is
 * what keeps `--interactive` on a human's terminal from silently starting a
 * paid call. So the exact command is printed rather than run.
 */
export function renderRetakeOffer({ runId, attempt, retakesLeft, bound, corrections, runDir = null }) {
  const lines = [];
  lines.push(
    `Attempt ${attempt} was rejected. ${retakesLeft} of ${bound} attempt(s) remain, `
      + 'so the run is still open — nothing was accepted and nothing was promoted.',
  );

  const block = renderCorrections(corrections, { attempt });
  if (block.trim() !== '') {
    lines.push('');
    lines.push(block.replace(/^\n/, ''));
  }

  lines.push('');
  lines.push('Spend the next attempt when you are ready:');
  lines.push('');
  lines.push(`  pixelproof retake --run ${runId}${runDir === null ? '' : ` --run-dir ${runDir}`}`);
  lines.push('');
  lines.push('or close the run on the record without spending one:');
  lines.push('');
  lines.push(`  pixelproof judge abandon --run ${runId} --reason "<why>"`);
  return lines.join('\n');
}

export function printRetakeOffer(offer, output = defaultOutput) {
  output.log(renderRetakeOffer(offer));
}

/**
 * A refused submission, on stderr, with its named reason.
 *
 * The code is printed rather than only the prose because the codes are the
 * stable half (ADR 0014 §3) and a script that greps for one should find it in
 * the output as well as in `run.json`.
 */
export function printJudgeError(error, output = defaultOutput) {
  const code = typeof error?.code === 'string' ? `${error.code}: ` : '';
  output.error(`Judge error: ${code}${error.message}`);
}
