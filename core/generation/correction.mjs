/**
 * The corrections block a retake prompt carries (ADR 0020 §4).
 *
 * **Core does not paraphrase, summarise, or infer a correction.** Every line
 * below is assembled from something attempt *n* actually recorded:
 *
 * - a failed mechanical check contributes its name, its expected value and its
 *   measured value — facts code owns and measured itself;
 * - a failed or unsure semantic assertion contributes the assertion verbatim and
 *   **the host's own `evidence` string verbatim**.
 *
 * Where a host returned a verdict with no evidence, the block says the assertion
 * was not satisfied and that no evidence was recorded, rather than inventing a
 * reason. A correction this module made up would be an unattributed instruction
 * to the generator — the same class of failure as a judge saying "looks good".
 *
 * This module is pure and imports nothing. It is handed the two records the run
 * directory already holds and returns text; it never reads a file, never decides
 * whether a retake should happen, and never forms an opinion about an image.
 */

/** Verdicts that did not satisfy an assertion. `unsure` is never a pass. */
const UNSATISFIED = new Set(['fail', 'unsure']);

function describeValue(value) {
  if (value === null || value === undefined) return 'unrecorded';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The failed mechanical checks of one attempt, as `{name, expected, actual}`.
 *
 * A skipped check is not a failed one and contributes nothing: telling a
 * generator to fix a check that never ran would be inventing a defect.
 */
export function mechanicalCorrections(verification) {
  const checks = Array.isArray(verification?.checks) ? verification.checks : [];
  return checks
    .filter((check) => check?.passed === false)
    .map((check) => ({
      name: String(check.name),
      expected: describeValue(check.expected),
      actual: describeValue(check.actual),
    }));
}

/**
 * The semantic assertions of one attempt that were not satisfied, each with the
 * host's own evidence.
 *
 * `evidence` is carried through untouched, including its absence: `null` here
 * means the host recorded none, and the rendered block says so.
 */
export function semanticCorrections(semantic) {
  const checks = Array.isArray(semantic?.checks) ? semantic.checks : [];
  return checks
    .filter((check) => UNSATISFIED.has(check?.verdict))
    .map((check) => ({
      id: check.id ?? null,
      assertion: typeof check.assertion === 'string' ? check.assertion : null,
      verdict: check.verdict,
      evidence: typeof check.evidence === 'string' && check.evidence.trim() !== ''
        ? check.evidence
        : null,
    }));
}

/**
 * Both halves of what attempt *n* got wrong, from its recorded evidence.
 *
 * @param {{verification?: object|null, semantic?: object|null}} attempt the
 *   `attempt-<n>.json` document, or anything with the same two fields
 */
export function correctionsFor(attempt) {
  return {
    mechanical: mechanicalCorrections(attempt?.verification ?? null),
    semantic: semanticCorrections(attempt?.semantic ?? null),
  };
}

/** Whether there is anything to say. An empty block is never appended. */
export function hasCorrections(corrections) {
  return (corrections?.mechanical?.length ?? 0) + (corrections?.semantic?.length ?? 0) > 0;
}

/**
 * Render the block that is appended to the retake prompt.
 *
 * The heading names the attempt being corrected so a generator — and a person
 * reading `run.json`'s `resolved.prompt` later — can tell which round of
 * feedback this is.
 */
export function renderCorrections(corrections, { attempt }) {
  if (!hasCorrections(corrections)) return '';

  const lines = [
    '',
    `Corrections from attempt ${attempt}, which was not accepted:`,
  ];

  for (const check of corrections.mechanical) {
    lines.push(`- Measured ${check.name}: expected ${check.expected}, got ${check.actual}.`);
  }

  for (const check of corrections.semantic) {
    const assertion = check.assertion ?? check.id ?? 'an assertion';
    const verdict = check.verdict === 'unsure' ? 'could not be confirmed' : 'was not satisfied';
    lines.push(`- "${assertion}" ${verdict}.`);
    lines.push(check.evidence === null
      ? '  The judge recorded no evidence for that verdict.'
      : `  The judge reported: ${check.evidence}`);
  }

  lines.push('Fix exactly these. Change nothing else that already satisfied the spec.');
  return lines.join('\n');
}

/**
 * Append the corrections to an already spec-folded prompt.
 *
 * The prompt for attempt *n+1* is the original prompt, the same spec folding
 * `foldSpecIntoPrompt()` performs, and then this block — in that order, so the
 * last thing the generator reads is what went wrong last time.
 */
export function foldCorrectionsIntoPrompt(prompt, corrections, { attempt }) {
  const block = renderCorrections(corrections, { attempt });
  return block === '' ? prompt : `${prompt}\n${block}`;
}
