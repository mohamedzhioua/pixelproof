/**
 * Subcommand routing and exit policy for the `pixelproof` executable.
 *
 * Routing goes through a registry rather than a chain of hardcoded imports, for
 * two reasons. Adding a command is a one-line change in one obvious place, so
 * two people can add commands in parallel without colliding on a dispatch
 * `switch`; and each entry loads its handler lazily, so `pixelproof verify`
 * never pulls the generator's provider tree into the process.
 *
 * Exit policy lives here and only here: a handler *returns* a code, this module
 * normalises it, and `bin/pixelproof.mjs` assigns it to `process.exitCode`.
 * Nothing below the entry point calls `process.exit`, so a caller embedding the
 * CLI in another process keeps control of its own lifetime.
 *
 * The subcommands are synonyms for the legacy scripts, not a new dialect: their
 * flags, text and exit codes are the frozen v1 surface (ADR 0003). Only the
 * top-level banner below is new, because v1 had no top level.
 */

import { readFile } from 'node:fs/promises';

import { printUsage, printUsageError } from './format-errors.mjs';

/**
 * The command registry: name -> { summary, load }.
 *
 * `load` resolves to the handler, which takes the remaining argv and returns an
 * exit code. Registering a command is one line here and nothing else.
 */
export const COMMANDS = new Map([
  ['generate', {
    summary: 'Generate a raster or vector asset and verify it against its spec',
    load: () => import('./commands/generate.mjs').then((module) => module.runGenerate),
  }],
  ['verify', {
    summary: 'Check an existing image against a mechanical spec',
    load: () => import('./commands/verify.mjs').then((module) => module.runVerify),
  }],
  ['doctor', {
    summary: 'Report which providers and decoders are available, and what will be skipped',
    // `doctorCommand` takes an options object because its tests inject probes,
    // while the registry contract is `handler(argv)`. Adapt at the seam rather
    // than bending either side to match the other.
    load: () => import('./commands/doctor.mjs')
      .then((module) => (argv) => module.doctorCommand({ argv })),
  }],
]);

/** The command names, in registry order — what the help and errors list. */
export function commandNames() {
  return [...COMMANDS.keys()];
}

/** Read the version from the manifest; never hardcode it in a second place. */
export async function readVersion() {
  const manifestUrl = new URL('../../package.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  return manifest.version;
}

/** The top-level banner, with the command list derived from the registry. */
export function mainUsage() {
  const width = Math.max(...commandNames().map((name) => name.length));
  const rows = [...COMMANDS.entries()]
    .map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`)
    .join('\n');

  return `pixelproof

Usage:
  pixelproof <command> [options]

Commands:
${rows}

Options:
  -h, --help          Show this help
  -v, --version       Show the version

Run \`pixelproof <command> --help\` for a command's options. The subcommands are
identical to the legacy \`node scripts/<command>.mjs\` entry points.
`;
}

/**
 * Route `argv` to a command and return its exit code.
 *
 * A non-numeric or negative return from a handler would silently become a zero
 * exit, which is the "reported success without evidence" failure this project
 * exists to prevent, so it is normalised to 1 instead.
 */
export async function main(argv = []) {
  const [name, ...rest] = argv;

  if (name === undefined) {
    printUsageError('a command is required', mainUsage());
    return 1;
  }

  if (name === '-h' || name === '--help' || name === 'help') {
    printUsage(mainUsage());
    return 0;
  }

  if (name === '-v' || name === '--version' || name === 'version') {
    console.log(await readVersion());
    return 0;
  }

  const command = COMMANDS.get(name);
  if (!command) {
    printUsageError(
      `Unknown command: ${name}. Available commands: ${commandNames().join(', ')}`,
      mainUsage(),
    );
    return 1;
  }

  const run = await command.load();
  const code = await run(rest);
  return Number.isInteger(code) && code >= 0 ? code : 1;
}

export default main;
