/**
 * Artifact provenance and freshness (ADR 0008).
 *
 * A run owns its target. Existence alone proves nothing: a file at the output
 * path may have been sitting there since last week, and adopting it would let a
 * failed run report success on stale content. That was the v0.1.2 bug. The
 * v0.1.1 bug was narrower and more instructive — the freshness rule existed, but
 * only on one of the two paths that could produce a target, so the direct write
 * was checked and the recovered file was not.
 *
 * The lesson is encoded structurally here: `artifactStatus()` is the only place
 * that decides whether a file counts as produced, and every other export in this
 * module routes through it. A caller cannot apply the rule to one path and
 * forget it on another, because there is no second implementation to forget.
 *
 * Nothing in this module names a vendor, a provider, or a file format. It deals
 * in a target path, a run start time, and candidate files.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A file that exists and was written at or after the run started. */
export const PRODUCED = 'produced';

/** A file that exists but predates the run. Never adopted; never deleted here. */
export const STALE = 'stale';

/** No file at the path at all. */
export const MISSING = 'missing';

/**
 * The single freshness decision. Everything else in this module calls it.
 *
 * `notBefore` is a millisecond timestamp captured before the producing work
 * began. The comparison is inclusive because a file written in the same
 * millisecond the run started is still a product of the run.
 *
 * `notBefore` must come from `runReference()` — the same clock and filesystem
 * that will stamp the file being judged. See that function for why `Date.now()`
 * is the wrong reference.
 *
 * @param {string} filePath
 * @param {number} notBefore
 * @returns {Promise<{exists: boolean, fresh: boolean, mtimeMs: number|null, state: string}>}
 */
export async function artifactStatus(filePath, notBefore) {
  if (!Number.isFinite(notBefore)) {
    throw new TypeError('artifactStatus requires a numeric run start timestamp');
  }

  try {
    const stats = await stat(filePath);
    const fresh = stats.mtimeMs >= notBefore;
    return {
      exists: true,
      fresh,
      mtimeMs: stats.mtimeMs,
      state: fresh ? PRODUCED : STALE,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, fresh: false, mtimeMs: null, state: MISSING };
    }
    throw error;
  }
}

/**
 * Sample the run-start reference from the clock that will stamp the artifacts.
 *
 * `Date.now()` is the wrong reference, and this is a correctness bug rather than
 * a test flake. Linux stamps inode timestamps from a coarse, tick-granular clock
 * (`current_time()` reads the cached `coarse` time, advanced once per timer
 * tick — up to ~4ms at CONFIG_HZ_250, more on a loaded or virtualised host),
 * while `Date.now()` reads the fine-grained clock. The coarse clock therefore
 * *lags*: a file genuinely written after `Date.now()` was read can carry an
 * mtime from before it. Comparing the two clocks makes a legitimately fresh
 * artifact look stale, and the product then reports failure for a run that
 * actually succeeded. (The v0.1.1 bug was the mirror image: a stale file
 * accepted. Both come from asking the freshness question of the wrong clock.)
 *
 * The fix is to take both sides of the comparison from one source: write a
 * marker file in the directory the artifact will land in and use *its* mtime.
 * Marker and artifact are stamped by the same clock and the same filesystem, so
 * the ordering that matters ("was this written after the run started?") is
 * decided by timestamps that are actually comparable. No tolerance is involved,
 * so the guarantee that a days-old file is rejected is untouched.
 *
 * Granularity truncation is safe in this direction too: whatever a filesystem
 * rounds mtimes to, it rounds the marker the same way, and the artifact is
 * written later, so its stamp is greater or equal. Equality is fine — the
 * comparison is inclusive.
 *
 * The reference is only valid for the filesystem it was sampled on. A caller
 * that later judges files under a *different* mount (the Codex recovery scan
 * reads `$CODEX_HOME/generated_images`, which need not share a mount with the
 * output directory) must sample that mount separately at run start; a
 * reference borrowed across mounts reintroduces exactly this bug whenever the
 * two disagree on granularity or, for a network filesystem, on clock.
 *
 * When the directory cannot be written (it does not exist, or is read-only)
 * there is nothing to sample and the caller's `fallback` is used, reported as
 * `source: 'clock'` so the weaker basis is visible rather than silent.
 *
 * @param {string} directory
 * @param {{fallback?: number}} [options]
 * @returns {Promise<{ms: number, source: 'filesystem'|'clock'}>}
 */
