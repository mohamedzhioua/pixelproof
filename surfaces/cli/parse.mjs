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
  --judge host        Ask the calling agent to judge the spec's semantic assertions
  --judge codex       Judge them here by running the Codex CLI (see below)
  --judge-deadline    How long the checklist stays answerable (default 24h)
  --run-dir <path>    Run root; also PIXELPROOF_RUN_ROOT (default .pixelproof/runs)
  -h, --help          Show this help

Host judgement:
  --judge host writes a checklist and exits 2: an outstanding judgement, never a
  pass. Answer it with \`pixelproof judge submit\`. Needs a .png and a spec with at
  least one "semantic" entry. --judge-deadline takes a duration such as 6h or 90m;
  a unit is required, because a bare number could be seconds or milliseconds.

Subprocess judgement:
  --judge codex runs the judge here and finishes in one invocation: 0 accepted,
  1 rejected. It never exits 2, because nothing is left outstanding, and
  --judge-deadline means nothing to it (PIXELPROOF_JUDGE_TIMEOUT_MS bounds the
  call instead). A judge that is not installed is refused before any work.
  An "unsure" verdict is a rejection here: escalation goes to a host, and this
  panel has none. Naming more than one judge is refused; panels are not wired.
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
  --judge host             Ask the calling agent to judge the spec's semantic assertions
  --judge codex            Judge them here by running the Codex CLI (see below)
  --judge-deadline <dur>   How long the checklist stays answerable (default 24h)
  --retakes <n>            Maximum total attempts in a judged run; needs --judge
  --run-dir <path>         Run root; also PIXELPROOF_RUN_ROOT (default .pixelproof/runs)
  -h, --help               Show this help

Size verification:
  --size without --spec creates a width/height mechanical spec and affects the exit code.
  Codex sizes must have edges divisible by 16, each edge <= 3840, an aspect ratio <= 3:1,
  and a total pixel count from 655360 through 8294400.

Provider selection:
  --provider, then PIXELPROOF_PROVIDER, then .svg output, then Codex on PATH.

Host judgement:
  --judge host writes a checklist and exits 2: an outstanding judgement, never a pass.
  The artifact is written into the run directory and appears at --out only once the run
  is accepted, so a rejected or abandoned run leaves no file there. Answer it with
  \`pixelproof judge submit\`. Needs a .png target and a spec with at least one "semantic"
  entry. --judge-deadline takes a duration such as 6h or 90m; a unit is required, because
  a bare number could be seconds or milliseconds.

Retakes:
  --retakes <n> bounds the total attempts inside one judged run and defaults to
  spec.retakes, then to 1. It needs --judge: without one, generate makes exactly one
  provider call, so honouring a bound would only change what the call costs. A rejected
  attempt leaves the run open; continue it with \`pixelproof retake --run <id>\`. Nothing
  is promoted on exhaustion.

Subprocess judgement:
  --judge codex judges here and finishes in one invocation: 0 accepted, 1 rejected,
  never 2. --judge-deadline means nothing to it (PIXELPROOF_JUDGE_TIMEOUT_MS bounds
  the call instead), a judge that is not installed is refused before any generation,
  and an "unsure" verdict is a rejection, because escalation goes to a host and this
  panel has none. Under --retakes it corrects and retakes in this same process rather
  than leaving the run open — the verdict arrived here, so there is nobody to hand it
  back to — which spends one generation and one judge call per attempt. Naming more
  than one judge is refused; panels are specified but not wired.
`;

/**
 * `--svg-file` becomes `svgFile`; `--file` stays `file`.
 *
 * This used to be generator-only, on the reasoning that applying it
 * unconditionally "would be harmless today but would silently rename a future
 * verifier flag". ADR 0009 is that future: `--judge-deadline` and `--run-dir`
 * land on both commands, and a verifier option keyed `judge-deadline` while the
 * generator's is `judgeDeadline` would be exactly the two-dialects problem ADR
 * 0003 forbids. Every v1 verifier flag is a single word, so turning it on
 * renames nothing that already exists.
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

/**
 * ADR 0009's options, accepted by both commands and listed in both banners.
 *
 * They are in the banners under the **2026-08-13 amendment to ADR 0003**, which
 * permits purely additive lines documenting a new flag while every existing line
 * stays byte-identical. The reasoning is in ADR 0003: the freeze exists to
 * prevent behavioural drift, and a help line adds no behaviour, whereas a flag
 * whose own command's help does not mention it is undiscoverable by the only
 * route a user would try.
 *
 * What the amendment does **not** relax, and what the compatibility tests still
 * hold byte for byte: no existing line may change, and no exit code, JSON field
 * or documented semantic may move. The banners still say `node
 * scripts/verify.mjs`, because these commands remain synonyms for the legacy
 * scripts rather than a new dialect.
 */
const JUDGE_VALUED = Object.freeze(['--judge', '--judge-deadline', '--run-dir']);

const VERIFY_VALUED = new Set(['--file', '--spec', ...JUDGE_VALUED]);

const GENERATE_FLAGS = new Map([
  ['-h', 'help'],
  ['--help', 'help'],
]);

/**
 * `--retakes` is generator-only (ADR 0020 §6).
 *
 * `verify` inspects an image somebody else made; there is no provider call to
 * repeat and no prompt to correct, so a bound there would name an attempt the
 * command could never spend. It stays an unknown argument to `verify`, which is
 * the parser's existing answer for a flag that does not apply.
 */
const GENERATE_VALUED = new Set([
  '--prompt',
  '--out',
  '--provider',
  '--size',
  '--spec',
  '--svg-file',
  '--retakes',
  ...JUDGE_VALUED,
]);

/** Parse verifier arguments. Throws on an unknown argument or a missing value. */
export function parseVerifyArguments(argv) {
  return parseArguments(argv, {
    flags: VERIFY_FLAGS,
    valued: VERIFY_VALUED,
    defaults: { json: false, strict: false, help: false },
    camelCase: true,
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
