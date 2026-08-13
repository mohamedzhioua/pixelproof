#!/usr/bin/env node

/**
 * The `pixelproof` executable.
 *
 * Deliberately almost empty: routing and exit policy live in
 * `surfaces/cli/main.mjs`, and this file exists only to be the thing npm links
 * onto `PATH`. It sets `process.exitCode` rather than calling `process.exit`,
 * so buffered stdout is flushed before the process ends — `process.exit` can
 * truncate a large `--json` result on a piped stdout.
 */

import { main } from '../surfaces/cli/main.mjs';

process.exitCode = await main(process.argv.slice(2));
