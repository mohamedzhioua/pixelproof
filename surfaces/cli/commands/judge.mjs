/**
 * `pixelproof judge` — the second half of the host handoff (ADR 0009).
 *
 * The first invocation (`generate`/`verify --judge host`) writes a checklist and
 * exits 2. This command is everything that happens afterwards: list what is
 * outstanding, print a checklist, record verdicts, or close a run on the record.
 *
 * Two structural notes.
 *
 * **The sub-verb is peeled before flag parsing.** `parseArguments` throws
 * `Unknown argument: submit` on a bare word, by design — it is a strict parser
 * and softening it would weaken every command that relies on it. So the verb is
 * removed from argv here and only flags reach the parser, exactly as ADR 0009's
 * Consequences requires.
 *
 * **The handler is thin over `core/judge/`.** Every decision — which refusals
 * exist, what replaces what on escalation, when a run may be accepted — lives in
 * core. This file parses, calls, prints, and returns an exit code. That split is
 * what lets a later MCP or library caller reach acceptance through the same code
 * rather than through a second implementation that agrees today.
 *
 * ## Exit codes
 *
 * - `0` — accepted.
 * - `1` — rejected, refused, or errored.
 * - `2` — an outstanding judgement: `pending` found open runs, or `submit`
 *   issued an escalation round. Never a pass.
 *
 * `abandon` exits 1 because the run it closed is rejected. Closing a run is not
 * the same as passing one, and a gate that treats non-zero as failure is right.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AdapterError } from '../../../core/contracts/errors.mjs';
import { VERDICTS } from '../../../core/contracts/judge.mjs';
import {
  applySubmission,
  closePendingRun,
  describeRemaining,
  hasExpired,
  listPendingRuns,
  parseSubmission,
  PendingError,
  pendingRequestFile,
  pendingRequestFor,
  promoteArtifact,
  selectPendingRun,
  verifySubmission,
} from '../../../core/judge/index.mjs';
import { recordRunFields } from '../../../core/run/index.mjs';
import { parseArguments } from '../parse.mjs';
import { printUsage, printUsageError } from '../format-errors.mjs';
import {
  printChecklist,
  printJudgeError,
  printVerdicts,
  renderPendingList,
} from '../format-judge.mjs';
import { readVersion } from '../version.mjs';

const defaultOutput = globalThis.console;

export const JUDGE_USAGE = `pixelproof host judgement

Usage:
  pixelproof judge pending [--json] [--run-dir <path>]
  pixelproof judge show    --run <id> [--request] [--run-dir <path>]
  pixelproof judge submit  [--run <id>] [--results <path>|-] [--interactive] [--run-dir <path>]
  pixelproof judge abandon [--run <id>] --reason "<why>" [--run-dir <path>]

Options:
  --run <id>          The pending run. May be omitted only when exactly one is open.
  --results <path>    Verdicts as JSON; "-" reads standard input.
  --interactive       Prompt for each check. Refuses when stdin is not a terminal.
  --request           Print the bare protocol-1 judge request instead of the checklist.
  --reason <text>     Why the run is being closed without a verdict. Required.
  --run-dir <path>    Run root; also PIXELPROOF_RUN_ROOT (default .pixelproof/runs)
  --json              Machine-readable output (pending only)
  -h, --help          Show this help

Exit codes: 0 accepted, 1 rejected or refused, 2 an outstanding judgement.
Exit 2 is never a pass.
`;

const COMMON_FLAGS = [['-h', 'help'], ['--help', 'help']];
const COMMON_VALUED = ['--run', '--run-dir'];

const PENDING_FLAGS = new Map([...COMMON_FLAGS, ['--json', 'json']]);
const PENDING_VALUED = new Set(['--run-dir']);

const SHOW_FLAGS = new Map([...COMMON_FLAGS, ['--request', 'request']]);
const SHOW_VALUED = new Set(COMMON_VALUED);

const SUBMIT_FLAGS = new Map([...COMMON_FLAGS, ['--interactive', 'interactive']]);
const SUBMIT_VALUED = new Set([...COMMON_VALUED, '--results']);

const ABANDON_FLAGS = new Map(COMMON_FLAGS);
const ABANDON_VALUED = new Set([...COMMON_VALUED, '--reason']);

/** `--run-dir` becomes `runDir`; every other flag here is already one word. */
function parse(argv, flags, valued, defaults) {
  return parseArguments(argv, { flags, valued, defaults, camelCase: true });
}

/**
 * Record a named refusal on the run it was refused for (ADR 0009 §3).
 *
 * Best-effort on purpose. A refusal that cannot be written down — because the
 * run is already closed, or the disk is read-only — must still be reported to
 * the caller; swallowing the real reason to surface a bookkeeping failure would
 * tell the operator about the wrong problem.
 */
async function recordRefusal(directory, error) {
  if (directory === null) return;
  try {
    await recordRunFields(directory, { reason: { code: error.code, message: error.message } });
  } catch {
    // Deliberately ignored; see above.
  }
}

