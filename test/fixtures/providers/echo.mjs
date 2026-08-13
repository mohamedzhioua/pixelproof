/**
 * A fixture provider. Not a production adapter.
 *
 * Its only job is to prove the claim in ADR 0005: a new provider can be added
 * without editing anything under `core/`. Nothing in `core/` knows this file
 * exists — a test hands it to `discoverProviders()` with the same call the real
 * built-ins use, and it works.
 *
 * It is deliberately whole rather than a stub: a manifest with real capability
 * bounds, a detect, and a generate that produces an actual run-owned file
 * through the shared provenance helper.
 */

import { writeFile } from 'node:fs/promises';

import { prepareTarget, validateTarget } from '../../../core/artifacts/provenance.mjs';
import {
  PROTOCOL_VERSION,
  preflight,
  validateGenerateRequest,
  validateManifest,
} from '../../../core/contracts/provider.mjs';

export const id = 'echo';

export const manifest = validateManifest({
  protocol: PROTOCOL_VERSION,
  id,
  kinds: ['vector'],
  capabilities: {
    minWidth: 8,
    maxWidth: 64,
    minHeight: 8,
    maxHeight: 64,
    dimensionMultiple: 8,
    seed: true,
  },
});

export function detect() {
  return { available: true, reason: null };
}

export async function generate(rawRequest) {
  const request = validateGenerateRequest(rawRequest);
  preflight(manifest, request);

  const target = await prepareTarget(request.out);
  await writeFile(target.path, request.prompt, 'utf8');
  const status = await validateTarget(target);

  return {
    protocol: PROTOCOL_VERSION,
    ok: true,
    file: target.path,
    provider: id,
    seed: request.seed,
    warnings: [],
    meta: { produced: status.fresh },
  };
}
