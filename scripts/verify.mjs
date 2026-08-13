#!/usr/bin/env node

/**
 * Legacy entry point for the mechanical verifier.
 *
 * The checking logic now lives in `core/verification/` and the presentation in
 * `surfaces/cli/`; what remains here is the composition and the exit policy.
 * Flags, output text and exit codes are frozen public surface (ADR 0003), so
 * this file still behaves exactly as v1 shipped it.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { inspectImage } from '../core/verification/inspect.mjs';
import { assertMechanicalBlock, runMechanicalChecks } from '../core/verification/mechanical.mjs';
import { buildResult } from '../core/verification/result.mjs';
import { VERIFY_USAGE, parseVerifyArguments } from '../surfaces/cli/parse.mjs';
import {
  printMissingOption,
  printUsage,
  printUsageError,
  printVerificationError,
} from '../surfaces/cli/format-errors.mjs';
import {
  printVerificationJson,
  printVerificationResult,
} from '../surfaces/cli/format-verification.mjs';

/**
 * `loadDecoder` exists so a caller can exercise the degraded path without
 * uninstalling `sharp`. It is not a CLI flag and is not part of the public
 * surface — the CLI always uses the real probe.
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

/**
 * Re-exported so the generator — and anything else that grew to depend on the
 * legacy entry point — keeps importing it from here while the implementation
 * lives in the CLI surface.
 */
export { printVerificationResult };

async function main() {
  let options;
  try {
    options = parseVerifyArguments(process.argv.slice(2));
  } catch (error) {
    printUsageError(error.message, VERIFY_USAGE);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage(VERIFY_USAGE);
    return;
  }
  if (!options.file) {
    printMissingOption('--file', VERIFY_USAGE);
    process.exitCode = 1;
    return;
  }

  try {
    let spec = {};
    if (options.spec) {
      spec = JSON.parse(await readFile(path.resolve(options.spec), 'utf8'));
    }
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
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    printVerificationError(error, { json: options.json, strict: options.strict });
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
