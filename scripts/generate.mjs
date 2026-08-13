#!/usr/bin/env node

/**
 * Legacy entry point for the generator.
 *
 * Spec loading, dimension precedence, prompt folding and the one-attempt run
 * live in `core/`; argument parsing and presentation in `surfaces/cli/`; and
 * provider selection, composition and exit policy in
 * `surfaces/cli/commands/generate.mjs`. What remains here is a shim: it calls
 * the same handler `pixelproof generate` calls, in the same process — it does
 * not spawn a second Node, and it is not a fork. Flags, output text, channels
 * and exit codes are frozen public surface (ADR 0003), so this file still
 * behaves exactly as v1 shipped it.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runGenerate } from '../surfaces/cli/commands/generate.mjs';

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await runGenerate(process.argv.slice(2));
}
