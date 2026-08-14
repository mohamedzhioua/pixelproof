/**
 * The judge registry, the judge manifest validator, and the panel (ADR 0021).
 *
 * These are unit tests over `core/`, so nothing here spawns a vendor CLI or
 * touches the network. What they are for is the *rules*: which registrations are
 * refused, which ids may coexist, and what a panel means for escalation.
 *
 * The end-to-end wiring — that `generate --judge codex` really writes a request,
 * spawns something, reads a reply, and promotes on acceptance — is
 * `test/judge-codex-run.test.mjs`, driving the real binary against a fake CLI.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { VERDICTS, validateJudgeManifest } from '../core/contracts/judge.mjs';
import { discoverProviders } from '../core/adapters/discover.mjs';
import {
  JUDGE_KINDS,
  KIND_HOST,
  KIND_MIXED,
  KIND_SUBPROCESS,
  createJudgeRegistry,
  discoverJudges,
  panelCanEscalate,
  parsePanelNames,
  resolvePanel,
  selectJudge,
} from '../core/judge/index.mjs';
import { manifest as codexJudgeManifest } from '../judges/codex.mjs';
import { repositoryRoot } from './helpers/compat-harness.mjs';

/** A minimal, valid judge manifest. Each test edits exactly one thing about it. */
function manifest(overrides = {}) {
  return {
    protocol: 1,
    id: 'stub',
    role: 'judge',
    transport: 'subprocess',
    kinds: ['raster'],
    capabilities: { vision: true, verdicts: [...VERDICTS], maxChecks: null },
    auth: { state: 'unknown', detail: 'not probeable', advice: 'log in' },
    remediation: ['install it'],
    ...overrides,
  };
}

function registration(overrides = {}) {
  return { manifest: manifest(), judge: async () => ({}), ...overrides };
}

test('the bundled judge manifest validates as it ships', () => {
  const validated = validateJudgeManifest(codexJudgeManifest);

  assert.equal(validated.id, 'codex');
  assert.equal(validated.role, 'judge');
  assert.equal(validated.transport, 'subprocess');
  assert.deepEqual([...validated.kinds], ['raster']);
  // Vector is refused *by the manifest*, not only by the CLI's front door: a
  // vision model handed an SVG would judge a file it never rendered.
  assert.equal(validated.kinds.includes('vector'), false);
  assert.deepEqual([...validated.capabilities.verdicts], [...VERDICTS]);
  assert.equal(validated.auth.state, 'unknown', 'availability is not authentication (ADR 0016)');
  assert.ok(validated.remediation.length > 0, 'a judge that may be missing says how to install it');
});

test('the provider validator is not reused, and could not be', async () => {
  const { validateManifest } = await import('../core/contracts/provider.mjs');

  // The argument for a second validator, executed rather than asserted: handed
  // the real judge manifest, the provider validator does not throw — it
  // *silently returns something else*, which is the dangerous failure. Every
  // field a judge declares is gone, and a capability record describing image
  // generation is invented in its place.
  const throughProvider = validateManifest(codexJudgeManifest);

  assert.equal(throughProvider.role, undefined, 'role is discarded');
  assert.equal(throughProvider.transport, undefined, 'transport is discarded');
  assert.equal(throughProvider.auth, undefined, 'the auth record is discarded');
  assert.equal(throughProvider.capabilities.verdicts, undefined, 'the tri-state is discarded');
  assert.equal('seed' in throughProvider.capabilities, true, 'and generation geometry is invented');
});

test('a judge manifest is refused for each thing it gets wrong, one at a time', () => {
  const cases = [
    [{ protocol: 2 }, /speaks protocol 1/, 'a protocol this build does not speak'],
    [{ id: 'Codex' }, /lowercase kebab-case/, 'an id that is not kebab-case'],
    [{ id: 'host' }, /reserved judge name/, 'host is a run state, not an adapter'],
    [{ role: 'provider' }, /must declare role "judge"/, 'a provider offered as a judge'],
    [{ transport: 'in-process' }, /must declare a transport from subprocess/, 'an unsupported transport'],
    [{ kinds: [] }, /at least one kind/, 'a judge that judges nothing'],
    [{ kinds: ['audio'] }, /at least one kind/, 'an artifact kind that does not exist'],
    [{ auth: { state: 'yes' } }, /auth\.state as one of known, unknown/, 'an auth state outside the pair'],
    [{ remediation: 'install it' }, /remediation must be an array/, 'remediation that is not a list'],
  ];

  for (const [override, expected, why] of cases) {
    assert.throws(() => validateJudgeManifest(manifest(override)), expected, why);
  }
});

