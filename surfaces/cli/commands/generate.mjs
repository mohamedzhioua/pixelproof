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
 * The provider imports deliberately point at `scripts/providers/*`, which is
 * where the legacy entry point pointed. Those files are the v1 import path and
 * re-export the real implementations; going through them keeps this handler and
 * the v1 characterization tests on one module instance instead of two.
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { runOnce } from '../../../core/generation/run-once.mjs';
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
import { assertCodexSize, generateWithCodex } from '../../../scripts/providers/codex.mjs';
import { generateWithSvg } from '../../../scripts/providers/svg.mjs';
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
 */
async function prepareGeneration({ provider, options, dimensions, verificationSpec }) {
  if (provider === 'codex') {
    if (!options.prompt?.trim()) throw new Error('--prompt is required for the Codex provider');
    if (options.svgFile) throw new Error('--svg-file can only be used with the SVG provider');
    return {
      generate: generateWithCodex,
      request: {
        prompt: verificationSpec
          ? foldSpecIntoPrompt(options.prompt, verificationSpec, dimensions)
          : options.prompt,
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

    const { generate, request } = await prepareGeneration({
      provider,
      options,
      dimensions,
      verificationSpec,
    });

    const { ok } = await runOnce({
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

    return ok ? 0 : 1;
  } catch (error) {
    printGenerationError(error);
    return 1;
  }
}

export default runGenerate;
