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
 *
 * ADR 0009 adds one exit code to the vocabulary, on new surface only:
 * **`2` is `PENDING_JUDGEMENT` — a checklist was written and no verdict exists
 * yet.** It is never a pass. The normaliser below passes an integer `2` through
 * unchanged, so every gate already written as "non-zero is failure" fails closed
 * on a pending run without knowing the code exists. Nothing reachable without
 * `--judge` can return it, so v1's two-code surface is untouched.
 */

import { printUsage, printUsageError } from './format-errors.mjs';
import { readVersion } from './version.mjs';

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
  ['judge', {
    summary: 'List, show, answer or close a pending host judgement',
    load: () => import('./commands/judge.mjs').then((module) => module.runJudge),
  }],
]);

/** The command names, in registry order — what the help and errors list. */
export function commandNames() {
  return [...COMMANDS.keys()];
}

/** Re-exported so `pixelproof --version` and the pending record agree (ADR 0009 §2). */
export { readVersion };

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

Run \`pixelproof <command> --help\` for a command's options. \`generate\`, \`verify\`
and \`doctor\` are identical to the legacy \`node scripts/<command>.mjs\` entry
points.

Host judgement (ADR 0009):
  --judge host              Ask the calling agent to judge the spec's "semantic"
                            assertions. Accepted by generate and verify.
  --judge-deadline <dur>    How long the checklist stays answerable (default 24h).
  --run-dir <path>          Run root; also PIXELPROOF_RUN_ROOT (default .pixelproof/runs)

With \`--judge host\` the artifact is written into the run directory and appears
at \`--out\` only once the run is accepted. The command exits 2, which means an
outstanding judgement and is never a pass. Answer it with \`pixelproof judge\`.
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
