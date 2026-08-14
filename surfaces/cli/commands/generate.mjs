/**
 * The `generate` command handler.
 *
 * This is the body of what `scripts/generate.mjs` used to run inline: provider
 * selection, request shaping, the one-attempt run, and the exit code. Spec
 * loading, dimension precedence and prompt folding stay in `core/`; parsing and
 * presentation stay in the sibling CLI modules.
 *
 * As with `verify`, the handler returns an exit code rather than setting one,
 * and every string it prints is frozen v1 surface (ADR 0003) — `pixelproof
 * generate` is a synonym for `scripts/generate.mjs`, not a new dialect, so the
 * banner still names the script.
 *
 * The provider imports point at `providers/*`, where the implementations live.
 * They used to go through `scripts/providers/*`, the v1 import path, which made
 * this layer depend on the façade that is due for deletion (ADR 0002 runs
 * `surfaces → providers → core`). Nothing changes for the v1 characterization
 * tests: those shims re-export these same modules, so both routes still resolve
 * to one module instance, not two.
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { runOnce } from '../../../core/generation/run-once.mjs';
import { foldCorrectionsIntoPrompt } from '../../../core/generation/correction.mjs';
import { foldSpecIntoPrompt } from '../../../core/generation/prompt-v1.mjs';
import {
  describeSizeDisagreement,
  parseSize,
  resolveDimensions,
} from '../../../core/spec/dimensions.mjs';
import { loadV1Spec, mechanicalBlock, specFromSize } from '../../../core/spec/load-v1.mjs';
import { GENERATE_USAGE, parseGenerateArguments } from '../parse.mjs';
import {
  printGenerationError,
  printMissingOption,
  printUsage,
  printUsageError,
} from '../format-errors.mjs';
import { printVerificationResult, printWarning } from '../format-verification.mjs';
import {
  attemptTarget,
  completeJudgedRun,
  openJudgedRun,
  resolveJudgeOptions,
} from '../judged-run.mjs';
import { assertCodexSize, generateWithCodex } from '../../../providers/codex.mjs';
import { generateWithSvg } from '../../../providers/svg.mjs';
import { verifyImage } from './verify.mjs';

async function commandOnPath(command) {
  const pathValue = process.env.PATH ?? '';
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];

  for (const directoryValue of directories) {
    const directory = directoryValue.replace(/^"|"$/g, '');
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension.toLowerCase());
      const alternate = path.join(directory, command + extension.toUpperCase());
      for (const filePath of new Set([candidate, alternate])) {
        try {
          await access(filePath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
          return true;
        } catch (error) {
          if (error?.code !== 'ENOENT' && error?.code !== 'EACCES') throw error;
        }
      }
    }
  }
  return false;
}

function validateProvider(provider, source) {
  if (!['codex', 'svg'].includes(provider)) {
    throw new Error(`${source} must be "codex" or "svg", not "${provider}"`);
  }
  return provider;
}

async function resolveProvider(options) {
  if (options.provider) return validateProvider(options.provider, '--provider');
  if (process.env.PIXELPROOF_PROVIDER) {
    return validateProvider(process.env.PIXELPROOF_PROVIDER, 'PIXELPROOF_PROVIDER');
  }
  if (path.extname(options.out).toLowerCase() === '.svg') return 'svg';
  if (await commandOnPath('codex')) return 'codex';
  throw new Error(
    'No image provider is available. Install the Codex CLI with '
      + '`npm install -g @openai/codex` or `brew install --cask codex`, '
      + 'then log in; alternatively choose --provider svg and supply SVG markup.',
  );
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * Build the provider call for the selected provider. Provider selection and
 * request shaping are a composition concern, which is why they stay on this
 * side of the boundary rather than inside the run.
 *
 * Exported for `pixelproof retake`, which has to build attempt *n+1* exactly the
 * way attempt *n* was built. Two copies of this shaping would agree today and
 * drift the first time a provider gained an option, and a retake whose request
 * differs from the original in some unnoticed way is a retake of a different
 * question.
 */
