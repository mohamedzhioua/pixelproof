/**
 * CLI argument parsing and usage banners.
 *
 * Both legacy commands hand-rolled the same loop: a set of boolean flags, a set
 * of options that take the next argv entry, and a hard error on anything else.
 * The loop is shared here; the *vocabulary* is not, because each command's flag
 * list, key naming and banner are frozen public surface (ADR 0003).
 *
 * Two details are load-bearing and deliberately preserved rather than tidied:
 *
 * - a valued option rejects a missing value *and* a value that starts with
 *   `--`, so `--file --json` is an error rather than a file named `--json`;
 * - the error text is `<argument> requires a value` and `Unknown argument:
 *   <argument>`, and callers print it as `Error: <message>` followed by the
 *   banner. Those exact strings are asserted by the compatibility tests.
 *
 * This module never writes to a stream: it returns options or throws.
 */

export const VERIFY_USAGE = `pixelproof mechanical verifier

Usage:
  node scripts/verify.mjs --file <path> [--spec <spec.json>] [--json] [--strict]

Options:
  --file <path>       Image to inspect (required)
  --spec <path>       JSON spec containing a mechanical block
  --json              Print a machine-readable result object
  --strict            Treat skipped checks as failures
  -h, --help          Show this help
`;

export const GENERATE_USAGE = `pixelproof image generator

Usage:
  node scripts/generate.mjs --prompt "<text>" --out <path> [options]

Options:
  --prompt <text>          Raster generation prompt (required for Codex)
  --out <path>             Target .png or .svg path (required)
  --provider codex|svg     Override provider selection
  --size <WxH>             Desired pixels; verified when --spec is absent
  --spec <file>            Fold a JSON spec into the prompt and verify it; spec dimensions win
  --svg-file <path>        SVG source for the svg provider; otherwise read stdin
  -h, --help               Show this help

Size verification:
  --size without --spec creates a width/height mechanical spec and affects the exit code.
  Codex sizes must have edges divisible by 16, each edge <= 3840, an aspect ratio <= 3:1,
  and a total pixel count from 655360 through 8294400.

Provider selection:
  --provider, then PIXELPROOF_PROVIDER, then .svg output, then Codex on PATH.
`;

/**
 * `--svg-file` becomes `svgFile`; `--file` stays `file`. Only the generator ever
 * had a dashed option, so only it asks for the conversion — applying it
 * unconditionally would be harmless today but would silently rename a future
 * verifier flag.
 */
function optionKey(argument, camelCase) {
  const name = argument.slice(2);
  return camelCase ? name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : name;
}

/**
 * The shared loop. `flags` maps an accepted argument (including aliases such as
 * `-h`) to the option key it sets to `true`; `valued` is the set of arguments
 * that consume the following argv entry.
 */
export function parseArguments(argv, { flags, valued, defaults = {}, camelCase = false }) {
  const options = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      options[flags.get(argument)] = true;
    } else if (valued.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      options[optionKey(argument, camelCase)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

const VERIFY_FLAGS = new Map([
  ['--json', 'json'],
  ['--strict', 'strict'],
  ['-h', 'help'],
  ['--help', 'help'],
]);

const VERIFY_VALUED = new Set(['--file', '--spec']);

const GENERATE_FLAGS = new Map([
  ['-h', 'help'],
  ['--help', 'help'],
]);

const GENERATE_VALUED = new Set([
  '--prompt',
  '--out',
  '--provider',
  '--size',
  '--spec',
  '--svg-file',
]);

/** Parse verifier arguments. Throws on an unknown argument or a missing value. */
export function parseVerifyArguments(argv) {
  return parseArguments(argv, {
    flags: VERIFY_FLAGS,
    valued: VERIFY_VALUED,
    defaults: { json: false, strict: false, help: false },
  });
}

/** Parse generator arguments. Throws on an unknown argument or a missing value. */
export function parseGenerateArguments(argv) {
  return parseArguments(argv, {
    flags: GENERATE_FLAGS,
    valued: GENERATE_VALUED,
    defaults: { help: false },
    camelCase: true,
  });
}
