/**
 * SVG: a trusted built-in provider adapter (ADR 0004, ADR 0005).
 *
 * The provider's source is markup, not a text prompt, so a generate request
 * carries it in `options.svgText`. `prompt` is accepted as a fallback because
 * the contract requires a non-empty prompt and a caller that has only the
 * markup should not have to duplicate it.
 *
 * This file owns the implementation: the XML validator, the writer, and the
 * optional `sharp` rasterisation. `scripts/providers/svg.mjs` is now a
 * re-export shim over it, so the dependency direction runs
 * `surfaces → providers → core` as ADR 0002 requires, rather than the new layer
 * reaching back into the v1 façade.
 *
 * The characterization test that proves the degraded no-`sharp` path copies
 * this file to a temporary directory and imports the copy, so `sharp` genuinely
 * cannot resolve. That still works after the inversion because the harness
 * (`isolateModule`) copies the layers this module imports — `core/` — alongside
 * it, preserving layout; it is the same mechanism the verifier already used.
 * Nothing here may grow an import of `scripts/` or `surfaces/`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AdapterError } from '../core/contracts/errors.mjs';
import {
  PROTOCOL_VERSION,
  preflight,
  validateGenerateRequest,
  validateManifest,
} from '../core/contracts/provider.mjs';

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const VALID_ENTITY = /&(?:amp|lt|gt|apos|quot|#\d+|#x[0-9A-Fa-f]+);/g;

function assertEntities(value, context) {
  if (value.replace(VALID_ENTITY, '').includes('&')) {
    throw new Error(`SVG contains an invalid or undefined entity in ${context}`);
  }
}

function findTagEnd(source, start) {
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function parseAttributes(source, elementName) {
  const attributes = new Map();
  let position = 0;

  while (position < source.length) {
    while (/\s/.test(source[position] ?? '')) position += 1;
    if (position >= source.length) break;

    const nameMatch = source.slice(position).match(XML_NAME);
    if (!nameMatch) {
      throw new Error(`Malformed attribute on <${elementName}>`);
    }
    const name = nameMatch[0];
    position += name.length;
    while (/\s/.test(source[position] ?? '')) position += 1;
    if (source[position] !== '=') {
      throw new Error(`Attribute ${name} on <${elementName}> is missing '='`);
    }
    position += 1;
    while (/\s/.test(source[position] ?? '')) position += 1;

    const quote = source[position];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Attribute ${name} on <${elementName}> must use quotes`);
    }
    position += 1;
    const valueEnd = source.indexOf(quote, position);
    if (valueEnd === -1) {
      throw new Error(`Attribute ${name} on <${elementName}> has no closing quote`);
    }
    const value = source.slice(position, valueEnd);
    if (value.includes('<')) {
      throw new Error(`Attribute ${name} on <${elementName}> contains an unescaped '<'`);
    }
    assertEntities(value, `attribute ${name}`);
    if (attributes.has(name)) {
      throw new Error(`Duplicate attribute ${name} on <${elementName}>`);
    }
    attributes.set(name, value);
    position = valueEnd + 1;
  }

  return attributes;
}

function validateViewBox(value) {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('The root <svg> viewBox must contain four finite numbers');
  }
  if (parts[2] <= 0 || parts[3] <= 0) {
    throw new Error('The root <svg> viewBox width and height must be greater than zero');
  }
}

export function validateSvgXml(svgText) {
  if (typeof svgText !== 'string' || svgText.trim() === '') {
    throw new Error('SVG input is empty');
  }

  const source = svgText.replace(/^\uFEFF/, '');
  const stack = [];
  let position = 0;
  let root = null;
  let rootClosed = false;

  while (position < source.length) {
    const tagStart = source.indexOf('<', position);
    const textEnd = tagStart === -1 ? source.length : tagStart;
    const text = source.slice(position, textEnd);
    assertEntities(text, 'text content');
    if (stack.length === 0 && text.trim() !== '') {
      throw new Error('SVG has text outside its root element');
    }
    if (tagStart === -1) break;

    if (source.startsWith('<!--', tagStart)) {
      const commentEnd = source.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) throw new Error('SVG contains an unclosed XML comment');
      const comment = source.slice(tagStart + 4, commentEnd);
      if (comment.includes('--')) throw new Error('SVG contains an invalid XML comment');
      position = commentEnd + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', tagStart)) {
      if (stack.length === 0) throw new Error('CDATA is not allowed outside the root element');
      const cdataEnd = source.indexOf(']]>', tagStart + 9);
      if (cdataEnd === -1) throw new Error('SVG contains an unclosed CDATA section');
      position = cdataEnd + 3;
      continue;
    }
    if (source.startsWith('<?', tagStart)) {
      const instructionEnd = source.indexOf('?>', tagStart + 2);
      if (instructionEnd === -1) throw new Error('SVG contains an unclosed processing instruction');
      position = instructionEnd + 2;
      continue;
    }
    if (source.startsWith('<!', tagStart)) {
      throw new Error('DOCTYPE and other XML declarations are not allowed in SVG input');
    }

    const tagEnd = findTagEnd(source, tagStart + 1);
    if (tagEnd === -1) throw new Error('SVG contains an unclosed element tag');
    let tagBody = source.slice(tagStart + 1, tagEnd).trim();

    if (tagBody.startsWith('/')) {
      const closingName = tagBody.slice(1).trim();
      if (!XML_NAME.test(closingName) || closingName.match(XML_NAME)?.[0] !== closingName) {
        throw new Error(`Malformed closing tag </${closingName}>`);
      }
      const openName = stack.pop();
      if (!openName || openName !== closingName) {
        throw new Error(`Closing tag </${closingName}> does not match <${openName ?? 'none'}>`);
      }
      if (stack.length === 0) rootClosed = true;
      position = tagEnd + 1;
      continue;
    }

    const selfClosing = tagBody.endsWith('/');
    if (selfClosing) tagBody = tagBody.slice(0, -1).trimEnd();
    const nameMatch = tagBody.match(XML_NAME);
    if (!nameMatch) throw new Error('SVG contains a malformed opening tag');
    const elementName = nameMatch[0];
    const attributes = parseAttributes(tagBody.slice(elementName.length), elementName);

    if (stack.length === 0) {
      if (root || rootClosed) throw new Error('SVG must contain exactly one root element');
      root = { name: elementName, attributes };
    }
    if (!selfClosing) {
      stack.push(elementName);
    } else if (stack.length === 0) {
      rootClosed = true;
    }
    position = tagEnd + 1;
  }

  if (stack.length > 0) {
    throw new Error(`SVG has an unclosed <${stack[stack.length - 1]}> element`);
  }
  if (!root || !rootClosed) {
    throw new Error('SVG must contain one complete root element');
  }
  if (root.name !== 'svg') {
    throw new Error(`SVG root element must be <svg>, not <${root.name}>`);
  }
  const viewBox = root.attributes.get('viewBox');
  if (!viewBox) {
    throw new Error('The root <svg> element must declare a viewBox');
  }
  validateViewBox(viewBox);

  return { viewBox };
}

async function loadSharp() {
  try {
    const imported = await import('sharp');
    return { sharp: imported.default, error: null };
  } catch (error) {
    return { sharp: null, error };
  }
}

function svgCompanionPath(pngPath) {
  return pngPath.slice(0, -path.extname(pngPath).length) + '.svg';
}

export async function generateWithSvg({ svgText, outPath, width, height }) {
  const validation = validateSvgXml(svgText);
  const targetPath = path.resolve(outPath);
  const extension = path.extname(targetPath).toLowerCase();
  if (extension !== '.svg' && extension !== '.png') {
    throw new Error('The SVG provider output must end in .svg or .png');
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  const svgPath = extension === '.svg' ? targetPath : svgCompanionPath(targetPath);
  await writeFile(svgPath, svgText, 'utf8');

  const warnings = [];
  let pngPath = null;
  if (extension === '.png') {
    const { sharp, error: sharpError } = await loadSharp();
    if (!sharp) {
      warnings.push(
        `sharp is unavailable (${sharpError?.code ?? sharpError?.message ?? 'not installed'}); `
          + `wrote the validated SVG to ${svgPath} but could not rasterise ${targetPath}.`,
      );
    } else {
      let pipeline = sharp(Buffer.from(svgText));
      if (width && height) {
        pipeline = pipeline.resize(width, height, { fit: 'fill' });
      }
      await pipeline.png().toFile(targetPath);
      pngPath = targetPath;
    }
  }

  return {
    provider: 'svg',
    outputPath: extension === '.png' ? (pngPath ?? svgPath) : svgPath,
    svgPath,
    pngPath,
    viewBox: validation.viewBox,
    warnings,
  };
}

export const id = 'svg';

export const manifest = validateManifest({
  protocol: PROTOCOL_VERSION,
  id,
  // Vector always; raster only when `sharp` is installed. The manifest declares
  // the provider's ambition and the run reports the degradation, because a
  // capability record that changed shape with an optional dependency would make
  // preflight results irreproducible across machines.
  kinds: ['vector', 'raster'],
  capabilities: {
    // Markup has no intrinsic pixel bounds; rasterisation scales to whatever is
    // asked for, so declaring limits here would invent constraints that do not
    // exist.
    transparency: true,
    seed: false,
    references: false,
    negativePrompt: false,
  },
});

/** Always available: it is markup and the standard library. */
export function detect() {
  return { available: true, reason: null };
}

