/**
 * Finalisation reports (ADR 0014 §2, §3).
 *
 * Two artifacts, two audiences, two contracts:
 *
 * - `report.json` is for CI. Its listed fields are guaranteed for the life of
 *   `pixelproof.report/1`.
 * - `report.md` is for a person. It carries no `schema` field precisely so that
 *   nothing is tempted to parse it, and it may be rewritten freely.
 *
 * Both are derived from `run.json` and nothing else: a report that could say
 * something the run record does not would be a second truth, which is the thing
 * ADR 0009 §2 refused an index file over.
 *
 * This module is pure. It touches no filesystem, so the report shape can be
 * tested against a hand-built run object with no directory in sight.
 */

const EMPTY_SUMMARY = Object.freeze({ attempts: 0, passed: 0, failed: 0, skipped: 0 });

/**
 * The attempt a report is *about*: the accepted one when the run names one,
 * otherwise the last recorded. Counts are never summed across attempts — the
 * total failures of four attempts describe no artifact that exists.
 */
export function decisiveAttempt(run) {
  const attempts = Array.isArray(run?.attempts) ? run.attempts : [];
  if (attempts.length === 0) return null;

  const accepted = run?.outcome?.acceptedAttempt;
  if (Number.isInteger(accepted)) {
    const match = attempts.find((attempt) => attempt.number === accepted);
    if (match) return match;
  }

  return attempts[attempts.length - 1];
}

export function summariseRun(run) {
  const attempts = Array.isArray(run?.attempts) ? run.attempts : [];
  const decisive = decisiveAttempt(run);
  if (decisive === null) return { ...EMPTY_SUMMARY, attempts: attempts.length };

  const verification = decisive.verification ?? {};
  return {
    attempts: attempts.length,
    passed: verification.passed ?? 0,
    failed: verification.failed ?? 0,
    skipped: verification.skipped ?? 0,
  };
}

/**
 * Build the `report.json` document for a run.
 *
 * @param {object} run the run record as persisted
 * @param {{schema: string, generatedAt?: string}} options
 */
export function buildReport(run, { schema, generatedAt = new Date().toISOString() }) {
  if (run === null || typeof run !== 'object') {
    throw new TypeError('buildReport requires a run record');
  }
  if (typeof schema !== 'string' || schema === '') {
    throw new TypeError('buildReport requires the report schema identifier');
  }

  const decisive = decisiveAttempt(run);

  return {
    schema,
    runId: run.runId,
    generatedAt,
    pixelproofVersion: run.pixelproofVersion ?? null,
    command: run.command ?? null,
    state: run.state,
    accepted: run.accepted,
    outcome: run.outcome ?? null,
    resolved: run.resolved ?? {},
    summary: summariseRun(run),
    decisiveAttempt: decisive === null ? null : decisive.number,
    attempts: Array.isArray(run.attempts) ? run.attempts : [],
    reasons: Array.isArray(run.reasons) ? run.reasons : [],
    notes: Array.isArray(run.notes) ? run.notes : [],
    files: {
      run: 'run.json',
      report: 'report.json',
      narrative: 'report.md',
    },
  };
}

/** One line explaining, in English, how the run ended. */
function outcomeSentence(report) {
  const reason = report.outcome?.reason ?? null;
  const tail = reason === null ? '' : ` — ${reason}`;

  switch (report.state) {
    case 'accepted':
      return `Accepted${report.decisiveAttempt === null ? '' : ` on attempt ${report.decisiveAttempt}`}${tail}.`;
    case 'rejected':
      return `Rejected${tail}. A rejected candidate is still on disk in this directory.`;
    case 'abandoned':
      return `Abandoned${tail}. Nothing was accepted, and an unanswered run is never a pass.`;
    default:
      return `Still ${report.state}${tail}.`;
  }
}

function table(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

/**
 * Render the human narrative. Deliberately unversioned prose (ADR 0014 §3);
 * every fact in it comes from the report document, so the two cannot drift.
 */
export function renderReportMarkdown(report) {
  const lines = [];

  lines.push(`# Pixelproof run ${report.runId}`);
  lines.push('');
  lines.push(outcomeSentence(report));
  lines.push('');
  lines.push(`- **State:** ${report.state}`);
  lines.push(`- **Accepted:** ${report.accepted === null ? 'undecided' : String(report.accepted)}`);
  lines.push(`- **Command:** ${report.command ?? 'unrecorded'}`);
  lines.push(`- **Pixelproof:** ${report.pixelproofVersion ?? 'unrecorded'}`);
  lines.push(`- **Finalised:** ${report.outcome?.finalisedAt ?? 'not final'}`);
  lines.push(`- **Attempts:** ${report.summary.attempts}`);
  lines.push('');
  lines.push('## Checks on the decisive attempt');
  lines.push('');

  if (report.decisiveAttempt === null) {
    lines.push('No attempt was recorded, so no artifact was checked.');
  } else {
    lines.push(
      `Attempt ${report.decisiveAttempt}: ${report.summary.passed} passed, `
      + `${report.summary.failed} failed, ${report.summary.skipped} skipped. `
      + 'A skipped check is not a passed one.',
    );
    lines.push('');
    lines.push(table([
      ['Attempt', 'Artifact', 'Passed', 'Failed', 'Skipped', 'Verdict'],
      ['---', '---', '---', '---', '---', '---'],
      ...report.attempts.map((attempt) => {
        const verification = attempt.verification ?? {};
        return [
          String(attempt.number),
          attempt.artifact?.path ?? '(none)',
          String(verification.passed ?? 0),
          String(verification.failed ?? 0),
          String(verification.skipped ?? 0),
          verification.ok === true ? 'ok' : verification.ok === false ? 'not ok' : 'unrecorded',
        ];
      }),
    ]));
  }

  if (report.reasons.length > 0) {
    lines.push('');
    lines.push('## Recorded reasons');
    lines.push('');
    for (const reason of report.reasons) {
      lines.push(`- \`${reason.code}\` ${reason.message ?? ''}`.trimEnd());
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('This narrative is for people and is not a stable interface; read `report.json` from a program.');
  lines.push('');

  return lines.join('\n');
}