export async function prepareGeneration({
  provider,
  options,
  dimensions,
  verificationSpec,
  corrections = null,
  correctingAttempt = null,
}) {
  if (provider === 'codex') {
    if (!options.prompt?.trim()) throw new Error('--prompt is required for the Codex provider');
    if (options.svgFile) throw new Error('--svg-file can only be used with the SVG provider');
    // ADR 0020 §4's order, in one place: the original prompt, the same spec
    // folding as always, and then the corrections. The generator's last words
    // are what went wrong last time.
    const folded = verificationSpec
      ? foldSpecIntoPrompt(options.prompt, verificationSpec, dimensions)
      : options.prompt;
    return {
      generate: generateWithCodex,
      request: {
        prompt: corrections === null
          ? folded
          : foldCorrectionsIntoPrompt(folded, corrections, { attempt: correctingAttempt }),
        outPath: options.out,
        width: dimensions.width,
        height: dimensions.height,
      },
    };
  }

  const svgText = options.svgFile
    ? await readFile(path.resolve(options.svgFile), 'utf8')
    : await readStandardInput();
  return {
    generate: generateWithSvg,
    request: {
      svgText,
      outPath: options.out,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
}

/** Run the generator over `argv` (already stripped of node and the entry point). */
export async function runGenerate(argv) {
  let options;
  try {
    options = parseGenerateArguments(argv);
  } catch (error) {
    printUsageError(error.message, GENERATE_USAGE);
    return 1;
  }

  if (options.help) {
    printUsage(GENERATE_USAGE);
    return 0;
  }
  if (!options.out) {
    printMissingOption('--out', GENERATE_USAGE);
    return 1;
  }

  try {
    const specPath = options.spec ? path.resolve(options.spec) : null;
    const spec = specPath ? await loadV1Spec(specPath) : {};
    const requestedSize = parseSize(options.size);
    const dimensions = resolveDimensions(requestedSize, mechanicalBlock(spec));
    if (specPath) {
      const disagreement = describeSizeDisagreement(requestedSize, dimensions);
      if (disagreement) printWarning(disagreement);
    }

    const provider = await resolveProvider(options);
    if (provider === 'codex' && requestedSize && !specPath) assertCodexSize(requestedSize);

    const verificationSpec = specPath
      ? spec
      : requestedSize
        ? specFromSize(requestedSize)
        : null;

    // Validated before a provider is invoked, so a target the host cannot judge
    // never costs a generation.
    const judged = resolveJudgeOptions(options, { artifact: options.out, spec });

    // A retake is a corrected prompt, and the SVG provider takes markup rather
    // than a prompt: a second attempt would reproduce the first byte for byte,
    // spending the bound to change nothing. Refused at the front door so the
    // state can never arise, before any generation.
    if (judged !== null && judged.retakes > 1 && provider === 'svg') {
      // Name where the bound came from: it may be `spec.retakes` rather than a
      // flag, and blaming `--retakes` for a number the user never typed sends
      // them looking in the wrong place.
      const source = options.retakes ? '--retakes' : 'spec.retakes';
      throw new Error(
        `a retake bound above 1 (${judged.retakes}, from ${source}) needs a prompt-driven provider; `
          + 'the svg provider is given markup, so a corrected prompt could not change what it produces.',
      );
    }

    // Under `--judge`, the artifact is generated into the run directory and
    // appears at `--out` only when the run is accepted (ADR 0009 §2).
    const opened = judged === null ? null : await openJudgedRun({
      command: 'generate',
      runDir: options.runDir ?? null,
      out: options.out,
      specPath,
      provider,
      judge: judged.judge,
      // Everything `pixelproof retake` needs to build attempt n+1 (ADR 0020 §4).
      prompt: options.prompt ?? null,
      size: { width: dimensions.width, height: dimensions.height },
      retakes: judged.retakes,
      deadlineMs: judged.deadlineMs ?? null,
    });
    const outPath = opened === null ? options.out : attemptTarget(opened.directory, options.out);

    /** One provider call plus its mechanical verification, for any attempt. */
    const attemptOnce = async (target, corrections = null, correctingAttempt = null) => {
      const { generate, request } = await prepareGeneration({
        provider,
        options: { ...options, out: target },
        dimensions,
        verificationSpec,
        corrections,
        correctingAttempt,
      });

      return runOnce({
        generate,
        request,
        onGenerated(generation) {
          console.log(`Provider: ${provider}`);
          console.log(`Output: ${generation.outputPath}`);
          for (const warning of generation.warnings ?? []) printWarning(warning);
        },
        verify: verificationSpec
          ? async (generation) => {
            // Mechanical checks read pixels, so a vector-only result has nothing
            // to inspect. Saying so is the point: a silent pass here would be the
            // unverified-claim failure this tool exists to prevent.
            if (!generation.outputPath.toLowerCase().endsWith('.png')) {
              printWarning(
                'mechanical verification needs a PNG raster; the validated SVG was kept, '
                  + 'but no raster was available to inspect.',
              );
              return null;
            }
            const verification = await verifyImage({
              filePath: generation.outputPath,
              spec: verificationSpec,
              specPath,
            });
            printVerificationResult(verification);
            return verification;
          }
          : null,
      });
    };

    const { ok, verification } = await attemptOnce(outPath);

    if (opened === null) return ok ? 0 : 1;

    return completeJudgedRun(opened.directory, {
      run: opened.run,
      artifactPath: outPath,
      // Already inside the run directory: copying it onto itself would only
      // create a second name for the same bytes.
      copy: false,
      verification,
      spec,
      specPath,
      assertions: judged.assertions,
      deadlineMs: judged.deadlineMs,
      out: options.out,
      // A mechanical failure needs no host, so the correction and the next
      // generation happen here rather than being handed back to an operator
      // (ADR 0020 §2).
      regenerate: async ({ attempt, corrections }) => {
        const target = attemptTarget(opened.directory, options.out, attempt);
        const result = await attemptOnce(target, corrections, attempt - 1);
        return { artifactPath: target, verification: result.verification };
      },
    });
  } catch (error) {
    printGenerationError(error);
    return 1;
  }
}

export default runGenerate;