export async function runReference(directory, { fallback = Date.now() } = {}) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('runReference requires a directory path');
  }

  const marker = path.join(directory, `.pixelproof-run-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(marker, '');
    const stats = await stat(marker);
    return { ms: stats.mtimeMs, source: 'filesystem' };
  } catch {
    return { ms: fallback, source: 'clock' };
  } finally {
    // Best effort: the marker is a probe, and a leftover probe is noise, not a
    // correctness problem.
    await unlink(marker).catch(() => {});
  }
}

/**
 * Claim a target for a run: resolve it, make sure its directory exists, and
 * stamp the run start time that every later freshness question is asked against.
 *
 * The stamp is sampled with `runReference()` from the target's own directory,
 * so the run start and the artifact mtimes come from one clock. An explicit
 * `startedAt` is still accepted for callers that already hold a reference from
 * this filesystem; it is not validated for provenance, only for being a number.
 *
 * The returned handle is frozen so the start time cannot drift after the fact —
 * a mutable `startedAt` is a freshness check that can be argued out of failing.
 *
 * @param {string} outPath
 * @param {{startedAt?: number, createDirectory?: boolean}} [options]
 */
export async function prepareTarget(outPath, { startedAt, createDirectory = true } = {}) {
  if (typeof outPath !== 'string' || outPath.trim() === '') {
    throw new TypeError('prepareTarget requires a non-empty output path');
  }
  if (startedAt !== undefined && !Number.isFinite(startedAt)) {
    throw new TypeError('prepareTarget requires a numeric run start timestamp when one is given');
  }

  const file = path.resolve(outPath);
  const directory = path.dirname(file);
  if (createDirectory) await mkdir(directory, { recursive: true });

  const reference = startedAt === undefined
    ? await runReference(directory)
    : { ms: startedAt, source: 'caller' };

  // Recorded for diagnostics only. Whether the target counts as produced is
  // always decided after the run, from the post-run status.
  const preexisting = await artifactStatus(file, reference.ms);

  return Object.freeze({
    path: file,
    directory,
    filename: path.basename(file),
    startedAt: reference.ms,
    startedAtSource: reference.source,
    preexisting,
  });
}

/**
 * Post-run validation of a prepared target. Returns the status; it does not
 * throw on a stale or missing target, because what to say about that is the
 * caller's presentation concern.
 *
 * @param {{path: string, startedAt: number}} target
 */
export async function validateTarget(target) {
  if (!target || typeof target.path !== 'string') {
    throw new TypeError('validateTarget requires a prepared target');
  }
  const status = await artifactStatus(target.path, target.startedAt);
  return { ...status, path: target.path, startedAt: target.startedAt };
}

/**
 * Find files under `roots` that were written at or after `notBefore`.
 *
 * Freshness comes from `artifactStatus`, the same function that judges the
 * target, so a recovery candidate can never be held to a weaker standard than a
 * direct write. Missing roots are not an error — a provider that has never run
 * has no session directory.
 *
 * `notBefore` must have been sampled (via `runReference`) on the filesystem
 * holding `roots`, which is not necessarily the one holding the target.
 *
 * @param {{roots: string[], notBefore: number, accept?: (entry: {name: string, path: string}) => boolean}} options
 * @returns {Promise<Array<{path: string, mtimeMs: number}>>} newest first
 */
export async function collectFreshArtifacts({ roots, notBefore, accept = () => true }) {
  if (!Array.isArray(roots)) throw new TypeError('collectFreshArtifacts requires an array of roots');

  const pending = roots.map((root) => path.resolve(root));
  const seen = new Set();
  const candidates = [];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (seen.has(directory)) continue;
    seen.add(directory);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }

    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!accept({ name: entry.name, path: filePath })) continue;

      const status = await artifactStatus(filePath, notBefore);
      if (status.fresh) candidates.push({ path: filePath, mtimeMs: status.mtimeMs });
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.path < right.path ? -1 : 1));
  return candidates;
}

/**
 * Choose at most one candidate.
 *
 * `newest` preserves the behaviour v1 shipped. `reject` is the stricter reading
 * of ADR 0008: more than one fresh candidate means the run cannot prove which
 * one is its own, and an unprovable artifact is not an artifact. Callers pick,
 * so the tightening can be turned on per provider rather than repo-wide.
 *
 * @param {Array<{path: string, mtimeMs: number}>} candidates
 * @param {{policy?: 'newest'|'reject'}} [options]
 */
export function selectArtifact(candidates, { policy = 'newest' } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const ambiguous = list.length > 1;

  if (list.length === 0) return { path: null, ambiguous: false, candidates: list };
  if (ambiguous && policy === 'reject') return { path: null, ambiguous: true, candidates: list };
  return { path: list[0].path, ambiguous, candidates: list };
}

/**
 * Move a proven-fresh artifact onto the run's target and re-validate it there.
 *
 * A cross-device rename is the one failure worth handling: the copy-then-unlink
 * fallback keeps recovery working when the provider's scratch space is on
 * another volume. Validation is repeated after the move rather than inherited
 * from the source, because the file on the target path is the only thing the
 * caller will go on to use.
 *
 * @param {{source: string, target: {path: string, startedAt: number}}} options
 */
export async function adoptArtifact({ source, target }) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new TypeError('adoptArtifact requires a source path');
  }
  if (!target || typeof target.path !== 'string') {
    throw new TypeError('adoptArtifact requires a prepared target');
  }

  try {
    await rename(source, target.path);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await copyFile(source, target.path);
    await unlink(source);
  }

  return validateTarget(target);
}
