/**
 * The host judge handoff (ADR 0009).
 *
 * The public face of `core/judge/`. A surface imports from here rather than
 * from the individual modules, so the split between errors, digests,
 * deadlines, the envelope, the submission checks and the handoff itself stays
 * an implementation detail.
 *
 * What this layer is *not*: it is not a judge adapter. ADR 0004 classifies the
 * host as neither a trusted in-process module nor an untrusted subprocess but a
 * third thing — a **caller**. Nothing here spawns anything, reads an image, or
 * forms an opinion about one. It writes down what was asked, proves who is
 * answering, and records what they said.
 */

export { PENDING_REASONS, PendingError, asPendingError, isPendingReason } from './errors.mjs';

export {
  NONCE_PATTERN,
  canonicalJson,
  checksDigestFor,
  isNonce,
  newNonce,
  nonceMatches,
  sha256OfFile,
  sha256OfString,
  specDigestFor,
} from './digest.mjs';

export {
  DEADLINE_PATTERN,
  DEFAULT_DEADLINE_MS,
  MAX_DEADLINE_MS,
  describeRemaining,
  expiryFrom,
  hasExpired,
  parseDeadline,
} from './deadline.mjs';

export {
  HOST_JUDGE,
  JUDGE_PENDING_SCHEMA,
  JUDGE_RESULT_SCHEMA,
  MAX_ROUNDS,
  assertPendingSchema,
  buildPendingRecord,
  buildResultRecord,
  pendingRequestFile,
  pendingRequestFor,
  pendingResultFile,
  readPendingRecord,
  writePendingRecord,
  writeResultRecord,
} from './pending.mjs';

export {
  OUTCOME_REASONS,
  decideOutcome,
  foldVerdicts,
  lastRoundOf,
  listPendingRuns,
  listStalledRuns,
  openPendingRun,
  openRoundOf,
  parseSubmission,
  roundInAttempt,
  selectClosableRun,
  selectPendingRun,
  verifySubmission,
} from './submit.mjs';

export {
  DEFAULT_RETAKES,
  assertRetakeable,
  attemptsOf,
  boundOf,
  hasRetakeLeft,
  nextAttemptNumber,
  openRetakeableRun,
  resolveRetakeBound,
  retakesLeft,
} from './retake.mjs';

export {
  DEFAULT_POLICY,
  applySubmission,
  closePendingRun,
  issueEscalationRound,
  issueFirstRound,
  promoteArtifact,
} from './handoff.mjs';