function sourceMarkup(request) {
  const fromOptions = request.options?.svgText;
  if (typeof fromOptions === 'string' && fromOptions.trim() !== '') return fromOptions;
  return request.prompt;
}

/**
 * Contract entry point (ADR 0005). Rasterisation may be unavailable, which is
 * reported as a warning on a successful response rather than as a failure — the
 * validated vector was still produced, and v1's callers depend on that
 * distinction.
 */
export async function generate(rawRequest) {
  const request = validateGenerateRequest(rawRequest);
  preflight(manifest, request);

  const extension = path.extname(request.out).toLowerCase();
  if ((request.kind === 'vector' && extension !== '.svg')
    || (request.kind === 'raster' && extension !== '.png')) {
    throw new AdapterError(
      'INVALID_REQUEST',
      `Provider "${id}" cannot write kind "${request.kind}" to "${extension || 'no extension'}"`,
      { retryable: false, details: { kind: request.kind, out: request.out } },
    );
  }

  const startedAt = Date.now();
  try {
    const result = await generateWithSvg({
      svgText: sourceMarkup(request),
      outPath: request.out,
      width: request.width,
      height: request.height,
    });

    if (result.outputPath !== path.resolve(request.out)) {
      // v1's CLI reports this as success with a warning. The contract cannot:
      // an adapter that wrote a different path than it was asked for has not
      // satisfied the request, and `parseGenerateResponse` would reject the
      // claim anyway. The validated vector is left on disk and named in the
      // details rather than silently discarded.
      throw new AdapterError(
        'PROVIDER_UNAVAILABLE',
        result.warnings[0] ?? `Provider "${id}" could not write ${request.out}`,
        { retryable: false, details: { wrote: result.outputPath, requested: request.out } },
      );
    }

    return {
      protocol: PROTOCOL_VERSION,
      ok: true,
      file: result.outputPath,
      provider: id,
      model: null,
      durationMs: Date.now() - startedAt,
      warnings: [...result.warnings],
      meta: { viewBox: result.viewBox, svgPath: result.svgPath, pngPath: result.pngPath },
    };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    // Malformed markup is the caller's input, not an internal fault.
    throw new AdapterError('INVALID_REQUEST', error?.message ?? String(error), {
      retryable: false,
      details: { provider: id },
      cause: error,
    });
  }
}
