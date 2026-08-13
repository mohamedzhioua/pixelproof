/**
 * Verification result shape and strictness policy.
 *
 * A check has three outcomes, and the counting keeps them separate on purpose.
 * A skipped check is not a passed one: reporting "PASS" while a check never ran
 * is the silent-wrong-result failure this project exists to prevent, so the
 * skipped count is carried all the way out to the caller and to the exit code.
 */

export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const SKIP = 'SKIP';

export function addCheck(checks, name, expected, actual, passed) {
  checks.push({ name, expected, actual, passed, status: passed ? PASS : FAIL });
  return checks;
}

export function addSkippedCheck(checks, name, expected, reason) {
  checks.push({ name, expected, actual: reason, passed: null, status: SKIP });
  return checks;
}

export function countChecks(checks) {
  const failed = checks.filter((check) => check.passed === false).length;
  const skipped = checks.filter((check) => check.passed === null).length;
  return { passed: checks.length - failed - skipped, failed, skipped };
}

/**
 * Under `strict`, a skipped check fails the run. The default keeps v1's exit
 * semantics — skips do not change an otherwise successful exit — but the counts
 * make the skips legible either way.
 */
export function isOk({ failed, skipped }, strict) {
  return failed === 0 && (!strict || skipped === 0);
}

export function buildResult({
  file,
  spec = null,
  decoder,
  degraded,
  checks,
  strict = false,
  warnings = [],
  notes = [],
}) {
  const counts = countChecks(checks);
  return {
    file,
    spec,
    decoder,
    degraded,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    strict,
    ok: isOk(counts, strict),
    checks,
    summary: { ...counts },
    warnings,
    notes,
  };
}
