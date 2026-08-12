#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateWithCodex } from './providers/codex.mjs';
import { generateWithSvg } from './providers/svg.mjs';
import { printVerificationResult, verifyImage } from './verify.mjs';

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const CODEX_MAX_EDGE = 3840;
const CODEX_MIN_PIXELS = 655_360;
const CODEX_MAX_PIXELS = 8_294_400;
const CODEX_MAX_ASPECT_RATIO = 3;

function usage() {
  return `pixelproof image generator

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
}

function parseArgs(argv) {
  const options = { help: false };
  const valuedOptions = new Set([
    '--prompt',
    '--out',
    '--provider',
    '--size',
    '--spec',
    '--svg-file',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else if (valuedOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function parseSize(value) {
  if (!value) return null;
  const match = value.match(/^(\d+)[xX](\d+)$/);
  if (!match) throw new Error('--size must use the form WxH, for example 1254x1254');
  return {
    width: positiveInteger(match[1], 'size width'),
    height: positiveInteger(match[2], 'size height'),
  };
}

function parseAspect(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new Error('mechanical.aspect must be a string');
  const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) throw new Error('mechanical.aspect must use the form width:height');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) throw new Error('mechanical.aspect values must be positive');
  return width / height;
}

function resolveDimensions(explicit, mechanical) {
  const declaredWidth = mechanical.width === undefined
    ? null
    : positiveInteger(mechanical.width, 'mechanical.width');
  const declaredHeight = mechanical.height === undefined
    ? null
    : positiveInteger(mechanical.height, 'mechanical.height');
  const aspect = parseAspect(mechanical.aspect);

  let width = declaredWidth ?? explicit?.width ?? DEFAULT_WIDTH;
  let height = declaredHeight ?? explicit?.height ?? DEFAULT_HEIGHT;

  if (!explicit && aspect) {
    if (declaredWidth && !declaredHeight) {
      height = Math.max(1, Math.round(width / aspect));
    } else if (declaredHeight && !declaredWidth) {
      width = Math.max(1, Math.round(height * aspect));
    } else if (!declaredWidth && !declaredHeight) {
      height = Math.max(1, Math.round(width / aspect));
    }
  }

  if (aspect && Math.abs(width / height - aspect) > 0.01) {
    throw new Error(
      `Resolved dimensions ${width}x${height} conflict with spec aspect ${mechanical.aspect}`,
    );
  }
  return { width, height };
}

function assertCodexSize(size) {
  const totalPixels = size.width * size.height;
  const longToShortRatio = Math.max(size.width, size.height) / Math.min(size.width, size.height);
  const violations = [];

  if (totalPixels < CODEX_MIN_PIXELS) {
    violations.push(
      `total pixel count ${totalPixels} is below the minimum total pixel count ${CODEX_MIN_PIXELS}`,
    );
  }
  if (totalPixels > CODEX_MAX_PIXELS) {
    violations.push(
      `total pixel count ${totalPixels} exceeds the maximum total pixel count ${CODEX_MAX_PIXELS}`,
    );
  }
  if (size.width > CODEX_MAX_EDGE) {
    violations.push(`width ${size.width} exceeds the maximum edge length ${CODEX_MAX_EDGE}`);
  }
  if (size.height > CODEX_MAX_EDGE) {
    violations.push(`height ${size.height} exceeds the maximum edge length ${CODEX_MAX_EDGE}`);
  }
  if (size.width % 16 !== 0) {
    violations.push(`width ${size.width} is not a multiple of 16`);
  }
  if (size.height % 16 !== 0) {
    violations.push(`height ${size.height} is not a multiple of 16`);
  }
  if (longToShortRatio > CODEX_MAX_ASPECT_RATIO) {
    violations.push(
      `long-to-short ratio ${longToShortRatio.toFixed(4)} exceeds the maximum 3:1 ratio`,
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `--size ${size.width}x${size.height} cannot be honoured by gpt-image-2: `
        + violations.join('; '),
    );
  }
}

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

function assertSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('The spec root must be a JSON object');
  }
  if (spec.mechanical !== undefined
    && (!spec.mechanical || typeof spec.mechanical !== 'object' || Array.isArray(spec.mechanical))) {
    throw new Error('spec.mechanical must be an object when present');
  }
  if (spec.semantic !== undefined
    && (!Array.isArray(spec.semantic) || spec.semantic.some((item) => typeof item !== 'string'))) {
    throw new Error('spec.semantic must be an array of strings when present');
  }
}

function promptWithSpec(prompt, spec, dimensions) {
  const mechanical = spec.mechanical ?? {};
  const additions = [
    '',
    'Pixelproof spec constraints:',
    `- Output dimensions: exactly ${dimensions.width}x${dimensions.height} pixels.`,
  ];

  if (mechanical.aspect) additions.push(`- Aspect ratio: ${mechanical.aspect}.`);
  if (mechanical.corners?.expect) {
    const tolerance = mechanical.corners.tolerance ?? 3;
    additions.push(
      `- Background and all four corner pixels: ${mechanical.corners.expect} `
        + `(the verifier allows ±${tolerance} per RGB channel).`,
    );
  }
  if (mechanical.alpha === 'opaque') additions.push('- The image must be fully opaque.');
  if (mechanical.alpha === 'transparent') {
    additions.push('- The image must contain genuine transparency where the background is absent.');
  }
  if (mechanical.maxBytes) additions.push(`- Keep the PNG at or below ${mechanical.maxBytes} bytes.`);
  if (spec.semantic?.length) {
    additions.push('- Semantic requirements:');
    for (const criterion of spec.semantic) additions.push(`  - ${criterion}`);
  }

  return `${prompt.trim()}\n${additions.join('\n')}`;
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.out) {
    console.error(`Error: --out is required\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  try {
    const specPath = options.spec ? path.resolve(options.spec) : null;
    const spec = specPath ? JSON.parse(await readFile(specPath, 'utf8')) : {};
    assertSpec(spec);
    const mechanical = spec.mechanical ?? {};
    const requestedSize = parseSize(options.size);
    const dimensions = resolveDimensions(requestedSize, mechanical);
    if (specPath && requestedSize
      && (requestedSize.width !== dimensions.width || requestedSize.height !== dimensions.height)) {
      console.warn(
        `Warning: --size requested ${requestedSize.width}x${requestedSize.height}, but the spec `
          + `dimensions are ${dimensions.width}x${dimensions.height}; the spec is authoritative.`,
      );
    }
    const provider = await resolveProvider(options);
    if (provider === 'codex' && requestedSize && !specPath) assertCodexSize(requestedSize);
    const verificationSpec = specPath
      ? spec
      : requestedSize
        ? { mechanical: { width: requestedSize.width, height: requestedSize.height } }
        : null;
    let generation;

    if (provider === 'codex') {
      if (!options.prompt?.trim()) throw new Error('--prompt is required for the Codex provider');
      if (options.svgFile) throw new Error('--svg-file can only be used with the SVG provider');
      const generationPrompt = verificationSpec
        ? promptWithSpec(options.prompt, verificationSpec, dimensions)
        : options.prompt;
      generation = await generateWithCodex({
        prompt: generationPrompt,
        outPath: options.out,
        width: dimensions.width,
        height: dimensions.height,
      });
    } else {
      const svgText = options.svgFile
        ? await readFile(path.resolve(options.svgFile), 'utf8')
        : await readStandardInput();
      generation = await generateWithSvg({
        svgText,
        outPath: options.out,
        width: dimensions.width,
        height: dimensions.height,
      });
    }

    console.log(`Provider: ${provider}`);
    console.log(`Output: ${generation.outputPath}`);
    for (const warning of generation.warnings ?? []) console.warn(`Warning: ${warning}`);

    if (verificationSpec) {
      if (generation.outputPath.toLowerCase().endsWith('.png')) {
        const verification = await verifyImage({
          filePath: generation.outputPath,
          spec: verificationSpec,
          specPath,
        });
        printVerificationResult(verification);
        if (!verification.ok) process.exitCode = 1;
      } else {
        console.warn(
          'Warning: mechanical verification needs a PNG raster; the validated SVG was kept, '
            + 'but no raster was available to inspect.',
        );
      }
    }
  } catch (error) {
    console.error(`Generation error: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
