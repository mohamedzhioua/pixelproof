/**
 * Image inspection: decoder discovery, dimensions, and raw pixels.
 *
 * `sharp` is optional, so every caller has to cope with it being absent. The
 * decoder is discovered through an injectable probe rather than a bare
 * `import('sharp')` at the call site: tests need to exercise the degraded path
 * without uninstalling anything, and the previous approach — copying the script
 * to a directory where module resolution fails — silently couples the test to
 * the file layout and breaks the moment the file gains an import.
 */

import { open } from 'node:fs/promises';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Enough bytes for the signature plus a complete IHDR chunk header. */
const PNG_HEADER_BYTES = 29;

export const DECODER_SHARP = 'sharp';
export const DECODER_FALLBACK = 'png-header-fallback';

export function parsePngHeader(buffer) {
  if (buffer.length < PNG_HEADER_BYTES || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
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

/** The default probe. Replaceable so a caller can simulate absence. */
export async function loadSharpDecoder() {
  try {
    const imported = await import('sharp');
    return { sharp: imported.default, error: null };
  } catch (error) {
    return { sharp: null, error };
  }
}

/** A probe that always reports `sharp` as missing, for the degraded path. */
export function missingDecoder(code = 'ERR_MODULE_NOT_FOUND') {
  return async () => ({ sharp: null, error: { code } });
}

export async function inspectWithSharp(sharp, filePath) {
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

export async function inspectWithoutSharp(filePath) {
  const header = Buffer.alloc(PNG_HEADER_BYTES);
  const file = await open(filePath, 'r');
  try {
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < header.length) throw new Error('Invalid PNG: file is shorter than its header');
  } finally {
    await file.close();
  }
  return parsePngHeader(header);
}

export function unavailableDecoderWarning(error) {
  return `sharp is unavailable (${error?.code ?? error?.message ?? 'not installed'}); `
    + 'corner colour and alpha checks cannot be performed.';
}

/**
 * Resolve a decoder and inspect the file with it. Returns the inspection plus
 * the decoder identity, so callers report which checks were actually possible
 * rather than inferring it.
 */
export async function inspectImage(filePath, { loadDecoder = loadSharpDecoder } = {}) {
  const { sharp, error } = await loadDecoder();
  const warnings = [];

  let inspection;
  if (sharp) {
    inspection = await inspectWithSharp(sharp, filePath);
  } else {
    inspection = await inspectWithoutSharp(filePath);
    warnings.push(unavailableDecoderWarning(error));
  }

  return {
    inspection,
    sharp,
    warnings,
    decoder: sharp ? DECODER_SHARP : DECODER_FALLBACK,
    degraded: !sharp,
  };
}
