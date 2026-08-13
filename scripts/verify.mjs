#!/usr/bin/env node

/**
 * Legacy entry point for the mechanical verifier.
 *
 * The checking logic lives in `core/verification/`, the presentation in
 * `surfaces/cli/`, and the composition and exit policy in
 * `surfaces/cli/commands/verify.mjs`. What remains here is a shim: it calls the
 * same handler `pixelproof verify` calls, in the same process — it does not
 * spawn a second Node, and it is not a fork. Flags, output text and exit codes
 * are frozen public surface (ADR 0003), so this file still behaves exactly as
 * v1 shipped it.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runVerify, verifyImage } from '../surfaces/cli/commands/verify.mjs';
import { printVerificationResult } from '../surfaces/cli/format-verification.mjs';

/**
 * Re-exported because callers — the generator's v1 import path, and
 * `test/verify-core.test.mjs` — import them from here. The path is part of the
 * façade even though the implementation moved.
 */
export { printVerificationResult, verifyImage };

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await runVerify(process.argv.slice(2));
}