test('a judge that cannot say "unsure" is refused', () => {
  // The tri-state exists so "I could not tell" is different from "it is fine".
  // A judge missing `unsure` has to guess instead, which is the failure mode.
  for (const verdicts of [['pass', 'fail'], ['pass'], [], ['pass', 'fail', 'maybe']]) {
    assert.throws(
      () => validateJudgeManifest(manifest({ capabilities: { verdicts } })),
      /must speak every verdict/,
      `verdicts ${JSON.stringify(verdicts)} must be refused`,
    );
  }

  assert.doesNotThrow(() => validateJudgeManifest(manifest()));
});

test('an unknown manifest field is refused rather than dropped', () => {
  // ADR 0021 §2, and the difference from the provider validator that motivates
  // two validators: a typo'd capability that is silently ignored produces a
  // judge claiming less than it can do, with nothing to say so.
  assert.throws(
    () => validateJudgeManifest(manifest({ vision: true })),
    /unknown field\(s\): vision/,
    'a capability written at the top level is a typo, not a feature',
  );
  assert.throws(
    () => validateJudgeManifest(manifest({
      capabilities: { verdicts: [...VERDICTS], batchsChecks: true },
    })),
    /unknown field\(s\): batchsChecks/,
    'a misspelled capability is refused by name',
  );

  // The same field spelled correctly is accepted, so the refusal above is the
  // spelling being caught rather than the field being unsupported.
  assert.equal(
    validateJudgeManifest(manifest({
      capabilities: { verdicts: [...VERDICTS], batchesChecks: true },
    })).capabilities.batchesChecks,
    true,
  );
});

test('a registration must expose a judge function, and agree with its manifest', () => {
  assert.throws(() => createJudgeRegistry([{ manifest: manifest() }]), /must expose a judge function/);
  assert.throws(
    () => createJudgeRegistry([registration({ id: 'other' })]),
    /disagrees with its manifest id/,
  );
  assert.throws(
    () => createJudgeRegistry([registration({ detect: 'yes' })]),
    /detect must be a function/,
  );
  assert.throws(() => createJudgeRegistry('not an array'), /requires an array/);
});

test('a duplicate judge id is a hard error, and registration order is kept', () => {
  const first = registration();
  assert.throws(() => createJudgeRegistry([first, first]), /Duplicate judge id "stub"/);

  const other = registration({ manifest: manifest({ id: 'alpha' }) });
  // Registration order, not alphabetical: the caller decided it once.
  assert.deepEqual(createJudgeRegistry([first, other]).ids(), ['stub', 'alpha']);
});

test('external judges are refused rather than ignored', () => {
  // ADR 0021 §8. A third-party judge would have to be imported in-process,
  // which ADR 0004 forbids. Dropping it silently would report an artifact as
  // judged by a panel that never ran.
  assert.throws(
    () => discoverJudges({ builtins: [registration()], external: [registration()] }),
    /External judges are not supported/,
  );
  assert.equal(discoverJudges({ builtins: [registration()] }).ids().length, 1);
});

test('one vendor may hold the same id in both roles', () => {
  // ADR 0021 §1: ids are unique within a role, not across roles. `codex` is a
  // provider and a judge — one vendor, two roles — and a shared namespace would
  // force a rename for a collision that is not one.
  const judges = createJudgeRegistry([registration({ manifest: manifest({ id: 'codex' }) })]);
  const providers = discoverProviders({
    builtins: [{
      manifest: { protocol: 1, id: 'codex', kinds: ['raster'] },
      generate: async () => ({}),
    }],
  });

  assert.equal(judges.get('codex').manifest.role, 'judge');
  assert.equal(providers.get('codex').manifest.role, undefined);
  assert.equal(typeof judges.get('codex').judge, 'function');
  assert.equal(typeof providers.get('codex').generate, 'function');
});

