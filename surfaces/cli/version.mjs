/**
 * The version, read from the manifest, in one place.
 *
 * `pixelproof --version` was the only caller until ADR 0009 gave the pending
 * record a `pixelproofVersion` field, which a run directory keeps for as long as
 * the evidence is retained. Two readers means the rule that mattered when this
 * was a private helper in `main.mjs` matters more now, not less: never hardcode
 * the version in a second place, because the second place is the one that goes
 * stale and it is stamped into files people keep.
 */

import { readFile } from 'node:fs/promises';

export async function readVersion() {
  const manifestUrl = new URL('../../package.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  return manifest.version;
}

export default readVersion;
