/**
 * Human presentation of a verification result.
 *
 * The wording, the row labels, the `Note:`/`Warning:` prefixes, the summary
 * sentence and — critically — the *channel* each line goes to are frozen public
 * surface (ADR 0003). Warnings go to stderr and everything else to stdout, so a
 * `--json`-free run can still be piped without a warning contaminating the
 * output; the compatibility tests assert both streams byte for byte.
 *
 * The table is rendered by `console.table` rather than a hand-built grid. That
 * is not laziness: `console.table`'s box drawing is what v1 shipped, and any
 * re-implementation would differ in some column or padding case. Keeping the
 * built-in is the only way to stay byte-identical.
 *
 * Every function takes the console-like sink as a parameter so a test can
 * capture the output, but the default is the real global console — the same
 * object the legacy scripts used, which is what makes the default path
 * identical rather than merely similar.
 */

/** The console-like sink the CLI writes to. */
const defaultOutput = globalThis.console;

/**
 * Checks carry expected/actual values that may be strings, numbers or objects.
 * v1 printed strings bare and JSON-encoded everything else; a check that
 * reported `"1:1"` must not start printing `1:1` with quotes, and an object must
 * not print as `[object Object]`.
 */
export function displayValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The `Warning: ` convention, shared by verification and generation. */
export function printWarning(message, output = defaultOutput) {
  output.warn(`Warning: ${message}`);
}

/** The headline suffix that makes skipped checks impossible to overlook. */
export function skippedSuffix(result) {
  return result.skipped > 0 ? ` (${result.skipped} checks SKIPPED - not verified)` : '';
}

/** The rows handed to `console.table`, in declaration order. */
export function verificationRows(result) {
  return result.checks.map((check) => ({
    Check: check.name,
    Expected: displayValue(check.expected),
    Actual: displayValue(check.actual),
    Result: check.status,
  }));
}

export function printVerificationResult(result, output = defaultOutput) {
  output.log(`Mechanical verification: ${result.ok ? 'PASS' : 'FAIL'}${skippedSuffix(result)}`);
  output.log(`File: ${result.file}`);
  output.log(`Decoder: ${result.decoder}`);

  if (result.checks.length > 0) {
    output.table(verificationRows(result));
  }

  for (const note of result.notes) {
    output.log(`Note: ${note}`);
  }
  for (const warning of result.warnings) {
    printWarning(warning, output);
  }
  output.log(
    `Summary: ${result.summary.passed} passed, ${result.summary.failed} failed, `
      + `${result.summary.skipped} skipped`,
  );
}

/** The machine-readable rendering: two-space indented JSON on stdout. */
export function printVerificationJson(result, output = defaultOutput) {
  output.log(JSON.stringify(result, null, 2));
}
