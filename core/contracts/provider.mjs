/**
 * Provider adapter contract (ADR 0005, ADR 0006).
 *
 * Nothing here may name a vendor. Core learns what a provider can do from its
 * manifest and nothing else; that is what lets a new provider be added without
 * editing core.
 *
 * Capability transport differs by trust class (ADR 0004) but the manifest shape
 * does not: a bundled module exports it directly, while an executable returns it
 * from a `{ protocol: 1, operation: "describe" }` handshake. One shape, one
 * meaning, two carriers.
 *
 * Unknown fields are ignored rather than rejected, so an adapter written against
 * a later revision still works with an older core. Protocol *major* mismatch is
 * always fatal — that is the field reserved for breaking changes.
 */

import { AdapterError } from './errors.mjs';

export const PROTOCOL_VERSION = 1;

/** A control message, never image bytes. Anything larger is a runaway adapter. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Retained tail of adapter stderr/stdout used for diagnostics. */
export const MAX_LOG_BYTES = 256 * 1024;

export const DESCRIBE_REQUEST = Object.freeze({ protocol: PROTOCOL_VERSION, operation: 'describe' });

// Exported for the judge manifest validator (ADR 0021 §2), which enforces the
// same id shape and the same artifact kinds over an entirely different set of
// capabilities. Two validators, one vocabulary.
export const ARTIFACT_KINDS = new Set(['raster', 'vector']);
export const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;

