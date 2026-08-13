/**
 * The v1 spec shape: a JSON object carrying an optional `mechanical` block and
 * an optional `semantic` array of strings.
 *
 * Validation lives here rather than in the CLI because both the generator and
 * the verifier have to agree on what a spec *is* before either can act on one.
 * The rejection messages are frozen public surface (ADR 0003) and must not
 * drift: they are what a user sees when a spec is malformed.
 */

import { readFile } from 'node:fs/promises';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function assertV1Spec(spec) {
  if (!isPlainObject(spec)) {
    throw new Error('The spec root must be a JSON object');
  }
  if (spec.mechanical !== undefined && !isPlainObject(spec.mechanical)) {
    throw new Error('spec.mechanical must be an object when present');
  }
  if (spec.semantic !== undefined
    && (!Array.isArray(spec.semantic) || spec.semantic.some((item) => typeof item !== 'string'))) {
    throw new Error('spec.semantic must be an array of strings when present');
  }
  return spec;
}

/**
 * An absent block is an empty one. A spec declares what it cares about, so
 * callers can read `mechanicalBlock(spec)` without a null dance and without
 * inventing requirements nobody asked for.
 */
export function mechanicalBlock(spec) {
  return spec?.mechanical ?? {};
}

export function semanticAssertions(spec) {
  return spec?.semantic ?? [];
}

/**
 * Read and validate a spec file. The JSON parse and the file read are left
 * unwrapped on purpose: their native messages (syntax position, ENOENT path)
 * are what v1 surfaced, and wrapping them would change frozen output.
 */
export async function loadV1Spec(specPath) {
  return assertV1Spec(JSON.parse(await readFile(specPath, 'utf8')));
}

/**
 * The "size without a spec" rule: a requested size *is* a mechanical spec of
 * exactly two checks, which is why `--size` alone can still fail a run.
 */
export function specFromSize({ width, height }) {
  return { mechanical: { width, height } };
}
