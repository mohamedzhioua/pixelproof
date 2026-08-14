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
 * Merge each attempt's recorded evidence into its summary row.
 *
 * ADR 0020 §7 promises that on exhaustion "the report lists every attempt with
 * its mechanical table and its verdicts so an operator can choose one by hand".
 * The run record's `attempts[]` carries only *counts* — three integers describe
 * no artifact anyone can choose between — and the rows and verdicts live in
 * `attempt-<n>.json`, which ADR 0014 §1 calls internal evidence that ships no
 * schema document. Without this merge the operator is told to choose by hand
 * from a document with nothing to choose on.
 *
 * Both additions are purely additive to `pixelproof.report/1` (ADR 0014 §3), and
 * both are `null` rather than absent when there is nothing to say, so a consumer
 * never has to distinguish "no verdicts" from "an older build".
 *
 * An attempt record that cannot be read is reported as unreadable rather than
 * omitted. Finalisation must still happen — a run that cannot reach a terminal
 * state because one evidence file is corrupt would be worse — but a silently
 * missing table would let the report imply an attempt had nothing wrong with it.
 */
function detailFor(details, number) {
  const detail = details?.[number] ?? null;
  if (detail === null || detail === undefined) return { checks: null, semantic: null };
  if (detail.unreadable) {
    return { checks: null, semantic: null, evidenceUnreadable: detail.unreadable };
  }
  return {
    checks: Array.isArray(detail.verification?.checks) ? detail.verification.checks : null,
    semantic: detail.semantic ?? null,
  };
}

/**
 * Build the `report.json` document for a run.
 *
 * Pure: `attemptDetails` is handed in by `finaliseRun`, which does the reading,
 * so the report shape stays testable against a hand-built object with no
 * directory in sight.
 *
 * @param {object} run the run record as persisted
 * @param {{schema: string, generatedAt?: string, attemptDetails?: object}} options
 */
export function buildReport(run, { schema, generatedAt = new Date().toISOString(), attemptDetails = null }) {
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
    attempts: (Array.isArray(run.attempts) ? run.attempts : [])
      .map((attempt) => ({ ...attempt, ...detailFor(attemptDetails, attempt.number) })),
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

/** A check's expected/measured value as one table cell. A pipe would break the row. */
function describeCell(value) {
  if (value === null || value === undefined) return 'unrecorded';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replaceAll('|', '\\|');
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

  // ADR 0020 §7's "choose one by hand" needs something to choose on. The table
  // above is counts; this is what each attempt actually got wrong.
  const detailed = report.attempts.filter(
    (attempt) => attempt.checks !== null || attempt.semantic !== null || attempt.evidenceUnreadable,
  );
  if (detailed.length > 0) {
    lines.push('');
    lines.push('## Every attempt, in detail');
    lines.push('');
    lines.push('Nothing is promoted on exhaustion and no attempt is ranked — scoring is unbuilt,');
    lines.push('so "best" would silently mean "last". Choose by reading what each one got wrong.');

    for (const attempt of report.attempts) {
      lines.push('');
      lines.push(`### Attempt ${attempt.number}`);
      lines.push('');
      lines.push(`- Artifact: ${attempt.artifact?.path ?? '(none)'}`);

      if (attempt.evidenceUnreadable) {
        lines.push(`- **Its evidence file could not be read:** ${attempt.evidenceUnreadable}`);
        continue;
      }

      if (Array.isArray(attempt.checks) && attempt.checks.length > 0) {
        lines.push('');
        lines.push(table([
          ['Check', 'Expected', 'Measured', 'Status'],
          ['---', '---', '---', '---'],
          ...attempt.checks.map((check) => [
            String(check.name ?? ''),
            describeCell(check.expected),
            describeCell(check.actual),
            String(check.status ?? ''),
          ]),
        ]));
      } else {
        lines.push('- No mechanical table was recorded for this attempt.');
      }

      const verdicts = Array.isArray(attempt.semantic?.checks) ? attempt.semantic.checks : [];
      if (verdicts.length > 0) {
        lines.push('');
        for (const verdict of verdicts) {
          lines.push(`- **${String(verdict.verdict ?? '?').toUpperCase()}** ${verdict.assertion ?? verdict.id ?? ''}`.trimEnd());
          lines.push(verdict.evidence
            ? `  - the judge reported: ${verdict.evidence}`
            : '  - the judge recorded no evidence for that verdict.');
        }
      } else {
        lines.push('- No semantic verdicts were recorded for this attempt. '
          + 'An unjudged assertion is unverified, never satisfied.');
      }
    }
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
