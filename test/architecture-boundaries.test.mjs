import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Architecture boundary tests.
 *
 * These read the source tree as it exists at run time rather than checking a
 * hardcoded file list, so a newly added directory under `core/` is covered the
 * moment it lands. Nothing here spawns a process or touches the network.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.pixelproof-scratch']);

/** Extensions we treat as JavaScript module sources. */
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);

/**
 * Layers `core/` is forbidden to reach into. Dependency direction is one-way
 * (ADR 0002): outer layers may import the core, never the reverse.
 */
const FORBIDDEN_FROM_CORE = Object.freeze(['scripts', 'providers', 'surfaces']);

/**
 * Vendor names that must never appear inside `core/contracts/`. Matched with
 * word boundaries so an unrelated identifier that merely contains these letters
 * does not fail the build; a real vendor mention is always a whole word.
 */
const VENDOR_NAMES = Object.freeze([
  'codex',
  'openai',
  'gemini',
  'google',
  'claude',
  'anthropic',
  'xai',
  'grok',
  'sharp',
]);

/**
 * Walks `dir` recursively and returns repo-relative POSIX paths of every file,
 * skipping the directories that are not source.
 */
function walk(dir) {
  const found = [];
  let entries;

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw error;
  }

  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) continue;

    const absolute = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      isDirectory = stats.isDirectory();
      isFile = stats.isFile();
    }

    if (isDirectory) {
      found.push(...walk(absolute));
    } else if (isFile) {
      found.push(path.relative(REPO_ROOT, absolute).split(path.sep).join('/'));
    }
  }

  return found;
}

/**
 * Extracts every module specifier a source file references: static
 * `import`/`export ... from`, bare side-effect `import`, dynamic `import()`,
 * and CommonJS `require()`.
 */
function moduleSpecifiers(source) {
  const patterns = [
    /\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g,
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
  ];

  const specifiers = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[2]);
    }
  }

  return [...specifiers];
}

/**
 * Resolves a specifier to the repo-relative top-level directory it lands in, or
 * `null` when it is an external/builtin package that cannot cross a boundary.
 */
function topLevelTargetOf(specifier, importerRelativePath) {
  if (specifier.startsWith('node:') || specifier.startsWith('data:')) return null;

  if (specifier.startsWith('.')) {
    const importerDir = path.dirname(path.join(REPO_ROOT, importerRelativePath));
    const resolved = path.resolve(importerDir, specifier);
    const relative = path.relative(REPO_ROOT, resolved).split(path.sep).join('/');
    if (relative.startsWith('..')) return null;
    return relative.split('/')[0];
  }

  if (specifier.startsWith('/')) return null;

  // A bare specifier such as `scripts/foo.mjs` would only resolve via an import
  // map or a self-reference, but treat it as a boundary crossing regardless.
  return specifier.split('/')[0];
}

/**
 * Layers `surfaces/` is forbidden to reach into. `scripts/` is the v1
 * compatibility façade and is due for deletion; a surface that imports it makes
 * the new layer depend on the old one, which is the inversion ADR 0002 exists to
 * prevent. Surfaces reach `providers/` and `core/` directly.
 */
const FORBIDDEN_FROM_SURFACES = Object.freeze(['scripts']);

const coreFiles = walk(path.join(REPO_ROOT, 'core'));
const surfaceFiles = walk(path.join(REPO_ROOT, 'surfaces'));

test('core/ exists and contains source files (guards against a vacuous pass)', () => {
  assert.ok(
    coreFiles.some((file) => SOURCE_EXTENSIONS.has(path.extname(file))),
    'expected at least one JavaScript source file under core/',
  );
});

test('no file under core/ imports scripts/, providers/, or surfaces/', () => {
  const violations = [];

  for (const file of coreFiles) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;

    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const specifier of moduleSpecifiers(source)) {
      const target = topLevelTargetOf(specifier, file);
      if (target !== null && FORBIDDEN_FROM_CORE.includes(target)) {
        violations.push(`${file} -> ${specifier} (resolves into ${target}/)`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `core/ must not depend on outer layers (ADR 0002):\n${violations.join('\n')}`,
  );
});

test('surfaces/ exists and contains source files (guards against a vacuous pass)', () => {
  assert.ok(
    surfaceFiles.some((file) => SOURCE_EXTENSIONS.has(path.extname(file))),
    'expected at least one JavaScript source file under surfaces/',
  );
});

test('no file under surfaces/ imports scripts/', () => {
  const violations = [];

  for (const file of surfaceFiles) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;

    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const specifier of moduleSpecifiers(source)) {
      const target = topLevelTargetOf(specifier, file);
      if (target !== null && FORBIDDEN_FROM_SURFACES.includes(target)) {
        violations.push(`${file} -> ${specifier} (resolves into ${target}/)`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    'surfaces/ must not depend on the v1 compatibility façade in scripts/ '
      + `(ADR 0002); import providers/ or core/ directly:\n${violations.join('\n')}`,
  );
});

test('no file under core/contracts/ mentions a vendor name', () => {
  const contractFiles = walk(path.join(REPO_ROOT, 'core', 'contracts'));

  assert.ok(contractFiles.length > 0, 'expected core/contracts/ to contain files');

  const violations = [];

  for (const file of contractFiles) {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const vendor of VENDOR_NAMES) {
      const pattern = new RegExp(`\\b${vendor}\\b`, 'i');
      const match = pattern.exec(source);
      if (match) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${file}:${line} mentions "${match[0]}"`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `core/contracts/ must stay vendor-neutral:\n${violations.join('\n')}`,
  );
});

test('package.json declares zero required runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  const required = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(
    required,
    [],
    `package.json must declare no required dependencies, found: ${required.join(', ')}`,
  );

  assert.ok(
    Object.hasOwn(manifest.optionalDependencies ?? {}, 'sharp'),
    'sharp must remain declared under optionalDependencies',
  );

  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    assert.ok(
      !Object.hasOwn(manifest[field] ?? {}, 'sharp'),
      `sharp must not appear in ${field}; it is optional only`,
    );
  }
});

test('every .json file under schema/ parses', () => {
  const schemaFiles = walk(path.join(REPO_ROOT, 'schema')).filter(
    (file) => path.extname(file) === '.json',
  );

  assert.ok(schemaFiles.length > 0, 'expected at least one JSON schema under schema/');

  for (const file of schemaFiles) {
    const raw = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), `${file} is not valid JSON`);
  }
});
