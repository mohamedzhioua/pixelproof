/**
 * The `verify` command handler.
 *
 * This is the body of what `scripts/verify.mjs` used to run inline: parse,
 * compose the core verification, present the result, decide the exit code. It
 * lives here so the legacy script and `pixelproof verify` are the *same* code
 * rather than two implementations that agree today.
 *
 * Two rules the handler obeys:
 *
 * - it never calls `process.exit` and never writes `process.exitCode`; it
 *   returns the code and lets the entry point apply it, so a caller can run it
 *   in-process without the run deciding the process's fate;
 * - it prints exactly what v1 printed, on the same stream (ADR 0003). The
 *   banners still say `node scripts/verify.mjs` on purpose — `pixelproof
 *   verify` is a synonym for the legacy script, not a new dialect.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { inspectImage } from '../../../core/verification/inspect.mjs';
import {
  assertMechanicalBlock,
  runMechanicalChecks,
} from '../../../core/verification/mechanical.mjs';
import { buildResult } from '../../../core/verification/result.mjs';
import { VERIFY_USAGE, parseVerifyArguments } from '../parse.mjs';
import {
  printMissingOption,
  printUsage,
  printUsageError,
  printVerificationError,
} from '../format-errors.mjs';
import {
  printVerificationJson,
  printVerificationResult,
} from '../format-verification.mjs';
import { completeJudgedRun, openJudgedRun, resolveJudgeOptions } from '../judged-run.mjs';

/**
 * `loadDecoder` exists so a caller can exercise the degraded path without
 * uninstalling `sharp`. It is not a CLI flag and is not part of the public
 * surface — the CLI always uses the real probe.
 *
 * This moved here from `scripts/verify.mjs`, which re-exports it: it is the
 * composition the verify command performs, and leaving it in the legacy script
 * would have made this module import the shim it is supposed to back.
 */
export async function verifyImage({
  filePath,
  spec = {},
  specPath = null,
  strict = false,
  loadDecoder = undefined,
} = {}) {
  const resolvedFile = path.resolve(filePath);
  await access(resolvedFile);

  const mechanical = assertMechanicalBlock(spec.mechanical ?? {});
  const { inspection, sharp, warnings, decoder, degraded } = await inspectImage(
    resolvedFile,
    loadDecoder === undefined ? {} : { loadDecoder },
  );
  const { checks, notes } = await runMechanicalChecks({
    mechanical,
    inspection,
    sharp,
    filePath: resolvedFile,
  });

  return buildResult({
    file: resolvedFile,
    spec: specPath ? path.resolve(specPath) : null,
    decoder,
    degraded,
    checks,
    strict,
    warnings,
    notes,
  });
}

/** Run the verifier over `argv` (already stripped of node and the entry point). */
export async function runVerify(argv) {
  let options;
  try {
    options = parseVerifyArguments(argv);
  } catch (error) {
    printUsageError(error.message, VERIFY_USAGE);
    return 1;
  }

  if (options.help) {
    printUsage(VERIFY_USAGE);
    return 0;
  }
  if (!options.file) {
    printMissingOption('--file', VERIFY_USAGE);
    return 1;
  }

  try {
    let spec = {};
    if (options.spec) {
      spec = JSON.parse(await readFile(path.resolve(options.spec), 'utf8'));
    }

    // Validated before the image is opened, so a target the host cannot judge
    // fails on the flag rather than after the work.
    //
    // `retakes: false` — `verify` inspects an image somebody else made, so there
    // is no provider call to repeat. It neither honours `spec.retakes` nor
    // validates it: rejecting a spec field this command cannot act on would make
    // a spec that verified under v0.3.0 start failing (ADR 0020 §6).
    const judged = resolveJudgeOptions(options, { artifact: options.file, spec, retakes: false });

    const result = await verifyImage({
      filePath: options.file,
      spec,
      specPath: options.spec ?? null,
      strict: options.strict,
    });
    if (options.json) {
      printVerificationJson(result);
    } else {
      printVerificationResult(result);
    }

    if (judged === null) return result.ok ? 0 : 1;

    // `verify` has no `--out`, so there is nothing to promote on acceptance;
    // the run directory holds the copy the host was asked about.
    const opened = await openJudgedRun({
      command: 'verify',
      runDir: options.runDir ?? null,
      specPath: options.spec ?? null,
      strict: options.strict,
      judge: judged.judge,
    });

    return completeJudgedRun(opened.directory, {
      run: opened.run,
      artifactPath: options.file,
      copy: true,
      verification: result,
      spec,
      specPath: options.spec ?? null,
      assertions: judged.assertions,
      deadlineMs: judged.deadlineMs,
    });
  } catch (error) {
    printVerificationError(error, { json: options.json, strict: options.strict });
    return 1;
  }
}

export default runVerify;
