/**
 * One attempt: invoke a generator, then optionally verify what it produced.
 *
 * This is the whole v1 loop — there is no retake, no evidence directory and no
 * scoring yet, and adding any of them here before the adapter runtime exists
 * would be inventing behavior the CLI does not have.
 *
 * The generator and the verifier are both injected. Core must never reach for a
 * vendor (ADR 0002), and injection is also what lets a test drive the sequence
 * without a provider binary on PATH.
 */

/**
 * @param {object} options
 * @param {(request: object) => Promise<object>} options.generate Provider call.
 * @param {object} options.request Provider-shaped request; passed through as-is.
 * @param {((generation: object) => Promise<unknown>|unknown)} [options.onGenerated]
 *   Observer run after generation and before verification. It exists so a
 *   surface can report the produced artifact in the order v1 reported it, even
 *   when verification later throws.
 * @param {((generation: object) => Promise<object|null>|object|null)} [options.verify]
 *   Optional verification. `null`/absent means the run declared nothing to
 *   check; returning `null` means verification did not apply to this artifact.
 * @returns {Promise<{generation: object, verification: object|null, ok: boolean}>}
 */
export async function runOnce({ generate, request, onGenerated = null, verify = null }) {
  if (typeof generate !== 'function') {
    throw new TypeError('runOnce requires a generate function');
  }

  const generation = await generate(request);
  if (onGenerated) await onGenerated(generation);

  const verification = verify ? await verify(generation) : null;

  // An unverified run is not a failed run: v1 exits 0 when nothing was declared
  // to check. Only a verification that ran and failed changes the outcome.
  return { generation, verification, ok: verification ? verification.ok === true : true };
}