function invalid(message, details) {
  return new AdapterError('INVALID_REQUEST', message, { retryable: false, details: details ?? null });
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object`);
  }
  return value;
}

function requireProtocol(value, label) {
  if (value.protocol !== PROTOCOL_VERSION) {
    throw invalid(
      `${label} declares protocol ${JSON.stringify(value.protocol ?? null)}, but this build speaks protocol ${PROTOCOL_VERSION}`,
    );
  }
}

function optionalPositiveInteger(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw invalid(`${label} must be a positive integer when present`);
  }
  return value;
}

function optionalBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Normalize a manifest. Absent capability fields mean "unconstrained" rather
 * than "unsupported": a provider should not have to enumerate limits it does not
 * have, and preflight treats null as no bound.
 */
export function validateManifest(raw) {
  const manifest = requirePlainObject(raw, 'Provider manifest');
  requireProtocol(manifest, 'Provider manifest');

  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
    throw invalid('Provider manifest id must be lowercase kebab-case', { id: manifest.id ?? null });
  }

  const kinds = Array.isArray(manifest.kinds) ? manifest.kinds : [];
  if (kinds.length === 0 || !kinds.every((kind) => ARTIFACT_KINDS.has(kind))) {
    throw invalid(
      `Provider "${manifest.id}" must declare at least one kind from ${[...ARTIFACT_KINDS].join(', ')}`,
      { kinds },
    );
  }

  const capabilities = manifest.capabilities === undefined
    ? {}
    : requirePlainObject(manifest.capabilities, 'Provider capabilities');

  const normalized = {
    protocol: PROTOCOL_VERSION,
    id: manifest.id,
    kinds: [...new Set(kinds)],
    capabilities: {
      minWidth: optionalPositiveInteger(capabilities.minWidth, 'minWidth'),
      maxWidth: optionalPositiveInteger(capabilities.maxWidth, 'maxWidth'),
      minHeight: optionalPositiveInteger(capabilities.minHeight, 'minHeight'),
      maxHeight: optionalPositiveInteger(capabilities.maxHeight, 'maxHeight'),
      dimensionMultiple: optionalPositiveInteger(capabilities.dimensionMultiple, 'dimensionMultiple'),
      minPixels: optionalPositiveInteger(capabilities.minPixels, 'minPixels'),
      maxPixels: optionalPositiveInteger(capabilities.maxPixels, 'maxPixels'),
      maxAspectRatio: capabilities.maxAspectRatio === undefined || capabilities.maxAspectRatio === null
        ? null
        : positiveFinite(capabilities.maxAspectRatio, 'maxAspectRatio'),
      seed: optionalBoolean(capabilities.seed, false),
      references: optionalBoolean(capabilities.references, false),
      transparency: optionalBoolean(capabilities.transparency, false),
      negativePrompt: optionalBoolean(capabilities.negativePrompt, false),
    },
  };

  const { minWidth, maxWidth, minHeight, maxHeight, minPixels, maxPixels } = normalized.capabilities;
  assertOrdered(minWidth, maxWidth, 'minWidth', 'maxWidth', manifest.id);
  assertOrdered(minHeight, maxHeight, 'minHeight', 'maxHeight', manifest.id);
  assertOrdered(minPixels, maxPixels, 'minPixels', 'maxPixels', manifest.id);

  return normalized;
}

function positiveFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid(`${label} must be a positive finite number when present`);
  }
  return value;
}

function assertOrdered(low, high, lowLabel, highLabel, id) {
  if (low !== null && high !== null && low > high) {
    throw invalid(`Provider "${id}" declares ${lowLabel} greater than ${highLabel}`, { low, high });
  }
}

export function validateGenerateRequest(raw) {
  const request = requirePlainObject(raw, 'Generate request');
  requireProtocol(request, 'Generate request');

  if (!ARTIFACT_KINDS.has(request.kind)) {
    throw invalid(`Generate request kind must be one of ${[...ARTIFACT_KINDS].join(', ')}`);
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
    throw invalid('Generate request prompt must be a non-empty string');
  }
  if (typeof request.out !== 'string' || request.out.trim() === '') {
    throw invalid('Generate request out must be a non-empty path');
  }

  const width = optionalPositiveInteger(request.width, 'width');
  const height = optionalPositiveInteger(request.height, 'height');

  return {
    protocol: PROTOCOL_VERSION,
    kind: request.kind,
    prompt: request.prompt,
    negative: typeof request.negative === 'string' ? request.negative : null,
    width,
    height,
    out: request.out,
    seed: request.seed === undefined || request.seed === null ? null : integer(request.seed, 'seed'),
    references: normalizeStringArray(request.references, 'references'),
    attempt: request.attempt === undefined ? 1 : optionalPositiveInteger(request.attempt, 'attempt'),
    priorFailures: normalizeStringArray(request.priorFailures, 'priorFailures'),
    timeoutMs: optionalPositiveInteger(request.timeoutMs, 'timeoutMs'),
    options: request.options === undefined || request.options === null
      ? {}
      : requirePlainObject(request.options, 'Generate request options'),
  };
}

function integer(value, label) {
  if (!Number.isInteger(value)) throw invalid(`${label} must be an integer when present`);
  return value;
}

function normalizeStringArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw invalid(`${label} must be an array of strings when present`);
  }
  return [...value];
}

/**
 * Reject impossible work before it is paid for. Every bound is enforced here,
 * generically, so a provider cannot forget to apply its own declared limits and
 * so the same rules hold whether dimensions came from a flag, a spec, or a
 * default.
 */
export function preflight(manifest, request) {
  const violations = [];
  const { capabilities } = manifest;

  if (!manifest.kinds.includes(request.kind)) {
    violations.push(`does not support kind "${request.kind}" (supports ${manifest.kinds.join(', ')})`);
  }

  const { width, height } = request;
  if (width !== null && height !== null) {
    checkBound(violations, width, capabilities.minWidth, capabilities.maxWidth, 'width');
    checkBound(violations, height, capabilities.minHeight, capabilities.maxHeight, 'height');

    if (capabilities.dimensionMultiple !== null) {
      const multiple = capabilities.dimensionMultiple;
      if (width % multiple !== 0 || height % multiple !== 0) {
        violations.push(`requires both edges to be multiples of ${multiple}, got ${width}x${height}`);
      }
    }

    const pixels = width * height;
    checkBound(violations, pixels, capabilities.minPixels, capabilities.maxPixels, 'total pixels');

    if (capabilities.maxAspectRatio !== null) {
      const ratio = Math.max(width, height) / Math.min(width, height);
      if (ratio > capabilities.maxAspectRatio + 1e-9) {
        violations.push(
          `requires a long-to-short ratio of at most ${capabilities.maxAspectRatio}, got ${ratio.toFixed(4)}`,
        );
      }
    }
  }

  if (request.seed !== null && !capabilities.seed) {
    violations.push('does not support a fixed seed');
  }
  if (request.references.length > 0 && !capabilities.references) {
    violations.push('does not support reference images');
  }
  if (request.negative !== null && !capabilities.negativePrompt) {
    violations.push('does not support a negative prompt');
  }

  if (violations.length > 0) {
    throw invalid(`Provider "${manifest.id}" ${violations.join('; ')}`, { violations });
  }
  return true;
}

function checkBound(violations, value, min, max, label) {
  if (min !== null && value < min) violations.push(`requires ${label} of at least ${min}, got ${value}`);
  if (max !== null && value > max) violations.push(`requires ${label} of at most ${max}, got ${value}`);
}

/**
 * Parse an adapter's reply. `expectedOut` is compared because an adapter that
 * writes somewhere other than the requested path has not satisfied the request,
 * however successful it claims to be.
 */
export function parseGenerateResponse(raw, { expectedOut } = {}) {
  const response = requirePlainObject(raw, 'Generate response');
  requireProtocol(response, 'Generate response');

  if (response.ok !== true && response.ok !== false) {
    throw invalid('Generate response ok must be a boolean');
  }

  if (response.ok === false) {
    return { ok: false, error: requirePlainObject(response.error, 'Generate response error') };
  }

  if (typeof response.file !== 'string' || response.file.trim() === '') {
    throw invalid('A successful generate response must name the file it wrote');
  }
  if (expectedOut !== undefined && response.file !== expectedOut) {
    throw invalid('Adapter wrote a different path than requested', {
      requested: expectedOut,
      reported: response.file,
    });
  }

  return {
    ok: true,
    file: response.file,
    provider: typeof response.provider === 'string' ? response.provider : null,
    model: typeof response.model === 'string' ? response.model : null,
    seed: Number.isInteger(response.seed) ? response.seed : null,
    durationMs: Number.isInteger(response.durationMs) ? response.durationMs : null,
    warnings: Array.isArray(response.warnings)
      ? response.warnings.filter((entry) => typeof entry === 'string')
      : [],
    meta: response.meta === null || typeof response.meta !== 'object' || Array.isArray(response.meta)
      ? {}
      : response.meta,
  };
}
