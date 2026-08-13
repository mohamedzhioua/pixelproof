import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REPORT_SCHEMA,
  RUN_ID_PATTERN,
  RUN_SCHEMA,
  RUN_STATES,
  TERMINAL_STATES,
  createRun,
  finaliseRun,
  recordAttempt,
} from '../core/run/index.mjs';
import { buildResult } from '../core/verification/result.mjs';
import { removeTemporaryDirectory, temporaryDirectory } from './helpers/compat-harness.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

/**
 * Schema parity.
 *
 * `schema/*.json` is documentation that a consumer may point a validator at,
 * while `core/run/` is the implementation. This repo has no JSON Schema library
 * and is not gaining one for a document that ships as reference material, so
 * parity is asserted on the parts that would actually mislead someone if they
 * drifted: the versioned envelope names, the closed state set, the id pattern,
 * and the required keys of every document the store writes.
 *
 * This is the same relationship the existing `schema/judge-adapter.v1.json` has
 * with `core/contracts/judge.mjs`, made explicit.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSchema(name) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'schema', name), 'utf8'));
}

const runSchema = loadSchema('run.v1.json');
const reportSchema = loadSchema('report.v1.json');

test('the schema files declare the envelope names the code writes', () => {
  assert.equal(runSchema.properties.schema.const, RUN_SCHEMA);
  assert.equal(reportSchema.properties.schema.const, REPORT_SCHEMA);
  assert.equal(runSchema.$id.endsWith('/run.v1.json'), true);
  assert.equal(reportSchema.$id.endsWith('/report.v1.json'), true);
});

test('the state enum is identical in both schemas and in the state machine', () => {
  assert.deepEqual(runSchema.$defs.state.enum, [...RUN_STATES]);
  assert.deepEqual(reportSchema.$defs.state.enum, [...RUN_STATES]);
  assert.deepEqual(runSchema.$defs.outcome.properties.state.enum, [...TERMINAL_STATES]);
  assert.deepEqual(reportSchema.$defs.outcome.properties.state.enum, [...TERMINAL_STATES]);
});

test('the run id pattern is identical in both schemas and in the id module', () => {
  for (const schema of [runSchema, reportSchema]) {
    assert.equal(new RegExp(schema.$defs.runId.pattern).source, RUN_ID_PATTERN.source);
    assert.ok(schema.$defs.runId.pattern.includes('T\\d{2}-\\d{2}-\\d{2}Z'), 'the hyphenated time separator is load-bearing on Windows');
  }
});

test('both schemas tolerate unknown fields at a known major (ADR 0014 §4)', () => {
  assert.equal(runSchema.additionalProperties, true);
  assert.equal(reportSchema.additionalProperties, true);
  for (const definition of Object.values(runSchema.$defs)) {
    if (definition.type === 'object') {
      assert.equal(definition.additionalProperties, true, `${JSON.stringify(definition.title ?? '')} must tolerate additions`);
    }
  }
});

test('a real finalised run satisfies the required keys both schemas declare', async () => {
  const root = await temporaryDirectory('pixelproof-run-parity-');
  try {
    const created = await createRun({
      root: path.join(root, 'runs'),
      command: 'generate',
      pixelproofVersion: '0.0.0-test',
      resolved: { provider: 'svg' },
    });

    const source = path.join(root, 'candidate.png');
    await mkdir(root, { recursive: true });
    await writeFile(source, 'bytes');

    await recordAttempt(created.directory, {
      artifact: { path: source },
      verification: buildResult({
        file: source,
        decoder: 'none',
        degraded: true,
        checks: [{ name: 'width', expected: 1, actual: 1, passed: true, status: 'PASS' }],
      }),
    });

    const { run, report } = await finaliseRun(created.directory, { state: 'accepted', acceptedAttempt: 1 });

    for (const key of runSchema.required) {
      assert.ok(Object.hasOwn(run, key), `run.json is missing the required key ${key}`);
    }
    for (const key of reportSchema.required) {
      assert.ok(Object.hasOwn(report, key), `report.json is missing the required key ${key}`);
    }

    const [attempt] = run.attempts;
    for (const key of runSchema.$defs.attemptSummary.required) {
      assert.ok(Object.hasOwn(attempt, key), `an attempt summary is missing the required key ${key}`);
    }
    for (const key of runSchema.$defs.verificationSummary.required) {
      assert.ok(Object.hasOwn(attempt.verification, key), `a verification summary is missing the required key ${key}`);
    }
    for (const key of runSchema.$defs.artifact.required) {
      assert.ok(Object.hasOwn(attempt.artifact, key), `an artifact record is missing the required key ${key}`);
    }
    for (const key of runSchema.$defs.outcome.required) {
      assert.ok(Object.hasOwn(run.outcome, key), `the outcome is missing the required key ${key}`);
    }

    // The declared shapes, checked by hand where a validator would.
    assert.match(run.runId, new RegExp(runSchema.$defs.runId.pattern));
    assert.match(run.createdAt, new RegExp(runSchema.$defs.timestamp.pattern));
    assert.match(run.updatedAt, new RegExp(runSchema.$defs.timestamp.pattern));
    assert.match(report.generatedAt, new RegExp(reportSchema.$defs.timestamp.pattern));
    assert.match(attempt.artifact.sha256, new RegExp(runSchema.$defs.artifact.properties.sha256.pattern));
    assert.match(attempt.artifact.path, new RegExp(runSchema.$defs.relativePath.pattern));
    assert.match(attempt.files.verification, new RegExp(runSchema.$defs.relativePath.pattern));
    for (const value of Object.values(report.files)) {
      assert.match(value, new RegExp(reportSchema.$defs.relativePath.pattern));
    }
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('the relative-path pattern refuses absolute, escaping, and Windows paths', () => {
  const pattern = new RegExp(runSchema.$defs.relativePath.pattern);

  for (const good of ['run.json', 'attempt-1.png', 'nested/attempt-1.json']) {
    assert.match(good, pattern);
  }
  for (const bad of ['/etc/passwd', '../elsewhere/attempt-1.png', 'a/../../b', 'C:\\runs\\attempt-1.png']) {
    assert.doesNotMatch(bad, pattern, `${bad} must not be a legal envelope path`);
  }
});
