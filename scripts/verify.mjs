#!/usr/bin/env node

import { access, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ASPECT_TOLERANCE = 0.01;

function usage() {
  return `pixelproof mechanical verifier

Usage:
  node scripts/verify.mjs --file <path> [--spec <spec.json>] [--json] [--strict]

Options:
  --file <path>       Image to inspect (required)
  --spec <path>       JSON spec containing a mechanical block
  --json              Print a machine-readable result object
  --strict            Treat skipped checks as failures
  -h, --help          Show this help
`;
}

function parseArgs(argv) {
  const options = { json: false, strict: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--strict') {
      options.strict = true;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else if (argument === '--file' || argument === '--spec') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function parsePngHeader(buffer) {
  if (buffer.length < 29 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('The sharp fallback can only inspect valid PNG files');
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Invalid PNG: the first chunk is not IHDR');
  }
  if (buffer.readUInt32BE(8) !== 13) {
    throw new Error('Invalid PNG: IHDR has an unexpected length');
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error('Invalid PNG: width and height must be greater than zero');
  }
  return { width, height };
}

async function loadSharp() {
  try {
    const imported = await import('sharp');
    return { sharp: imported.default, error: null };
  } catch (error) {
    return { sharp: null, error };
  }
}

function normaliseHex(value, label) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${label} must be a colour in #RRGGBB form`);
  }
  return value.toUpperCase();
}

function hexToRgb(value) {
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

function addCheck(checks, name, expected, actual, passed) {
  checks.push({
    name,
    expected,
    actual,
    passed,
    status: passed ? 'PASS' : 'FAIL',
  });
}

function addSkippedCheck(checks, name, expected, reason) {
  checks.push({
    name,
    expected,
    actual: reason,
    passed: null,
    status: 'SKIP',
  });
}

function parseAspect(value) {
  if (typeof value !== 'string') {
    throw new Error('mechanical.aspect must be a string such as "16:9"');
  }
  const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) {
    throw new Error('mechanical.aspect must use the form width:height, for example "16:9"');
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (numerator <= 0 || denominator <= 0) {
    throw new Error('mechanical.aspect values must be greater than zero');
  }
  return numerator / denominator;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

async function inspectWithSharp(sharp, filePath) {
  const image = sharp(filePath, { failOn: 'error' });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('sharp could not determine the image dimensions');
  }

  return {
    width: metadata.width,
    height: metadata.height,
    async pixels() {
      return sharp(filePath, { failOn: 'error' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    },
  };
}

async function inspectWithoutSharp(filePath) {
  const header = Buffer.alloc(29);
  const file = await open(filePath, 'r');
  try {
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < header.length) throw new Error('Invalid PNG: file is shorter than its header');
  } finally {
    await file.close();
  }
  return parsePngHeader(header);
}

export async function verifyImage({ filePath, spec = {}, specPath = null, strict = false }) {
  const resolvedFile = path.resolve(filePath);
  await access(resolvedFile);

  const mechanical = spec.mechanical ?? {};
  if (mechanical === null || typeof mechanical !== 'object' || Array.isArray(mechanical)) {
    throw new Error('spec.mechanical must be an object when present');
  }

  const warnings = [];
  const notes = [];
  const checks = [];
  const { sharp, error: sharpError } = await loadSharp();
  let inspection;

  if (sharp) {
    inspection = await inspectWithSharp(sharp, resolvedFile);
  } else {
    inspection = await inspectWithoutSharp(resolvedFile);
    warnings.push(
      `sharp is unavailable (${sharpError?.code ?? sharpError?.message ?? 'not installed'}); `
        + 'corner colour and alpha checks cannot be performed.',
    );
  }

  if (Object.keys(mechanical).length === 0) {
    notes.push('No mechanical checks were declared; the mechanical tier passes by default.');
  }

  if (mechanical.width !== undefined) {
    assertPositiveInteger(mechanical.width, 'mechanical.width');
    addCheck(checks, 'width', mechanical.width, inspection.width, inspection.width === mechanical.width);
  }

  if (mechanical.height !== undefined) {
    assertPositiveInteger(mechanical.height, 'mechanical.height');
    addCheck(checks, 'height', mechanical.height, inspection.height, inspection.height === mechanical.height);
  }

  if (mechanical.aspect !== undefined) {
    const expectedRatio = parseAspect(mechanical.aspect);
    const actualRatio = inspection.width / inspection.height;
    addCheck(
      checks,
      'aspect',
      `${mechanical.aspect} (±${ASPECT_TOLERANCE})`,
      `${inspection.width}:${inspection.height} (${actualRatio.toFixed(4)})`,
      Math.abs(actualRatio - expectedRatio) <= ASPECT_TOLERANCE,
    );
  }

  let pixelData = null;
  async function getPixels() {
    if (!pixelData) {
      pixelData = await inspection.pixels();
    }
    return pixelData;
  }

  if (mechanical.corners !== undefined) {
    const corners = mechanical.corners;
    if (!corners || typeof corners !== 'object' || Array.isArray(corners)) {
      throw new Error('mechanical.corners must be an object');
    }
    const expectedHex = normaliseHex(corners.expect, 'mechanical.corners.expect');
    const tolerance = corners.tolerance ?? 3;
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
      throw new Error('mechanical.corners.tolerance must be an integer from 0 to 255');
    }

    if (!sharp) {
      addSkippedCheck(checks, 'corners', `${expectedHex} (±${tolerance}/channel)`, 'sharp unavailable');
    } else {
      const { data, info } = await getPixels();
      const coordinates = [
        [0, 0],
        [info.width - 1, 0],
        [0, info.height - 1],
        [info.width - 1, info.height - 1],
      ];
      const expectedRgb = hexToRgb(expectedHex);
      const samples = coordinates.map(([x, y]) => {
        const offset = (y * info.width + x) * info.channels;
        return {
          x,
          y,
          r: data[offset],
          g: data[offset + 1],
          b: data[offset + 2],
        };
      });
      const passed = samples.every((sample) =>
        Math.abs(sample.r - expectedRgb.r) <= tolerance
        && Math.abs(sample.g - expectedRgb.g) <= tolerance
        && Math.abs(sample.b - expectedRgb.b) <= tolerance);
      const actual = samples
        .map((sample) => `(${sample.x},${sample.y}) ${rgbToHex(sample.r, sample.g, sample.b)}`)
        .join(', ');
      addCheck(checks, 'corners', `${expectedHex} (±${tolerance}/channel)`, actual, passed);
    }
  }

  if (mechanical.alpha !== undefined) {
    const expectedAlpha = mechanical.alpha;
    if (!['opaque', 'transparent', 'any'].includes(expectedAlpha)) {
      throw new Error('mechanical.alpha must be "opaque", "transparent", or "any"');
    }

    if (expectedAlpha === 'any') {
      addCheck(checks, 'alpha', 'any', 'any alpha accepted', true);
    } else if (!sharp) {
      addSkippedCheck(checks, 'alpha', expectedAlpha, 'sharp unavailable');
    } else {
      const { data, info } = await getPixels();
      let minimumAlpha = 255;
      let maximumAlpha = 0;
      for (let offset = 3; offset < data.length; offset += info.channels) {
        const alpha = data[offset];
        minimumAlpha = Math.min(minimumAlpha, alpha);
        maximumAlpha = Math.max(maximumAlpha, alpha);
      }
      const passed = expectedAlpha === 'opaque' ? minimumAlpha === 255 : minimumAlpha < 255;
      addCheck(
        checks,
        'alpha',
        expectedAlpha,
        `range ${minimumAlpha}-${maximumAlpha}`,
        passed,
      );
    }
  }

  if (mechanical.maxBytes !== undefined) {
    assertPositiveInteger(mechanical.maxBytes, 'mechanical.maxBytes');
    const fileStats = await stat(resolvedFile);
    addCheck(checks, 'maxBytes', `≤ ${mechanical.maxBytes}`, fileStats.size, fileStats.size <= mechanical.maxBytes);
  }

  const failedChecks = checks.filter((check) => check.passed === false);
  const skippedChecks = checks.filter((check) => check.passed === null);
  const passed = checks.length - failedChecks.length - skippedChecks.length;
  const failed = failedChecks.length;
  const skipped = skippedChecks.length;
  const ok = failed === 0 && (!strict || skipped === 0);
  return {
    file: resolvedFile,
    spec: specPath ? path.resolve(specPath) : null,
    decoder: sharp ? 'sharp' : 'png-header-fallback',
    degraded: !sharp,
    passed,
    failed,
    skipped,
    strict,
    ok,
    checks,
    summary: { passed, failed, skipped },
    warnings,
    notes,
  };
}

function displayValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function printVerificationResult(result) {
  const skippedSuffix = result.skipped > 0
    ? ` (${result.skipped} checks SKIPPED - not verified)`
    : '';
  console.log(`Mechanical verification: ${result.ok ? 'PASS' : 'FAIL'}${skippedSuffix}`);
  console.log(`File: ${result.file}`);
  console.log(`Decoder: ${result.decoder}`);

  if (result.checks.length > 0) {
    const rows = result.checks.map((check) => ({
      Check: check.name,
      Expected: displayValue(check.expected),
      Actual: displayValue(check.actual),
      Result: check.status,
    }));
    console.table(rows);
  }

  for (const note of result.notes) {
    console.log(`Note: ${note}`);
  }
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  console.log(
    `Summary: ${result.summary.passed} passed, ${result.summary.failed} failed, `
      + `${result.summary.skipped} skipped`,
  );
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
  if (!options.file) {
    console.error(`Error: --file is required\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  try {
    let spec = {};
    if (options.spec) {
      spec = JSON.parse(await readFile(path.resolve(options.spec), 'utf8'));
    }
    const result = await verifyImage({
      filePath: options.file,
      spec,
      specPath: options.spec ?? null,
      strict: options.strict,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printVerificationResult(result);
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({
        passed: 0,
        failed: 1,
        skipped: 0,
        strict: options.strict,
        ok: false,
        error: error.message,
      }, null, 2));
    } else {
      console.error(`Verification error: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
