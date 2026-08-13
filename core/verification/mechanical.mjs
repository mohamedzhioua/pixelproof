/**
 * The mechanical tier: everything about an image that code can decide without a
 * model. Deterministic, free, and reproducible — which is why it gates.
 *
 * Colour assertions carry a per-channel tolerance because generative models do
 * not deliver exact values. Three measured runs put a requested pure white at
 * #FEFDFD, #FEFEFE and #FFFEFD; a zero-tolerance #FFFFFF check would reject
 * every otherwise-correct image forever.
 *
 * Check names and the exact `expected`/`actual` strings are part of the public
 * output contract (ADR 0003) and must not drift.
 */

import { stat } from 'node:fs/promises';

import { addCheck, addSkippedCheck } from './result.mjs';

export const ASPECT_TOLERANCE = 0.01;
export const DEFAULT_CORNER_TOLERANCE = 3;
export const ALPHA_MODES = Object.freeze(['opaque', 'transparent', 'any']);

const SKIP_REASON_NO_DECODER = 'sharp unavailable';

export function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function normaliseHex(value, label) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${label} must be a colour in #RRGGBB form`);
  }
  return value.toUpperCase();
}

export function hexToRgb(value) {
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

export function parseAspect(value) {
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

export function assertMechanicalBlock(mechanical) {
  if (mechanical === null || typeof mechanical !== 'object' || Array.isArray(mechanical)) {
    throw new Error('spec.mechanical must be an object when present');
  }
  return mechanical;
}

/**
 * Run every declared check. Absent keys are not checked at all — a spec declares
 * what it cares about, and an empty block passes with a note rather than
 * inventing requirements nobody asked for.
 */
export async function runMechanicalChecks({ mechanical, inspection, sharp, filePath }) {
  const checks = [];
  const notes = [];

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

  // Decoded once and shared: the corner and alpha checks both need raw pixels,
  // and decoding a large image twice is pure waste.
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
    const tolerance = corners.tolerance ?? DEFAULT_CORNER_TOLERANCE;
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
      throw new Error('mechanical.corners.tolerance must be an integer from 0 to 255');
    }

    if (!sharp) {
      addSkippedCheck(checks, 'corners', `${expectedHex} (±${tolerance}/channel)`, SKIP_REASON_NO_DECODER);
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
        return { x, y, r: data[offset], g: data[offset + 1], b: data[offset + 2] };
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
    if (!ALPHA_MODES.includes(expectedAlpha)) {
      throw new Error('mechanical.alpha must be "opaque", "transparent", or "any"');
    }

    if (expectedAlpha === 'any') {
      addCheck(checks, 'alpha', 'any', 'any alpha accepted', true);
    } else if (!sharp) {
      addSkippedCheck(checks, 'alpha', expectedAlpha, SKIP_REASON_NO_DECODER);
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
      addCheck(checks, 'alpha', expectedAlpha, `range ${minimumAlpha}-${maximumAlpha}`, passed);
    }
  }

  if (mechanical.maxBytes !== undefined) {
    assertPositiveInteger(mechanical.maxBytes, 'mechanical.maxBytes');
    const fileStats = await stat(filePath);
    addCheck(
      checks,
      'maxBytes',
      `≤ ${mechanical.maxBytes}`,
      fileStats.size,
      fileStats.size <= mechanical.maxBytes,
    );
  }

  return { checks, notes };
}