test('selectJudge separates "not registered" from "cannot judge this kind"', () => {
  const registry = createJudgeRegistry([registration()]);

  assert.throws(
    () => selectJudge(registry, { id: 'nobody' }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && /No judge is registered under "nobody"/.test(error.message),
    'a missing judge is unavailable, not a malformed request',
  );
  assert.throws(
    () => selectJudge(registry, { id: 'stub', kind: 'vector' }),
    (error) => error.code === 'INVALID_REQUEST' && /does not judge vector artifacts/.test(error.message),
  );
  assert.equal(selectJudge(registry, { id: 'stub', kind: 'raster' }).id, 'stub');
});

test('a judge with no detect is unavailable, not assumed present', () => {
  // The opposite default to a provider, deliberately: every judge this build can
  // have drives an external CLI, so "nothing to install" is not a shape that
  // exists here, and claiming available without looking is what ADR 0016 forbids.
  const entry = createJudgeRegistry([registration()]).get('stub');
  assert.equal(entry.detect().available, false);
});

test('panel names are parsed, and a panel of one judge asked twice is refused', () => {
  assert.deepEqual(parsePanelNames('codex'), ['codex']);
  assert.deepEqual(parsePanelNames(' codex , host '), ['codex', 'host']);

  assert.throws(() => parsePanelNames(''), /requires a judge name/);
  assert.throws(() => parsePanelNames('codex,'), /has an empty entry/);
  assert.throws(() => parsePanelNames('codex,codex'), /names "codex" twice/);
});

test('a panel resolves to a kind, and a mixed one is refused by name', () => {
  const registry = createJudgeRegistry([registration()]);

  const host = resolvePanel({ names: ['host'], registry: null });
  assert.equal(host.kind, KIND_HOST);
  assert.equal(host.hasHost, true);
  assert.equal(host.subprocess.length, 0);

  const subprocess = resolvePanel({ names: ['stub'], registry });
  assert.equal(subprocess.kind, KIND_SUBPROCESS);
  assert.equal(subprocess.hasHost, false);
  assert.equal(subprocess.subprocess.length, 1);
  assert.deepEqual(subprocess.members, [{ id: 'stub', role: 'judge', trust: 'builtin', kind: KIND_SUBPROCESS }]);
  assert.equal('entry' in subprocess.members[0], false, 'a run record is evidence; a function is not evidence');

  // ADR 0021 §10, from both sides: it is the panel *size* that is refused, not
  // the presence of `host`, so neither shape can slip through.
  assert.throws(() => resolvePanel({ names: ['stub', 'host'], registry }), /mixed panel/);
  assert.throws(() => resolvePanel({ names: ['stub', 'other'], registry }), /mixed panel/);
});

test('escalation authority follows the recorded panel, on every leg', () => {
  // ADR 0021 §6. Read from `run.json` at submit time, so a later process reaches
  // the same answer as the one that issued the round. Each leg is mutated
  // independently: a test that only checked the host case would pass against an
  // implementation that always returned true.
  assert.equal(panelCanEscalate({ kind: KIND_HOST }), true);
  assert.equal(panelCanEscalate({ kind: KIND_MIXED }), true);
  assert.equal(panelCanEscalate({ kind: KIND_SUBPROCESS }), false);
  assert.equal(
    panelCanEscalate({ kind: KIND_SUBPROCESS, panel: [{ id: 'codex' }] }),
    false,
    'a panel of subprocess judges has no authority to escalate to',
  );
  assert.equal(
    panelCanEscalate({ kind: KIND_SUBPROCESS, panel: [{ id: 'codex' }, { id: 'host' }] }),
    true,
    'a recorded host member decides it even if the summary kind disagrees',
  );
  // A run written before ADR 0021 records no kind at all, and could only have
  // been a host run.
  assert.equal(panelCanEscalate({}), true);
  assert.equal(panelCanEscalate(null), true);
});

test('the judge kinds in code and in the published schema are the same three', async () => {
  // ADR 0021 §5 widened `judge.kind` from `{"const": "host"}` in place, keeping
  // the envelope at major 1. Two things must therefore stay true together: the
  // schema still admits `host`, and the code and the schema agree on the whole
  // set — so a fourth kind cannot be added on one side alone.
  const schema = JSON.parse(await readFile(path.join(repositoryRoot, 'schema', 'run.v1.json'), 'utf8'));
  const published = schema.properties.judge.properties.kind.enum;

  assert.deepEqual([...JUDGE_KINDS], ['host', 'subprocess', 'mixed']);
  assert.deepEqual(published, [...JUDGE_KINDS]);
  assert.equal(published.includes('host'), true, 'widening in place must not drop the value it widened from');
  assert.equal(schema.properties.judge.properties.kind.const, undefined, 'a const would refuse the new kinds');
});
