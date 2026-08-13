#!/usr/bin/env node

/**
 * Legacy entry point for the generator.
 *
 * Spec loading, dimension precedence, prompt folding and the one-attempt run
 * now live in `core/`, and argument parsing and presentation in `surfaces/cli/`;
 * what remains here is provider selection, composition and exit policy. Flags,
 * output text, channels and exit codes are frozen public surface (ADR 0003), so
 * this file still behaves exactly as v1 shipped it.
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runOnce } from '../core/generation/run-once.mjs';
import { foldSpecIntoPrompt } from '../core/generation/prompt-v1.mjs';
import {
  describeSizeDisagreement,
  parseSize,
  resolveDimensions,
} from '../core/spec/dimensions.mjs';
import { loadV1Spec, mechanicalBlock, specFromSize } from '../core/spec/load-v1.mjs';
import { GENERATE_USAGE, parseGenerateArguments } from '../surfaces/cli/parse.mjs';
import {
  printGenerationError,
  printMissingOption,
  printUsage,
  printUsageError,
} from '../surfaces/cli/format-errors.mjs';
import { printVerificationResult, printWarning } from '../surfaces/cli/format-verification.mjs';
import { assertCodexSize, generateWithCodex } from './providers/codex.mjs';
import { generateWithSvg } from './providers/svg.mjs';
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

async function main() {
  let options;
  try {
    options = parseGenerateArguments(process.argv.slice(2));
  } catch (error) {
    printUsageError(error.message, GENERATE_USAGE);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage(GENERATE_USAGE);
    return;
  }
  if (!options.out) {
    printMissingOption('--out', GENERATE_USAGE);
    process.exitCode = 1;
    return;
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

    if (!ok) process.exitCode = 1;
  } catch (error) {
    printGenerationError(error);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
