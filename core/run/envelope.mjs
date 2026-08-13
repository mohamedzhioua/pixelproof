/**
 * Persisted envelope versioning (ADR 0014 §1).
 *
 * `schema: "<envelope>/<major>"`. One integer, no minor, because a minor is only
 * useful to a reader that can behave differently on it: additive change needs no
 * signal and anything a reader must notice is a major.
 *
 * The read rule is exact-major-or-refuse. A half-understood run record is worse
 * than no run record — it is a silent wrong result wearing the costume of
 * forward compatibility — so an unknown name or major raises
 * `RUN_SCHEMA_UNSUPPORTED` rather than being parsed best-effort.
 *
 * Unknown *fields* at a known major are tolerated (ADR 0014 §4). That is the
 * opposite of the adapter boundary's policy in ADR 0006, deliberately: an
 * adapter message is input from a process we do not control, where an ignored
 * field may be an ignored instruction, while these files are our own output and
 * a consumer that hard-failed on a newly added field would make every upgrade a
 * breaking change.
 */

import { RunError } from './errors.mjs';

export const RUN_SCHEMA = 'pixelproof.run/1';
export const REPORT_SCHEMA = 'pixelproof.report/1';
export const ATTEMPT_SCHEMA = 'pixelproof.attempt/1';

/** Envelopes this build writes and reads. ADR 0009 owns the judge round files. */
export const SUPPORTED_SCHEMAS = Object.freeze([RUN_SCHEMA, REPORT_SCHEMA, ATTEMPT_SCHEMA]);

/** Split `"pixelproof.run/1"` into its parts, or return null if it is not one. */
export function parseSchema(value) {
  if (typeof value !== 'string') return null;
  const match = /^([a-z0-9.-]+)\/(\d+)$/.exec(value);
  if (!match) return null;
  return { name: match[1], major: Number(match[2]) };
}

export function isSupportedSchema(value) {
  return SUPPORTED_SCHEMAS.includes(value);
}

/**
 * Assert that a loaded document declares exactly the envelope expected.
 *
 * Both halves of a mismatch are named separately: a *different* envelope means
 * something read the wrong file, while a *newer major* means this build is
 * older than the run it found. ADR 0014 §7 requires the second to be survivable
 * — a repository may hold several majors at once.
 */
export function assertSchema(document, expected, { file = null } = {}) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new RunError('RUN_SCHEMA_UNSUPPORTED', `${file ?? 'Document'} is not a JSON object`, {
      details: { file, expected },
    });
  }

  const declared = document.schema;
  if (declared === expected) return expected;

  const parsedExpected = parseSchema(expected);
  const parsedDeclared = parseSchema(declared);

  const because = parsedDeclared === null
    ? 'it declares no recognisable schema'
    : parsedDeclared.name !== parsedExpected.name
      ? `it is a ${parsedDeclared.name} envelope`
      : `this build speaks ${parsedExpected.name} major ${parsedExpected.major}, the file is major ${parsedDeclared.major}`;

  throw new RunError(
    'RUN_SCHEMA_UNSUPPORTED',
    `Refusing to read ${file ?? 'document'} as ${expected}: ${because}`,
    { details: { file, expected, declared: declared ?? null, supported: [...SUPPORTED_SCHEMAS] } },
  );
}