async function readSubmissionSource(source) {
  if (source === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(path.resolve(source), 'utf8');
}

/**
 * Prompt for each check on a TTY.
 *
 * **Refuses when stdin is not a terminal** (ADR 0009 §6). A prompt reading EOF
 * in a pipeline would either hang the job or, worse, take an empty line as an
 * answer — and an empty answer that became a verdict is precisely the silent
 * pass this project exists to prevent.
 */
async function promptForVerdicts(record, output) {
  if (!process.stdin.isTTY) {
    throw new Error(
      '--interactive needs a terminal; stdin is not a TTY. '
        + 'Use --results <path> or --results - in a pipeline.',
    );
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const results = [];

  try {
    output.log(`Judging ${record.request.checks.length} assertion(s) for run ${record.runId}.`);
    output.log(`Open ${record.artifact.path} in the run directory before answering.`);
    output.log('');

    for (const check of record.request.checks) {
      output.log(`${check.id}  ${check.assertion}`);
      let verdict = '';
      while (!VERDICTS.includes(verdict)) {
        verdict = (await rl.question(`  verdict [${VERDICTS.join('/')}]: `)).trim().toLowerCase();
        if (!VERDICTS.includes(verdict)) {
          output.log(`  answer one of: ${VERDICTS.join(', ')}`);
        }
      }
      const evidence = (await rl.question('  evidence (one line): ')).trim();
      results.push({ id: check.id, verdict, evidence: evidence === '' ? null : evidence });
      output.log('');
    }
  } finally {
    rl.close();
  }

  return {
    runId: record.runId,
    nonce: record.nonce,
    checksDigest: record.checksDigest,
    response: { protocol: record.protocol, ok: true, judge: 'host', results },
  };
}

/** `pixelproof judge pending` */
async function judgePending(argv, output) {
  const options = parse(argv, PENDING_FLAGS, PENDING_VALUED, { json: false, help: false });
  if (options.help) {
    printUsage(JUDGE_USAGE, output);
    return 0;
  }

  const now = new Date();
  const entries = await listPendingRuns({ runDir: options.runDir ?? null });

  if (options.json) {
    output.log(JSON.stringify({
      count: entries.length,
      pending: entries.map((entry) => ({
        runId: entry.runId,
        directory: entry.directory,
        round: entry.record?.round ?? entry.round?.round ?? null,
        checks: entry.record?.request.checks.length ?? null,
        issuedAt: entry.record?.issuedAt ?? null,
        expiresAt: entry.record?.expiresAt ?? null,
        expired: entry.record ? hasExpired(entry.record.expiresAt, now) : null,
        error: entry.error,
      })),
    }, null, 2));
  } else {
    output.log(renderPendingList(entries, { describeRemaining, hasExpired, now }));
  }

  // Exit 2 whenever anything is outstanding, so this works as a pre-commit or
  // CI guard without the caller having to parse the listing.
  return entries.length > 0 ? 2 : 0;
}

/** `pixelproof judge show` */
async function judgeShow(argv, output) {
  const options = parse(argv, SHOW_FLAGS, SHOW_VALUED, { request: false, help: false });
  if (options.help) {
    printUsage(JUDGE_USAGE, output);
    return 0;
  }

  const opened = await selectPendingRun({ runId: options.run ?? null, runDir: options.runDir ?? null });

  if (options.request) {
    output.log(JSON.stringify(pendingRequestFor(opened.record, opened.directory), null, 2));
    return 0;
  }

  printChecklist(opened.record, {
    artifact: path.resolve(opened.directory, opened.record.artifact.path),
    requestFile: path.join(opened.directory, pendingRequestFile(opened.record.round)),
    remaining: hasExpired(opened.record.expiresAt) ? 'EXPIRED' : `in ${describeRemaining(opened.record.expiresAt)}`,
    out: opened.run.resolved?.out ?? null,
  }, output);

  return 0;
}

/** `pixelproof judge submit` */
async function judgeSubmit(argv, output) {
  const options = parse(argv, SUBMIT_FLAGS, SUBMIT_VALUED, { interactive: false, help: false });
  if (options.help) {
    printUsage(JUDGE_USAGE, output);
    return 0;
  }
  if (options.interactive && options.results) {
    printUsageError('--interactive and --results name two different sources of verdicts; choose one', JUDGE_USAGE, output);
    return 1;
  }
  if (!options.interactive && !options.results) {
    printUsageError('judge submit needs --results <path>, --results - or --interactive', JUDGE_USAGE, output);
    return 1;
  }

  const opened = await selectPendingRun({ runId: options.run ?? null, runDir: options.runDir ?? null });

  const raw = options.interactive
    ? await promptForVerdicts(opened.record, output)
    : JSON.parse(await readSubmissionSource(options.results));

  const submission = parseSubmission(raw);

  let response;
  try {
    ({ response } = await verifySubmission({
      record: opened.record,
      round: opened.round,
      submission,
      directory: opened.directory,
    }));
  } catch (error) {
    if (error instanceof PendingError) {
      await recordRefusal(opened.directory, error);
      // Expiry is the one refusal that also ends the run: an unanswered
      // checklist is never a pass, so it is closed as rejected with a report
      // rather than left open forever (ADR 0009 §4).
      if (error.code === 'PENDING_EXPIRED') {
        await closePendingRun(opened.directory, { message: error.message });
        printJudgeError(error, output);
        output.error(`Run ${opened.runId} is now rejected; the candidate is still on disk in ${opened.directory}.`);
        return 1;
      }
      printJudgeError(error, output);
      output.error(`Run ${opened.runId} is still open; correct the submission and try again.`);
      return 1;
    }
    if (error instanceof AdapterError) {
      // A malformed reply is a judge protocol violation, not a verdict. No
      // verdicts were recorded, so the run stays open and can be answered again.
      printJudgeError(error, output);
      output.error(`Run ${opened.runId} is still open; no verdicts were recorded.`);
      return 1;
    }
    throw error;
  }

  const attempt = opened.run.judge?.attempt ?? 1;
  const applied = await applySubmission(opened.directory, {
    run: opened.run,
    round: opened.round,
    record: opened.record,
    response,
    attempt,
    pixelproofVersion: await readVersion(),
  });

  if (applied.outcome === 'escalated') {
    printVerdicts(applied.checks, output);
    output.log('');
    printChecklist(applied.record, {
      artifact: path.resolve(opened.directory, applied.record.artifact.path),
      requestFile: path.join(opened.directory, pendingRequestFile(applied.record.round)),
      remaining: `in ${describeRemaining(applied.record.expiresAt)}`,
      out: opened.run.resolved?.out ?? null,
    }, output);
    return 2;
  }

  printVerdicts(applied.checks, output);
  output.log('');

  if (applied.outcome !== 'accepted') {
    output.log(`Rejected: ${applied.reason}. The candidate is still on disk in ${opened.directory}.`);
    return 1;
  }

  // The judgement is accepted either way; delivery is a separate fact. A failed
  // copy exits non-zero because the caller asked for a file at --out and does
  // not have one, and says where the accepted artifact actually is.
  try {
    const promoted = await promoteArtifact(opened.directory, { run: applied.run, attempt });
    output.log(`Accepted: ${applied.reason}.`);
    if (promoted) output.log(`Promoted to ${promoted}`);
    else output.log(`The accepted artifact is in ${opened.directory}.`);
    return 0;
  } catch (error) {
    output.error(`Accepted, but promoting the artifact failed: ${error.message}`);
    output.error(`The accepted artifact is in ${opened.directory}.`);
    return 1;
  }
}

/** `pixelproof judge abandon` */
async function judgeAbandon(argv, output) {
  const options = parse(argv, ABANDON_FLAGS, ABANDON_VALUED, { help: false });
  if (options.help) {
    printUsage(JUDGE_USAGE, output);
    return 0;
  }
  if (!options.reason || options.reason.trim() === '') {
    printUsageError('--reason is required: closing a run without a verdict goes on the record', JUDGE_USAGE, output);
    return 1;
  }

  const opened = await selectPendingRun({ runId: options.run ?? null, runDir: options.runDir ?? null });
  await closePendingRun(opened.directory, { message: options.reason });

  output.log(`Run ${opened.runId} closed as rejected: ${options.reason}`);
  output.log(`Nothing was accepted. The candidate and its report are in ${opened.directory}.`);
  return 1;
}

const SUB_VERBS = new Map([
  ['pending', judgePending],
  ['show', judgeShow],
  ['submit', judgeSubmit],
  ['abandon', judgeAbandon],
]);

export function subVerbNames() {
  return [...SUB_VERBS.keys()];
}

/** Run the judge command over `argv` (already stripped of node and `judge`). */
export async function runJudge(argv = [], { output = defaultOutput } = {}) {
  const [verb, ...rest] = argv;

  if (verb === undefined) {
    printUsageError('a judge sub-command is required', JUDGE_USAGE, output);
    return 1;
  }
  if (verb === '-h' || verb === '--help' || verb === 'help') {
    printUsage(JUDGE_USAGE, output);
    return 0;
  }

  const handler = SUB_VERBS.get(verb);
  if (!handler) {
    printUsageError(
      `Unknown judge sub-command: ${verb}. Available: ${subVerbNames().join(', ')}`,
      JUDGE_USAGE,
      output,
    );
    return 1;
  }

  try {
    return await handler(rest, output);
  } catch (error) {
    if (error instanceof PendingError || error instanceof AdapterError) {
      printJudgeError(error, output);
      return 1;
    }
    if (error instanceof SyntaxError) {
      printJudgeError(new Error(`the submitted verdicts are not valid JSON: ${error.message}`), output);
      return 1;
    }
    printUsageError(error.message, JUDGE_USAGE, output);
    return 1;
  }
}

export default runJudge;
