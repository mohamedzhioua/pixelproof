#!/usr/bin/env node

/**
 * Legacy entry point for the mechanical verifier.
 *
 * The checking logic now lives in `core/verification/`; what remains here is
 * argument parsing, presentation and exit policy. Both are frozen public surface
 * (ADR 0003), so this file keeps its flags, its output text and its exit codes
 * exactly as v1 shipped them.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { inspectImage } from '../core/verification/inspect.mjs';
import { assertMechanicalBlock, runMechanicalChecks } from '../core/verification/mechanical.mjs';
import { buildResult } from '../core/verification/result.mjs';

function usage() {
  return `pixelproof mechanical verifier

Usage:
  node scripts/verify.mjs --file <path> [--spec <spec.json>] [--json] [--strict]

Options:
  --file <path>       Image to inspect (required)
  --spec <path>       JSON spec containing a mechanical block
  --json              Print a machine-readable result object
  --strict            Treat skipped checks as failures
  -h, --help          Show this help
`;
}

function parseArgs(argv) {
  const options = { json: false, strict: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--strict') {
      options.strict = true;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else if (argument === '--file' || argument === '--spec') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

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

function displayValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function printVerificationResult(result) {
  const skippedSuffix = result.skipped > 0
    ? ` (${result.skipped} checks SKIPPED - not verified)`
    : '';
  console.log(`Mechanical verification: ${result.ok ? 'PASS' : 'FAIL'}${skippedSuffix}`);
  console.log(`File: ${result.file}`);
  console.log(`Decoder: ${result.decoder}`);

  if (result.checks.length > 0) {
    const rows = result.checks.map((check) => ({
      Check: check.name,
      Expected: displayValue(check.expected),
      Actual: displayValue(check.actual),
      Result: check.status,
    }));
    console.table(rows);
  }

  for (const note of result.notes) {
    console.log(`Note: ${note}`);
  }
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  console.log(
    `Summary: ${result.summary.passed} passed, ${result.summary.failed} failed, `
      + `${result.summary.skipped} skipped`,
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.file) {
    console.error(`Error: --file is required\n\n${usage()}`);
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
      console.log(JSON.stringify(result, null, 2));
    } else {
      printVerificationResult(result);
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({
        passed: 0,
        failed: 1,
        skipped: 0,
        strict: options.strict,
        ok: false,
        error: error.message,
      }, null, 2));
    } else {
      console.error(`Verification error: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
