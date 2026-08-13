/**
 * Error presentation and the JSON error shape.
 *
 * Three rules are frozen public surface (ADR 0003) and are the reason this is a
 * module rather than a handful of inline template literals:
 *
 * 1. A usage error prints `Error: <message>`, a blank line, then the whole
 *    banner — on stderr, with exit code 1. `--help` prints the same banner on
 *    stdout with exit code 0.
 * 2. A run-time failure prints `Verification error: <message>` or
 *    `Generation error: <message>` on stderr.
 * 3. Under `--json` the verifier reports the failure *on stdout* as a result
 *    object with `ok: false` and leaves stderr empty, so a consumer parsing
 *    stdout gets a parseable answer instead of an empty document. The field
 *    order below is the order v1 emitted.
 */

const defaultOutput = globalThis.console;

/** `Error: <message>` followed by a blank line and the banner. */
export function usageErrorText(message, usage) {
  return `Error: ${message}\n\n${usage}`;
}

export function printUsageError(message, usage, output = defaultOutput) {
  output.error(usageErrorText(message, usage));
}

/** The banner itself, on stdout, for `-h`/`--help`. */
export function printUsage(usage, output = defaultOutput) {
  output.log(usage);
}

/** `--file is required` / `--out is required`, presented as a usage error. */
export function printMissingOption(option, usage, output = defaultOutput) {
  printUsageError(`${option} is required`, usage, output);
}

/**
 * The `--json` failure document. It is deliberately *not* the full result
 * shape: no verification ran, so claiming fields such as `checks` or `decoder`
 * would be inventing a result. One synthetic failed check plus the message is
 * the honest report.
 */
export function verificationErrorResult(error, { strict = false } = {}) {
  return {
    passed: 0,
    failed: 1,
    skipped: 0,
    strict,
    ok: false,
    error: error.message,
  };
}

export function printVerificationError(error, { json = false, strict = false } = {}, output = defaultOutput) {
  if (json) {
    output.log(JSON.stringify(verificationErrorResult(error, { strict }), null, 2));
  } else {
    output.error(`Verification error: ${error.message}`);
  }
}

export function printGenerationError(error, output = defaultOutput) {
  output.error(`Generation error: ${error.message}`);
}
