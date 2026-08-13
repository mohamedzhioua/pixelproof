/**
 * Run directories and persisted evidence (ADR 0009 §2, ADR 0014).
 *
 * The public face of `core/run/`. A surface should import from here rather than
 * from the individual modules, so the split between id, state, root, envelope,
 * report and store stays an implementation detail.
 *
 * This layer deliberately stops short of ADR 0009's judge handoff: it provides
 * the `pending-judgement` state and the directory the pending record will live
 * in, and it implements no `judge` command, no submission, and no nonce.
 */

export { RUN_ERROR_CODES, RunError, isRunErrorCode } from './errors.mjs';

export { RUN_ID_PATTERN, assertRunId, isRunId, newRunId, runIdTimestamp } from './id.mjs';

export {
  ABANDONED,
  ACCEPTED,
  INITIAL_STATE,
  PENDING_JUDGEMENT,
  REJECTED,
  RUNNING,
  RUN_STATES,
  TERMINAL_STATES,
  acceptedFor,
  allowedTransitions,
  assertOpen,
  assertTransition,
  canTransition,
  isRunState,
  isTerminalState,
} from './state.mjs';

export {
  DEFAULT_RUN_ROOT,
  RUN_ROOT_ENV,
  assertRunDirectory,
  containsPath,
  describeRunRoot,
  resolveRunDirectory,
  resolveRunRoot,
} from './root.mjs';

export {
  ATTEMPT_SCHEMA,
  REPORT_SCHEMA,
  RUN_SCHEMA,
  SUPPORTED_SCHEMAS,
  assertSchema,
  isSupportedSchema,
  parseSchema,
} from './envelope.mjs';

export { buildReport, decisiveAttempt, renderReportMarkdown, summariseRun } from './report.mjs';

export {
  REPORT_JSON_FILE,
  REPORT_MARKDOWN_FILE,
  RUN_FILE,
  attemptStem,
  createRun,
  finaliseRun,
  listOpenRuns,
  listRuns,
  readReport,
  readRun,
  recordAttempt,
  recordAttemptSemantic,
  recordRunFields,
  runFilePath,
  serialiseJson,
  transitionRun,
  writeAtomic,
} from './store.mjs';
