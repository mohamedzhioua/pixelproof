import assert from 'node:assert/strict';
import test from 'node:test';

import { assignCheckIds, checkIdFor, isCheckId } from '../core/contracts/check-id.mjs';
import {
  CONSENSUS_POLICIES,
  VERDICTS,
  acceptanceFor,
  combineVerdicts,
  parseJudgeResponse,
  validateJudgeRequest,
} from '../core/contracts/judge.mjs';

const NO_TEXT = 'Zero text, letters, numbers or watermarks anywhere';
const NO_PEOPLE = 'No people or hands appear anywhere';

function requestFor(assertions = [NO_TEXT, NO_PEOPLE]) {
  return {
    protocol: 1,
    file: '/abs/out/lamp.png',
    context: 'Square product hero on seamless white',
    checks: assignCheckIds(assertions),
  };
}

test('check ids are derived from assertion text, not position', () => {
  const first = assignCheckIds([NO_TEXT, NO_PEOPLE]);
  const reordered = assignCheckIds([NO_PEOPLE, NO_TEXT]);

  assert.equal(
    first.find((check) => check.assertion === NO_TEXT).id,
    reordered.find((check) => check.assertion === NO_TEXT).id,
    'reordering a spec must not change what a check is called',
  );

  const withParentAssertionPrepended = assignCheckIds(['A rule inherited from a brand spec', NO_TEXT]);
  assert.equal(
    withParentAssertionPrepended[1].id,
    checkIdFor(NO_TEXT),
    'spec composition prepending an assertion must not renumber the rest',
  );
});

test('whitespace is canonicalised but case is preserved', () => {
  assert.equal(checkIdFor('  no   people  '), checkIdFor('no people'));
  assert.notEqual(checkIdFor('No People'), checkIdFor('no people'), 'case can carry brand meaning');
});

test('repeated assertions get unique ids via an occurrence suffix', () => {
  const checks = assignCheckIds([NO_TEXT, NO_TEXT]);

  assert.equal(checks[0].id, checkIdFor(NO_TEXT));
  assert.equal(checks[1].id, `${checkIdFor(NO_TEXT)}#2`);
  assert.equal(new Set(checks.map((check) => check.id)).size, 2);
  assert.ok(checks.every((check) => isCheckId(check.id)));
});

test('rejects assertions that cannot carry an identity', () => {
  assert.throws(() => checkIdFor(''), /non-empty string/iu);
  assert.throws(() => checkIdFor('   '), /non-empty string/iu);
  assert.throws(() => checkIdFor(null), /non-empty string/iu);
  assert.throws(() => assignCheckIds('not an array'), /must be an array/iu);
  assert.ok(!isCheckId('s1'), 'positional ids are not valid identities');
  assert.ok(!isCheckId('s-XYZ'), 'ids are lowercase hex');
});

test('validates a judge request', () => {
  const validated = validateJudgeRequest(requestFor());

  assert.equal(validated.checks.length, 2);
  assert.equal(validated.context, 'Square product hero on seamless white');
});

test('rejects malformed judge requests', () => {
  const duplicated = requestFor();
  duplicated.checks = [duplicated.checks[0], { ...duplicated.checks[0] }];

  const cases = [
    [{ ...requestFor(), protocol: 4 }, /protocol/iu],
    [{ ...requestFor(), file: '' }, /file/iu],
    [{ ...requestFor(), checks: [] }, /at least one check/iu],
    [duplicated, /duplicate check id/iu],
    [{ ...requestFor(), checks: [{ id: 's1', assertion: 'x' }] }, /well-formed check identity/iu],
    [{ ...requestFor(), checks: [{ id: checkIdFor(NO_TEXT), assertion: '' }] }, /non-empty assertion/iu],
  ];

  for (const [value, pattern] of cases) {
    assert.throws(() => validateJudgeRequest(value), pattern);
  }
});

test('a judge must answer exactly the checks it was asked', () => {
  const checks = assignCheckIds([NO_TEXT, NO_PEOPLE]);
  const expectedIds = checks.map((check) => check.id);

  const complete = parseJudgeResponse(
    {
      protocol: 1,
      ok: true,
      judge: 'demo-judge',
      results: [
        { id: expectedIds[0], verdict: 'pass', confidence: 0.94, evidence: 'no glyphs present' },
        { id: expectedIds[1], verdict: 'fail', confidence: 0.88, evidence: 'a hand enters lower-left' },
      ],
    },
    { expectedIds },
  );

  assert.equal(complete.results.length, 2);
  assert.equal(complete.results[1].verdict, 'fail');

  assert.throws(
    () => parseJudgeResponse(
      { protocol: 1, ok: true, results: [{ id: expectedIds[0], verdict: 'pass' }] },
      { expectedIds },
    ),
    /exactly the checks/iu,
    'a partial answer treated as complete would be indistinguishable from a pass',
  );

  assert.throws(
    () => parseJudgeResponse(
      {
        protocol: 1,
        ok: true,
        results: [
          ...expectedIds.map((id) => ({ id, verdict: 'pass' })),
          { id: checkIdFor('an assertion nobody asked about'), verdict: 'pass' },
        ],
      },
      { expectedIds },
    ),
    /exactly the checks/iu,
  );
});

test('rejects malformed judge results', () => {
  const id = checkIdFor(NO_TEXT);
  const cases = [
    [{ protocol: 1, ok: true, results: [{ id, verdict: 'looks good' }] }, /verdict must be one of/iu],
    [{ protocol: 1, ok: true, results: [{ id, verdict: 'pass', confidence: 1.4 }] }, /confidence/iu],
    [{ protocol: 1, ok: true, results: [{ id, verdict: 'pass', confidence: -0.1 }] }, /confidence/iu],
    [
      { protocol: 1, ok: true, results: [{ id, verdict: 'pass' }, { id, verdict: 'fail' }] },
      /duplicate results/iu,
    ],
    [{ protocol: 1, ok: true, results: 'not an array' }, /must be an array/iu],
    [{ protocol: 1, ok: 'yes', results: [] }, /ok must be a boolean/iu],
    [{ protocol: 7, ok: true, results: [] }, /protocol/iu],
  ];

  for (const [value, pattern] of cases) {
    assert.throws(() => parseJudgeResponse(value), pattern);
  }
});

test('a judge failure is passed through as a failure, not a verdict', () => {
  const parsed = parseJudgeResponse({
    protocol: 1,
    ok: false,
    error: { code: 'AUTH_REQUIRED', message: 'not signed in' },
  });

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'AUTH_REQUIRED');
});

test('consensus policies combine verdicts and surface disagreement', () => {
  assert.deepEqual(CONSENSUS_POLICIES, ['all', 'any', 'majority']);
  assert.deepEqual(VERDICTS, ['pass', 'fail', 'unsure']);

  assert.equal(combineVerdicts(['pass', 'pass'], 'all').verdict, 'pass');
  assert.equal(combineVerdicts(['pass', 'fail'], 'all').verdict, 'fail');
  assert.equal(combineVerdicts(['pass', 'unsure'], 'all').verdict, 'unsure');

  assert.equal(combineVerdicts(['pass', 'fail'], 'any').verdict, 'pass');
  assert.equal(combineVerdicts(['fail', 'unsure'], 'any').verdict, 'fail');
  assert.equal(combineVerdicts(['unsure', 'unsure'], 'any').verdict, 'unsure');

  assert.equal(combineVerdicts(['pass', 'pass', 'fail'], 'majority').verdict, 'pass');
  assert.equal(combineVerdicts(['fail', 'fail', 'pass'], 'majority').verdict, 'fail');
  assert.equal(combineVerdicts(['pass', 'fail'], 'majority').verdict, 'unsure', 'a tie is not a decision');
  assert.equal(combineVerdicts(['unsure', 'unsure'], 'majority').verdict, 'unsure');
});

test('disagreement is reported alongside the verdict rather than averaged away', () => {
  const split = combineVerdicts(['pass', 'fail'], 'all');

  assert.equal(split.disagreement, true);
  assert.equal(split.passes, 1);
  assert.equal(split.fails, 1);

  const unanimous = combineVerdicts(['pass', 'pass'], 'all');
  assert.equal(unanimous.disagreement, false);
});

test('consensus rejects nonsense input', () => {
  assert.throws(() => combineVerdicts([], 'all'), /at least one verdict/iu);
  assert.throws(() => combineVerdicts(['pass'], 'vibes'), /Consensus policy/iu);
  assert.throws(() => combineVerdicts(['probably'], 'all'), /pass, fail, or unsure/iu);
});

test('unsure never resolves to accepted', () => {
  assert.deepEqual(acceptanceFor('pass'), { accepted: true, escalate: false });
  assert.deepEqual(acceptanceFor('fail'), { accepted: false, escalate: false });
  assert.deepEqual(acceptanceFor('unsure'), { accepted: false, escalate: true });
  assert.deepEqual(acceptanceFor('unsure', { onUnsure: 'fail' }), { accepted: false, escalate: false });

  assert.throws(
    () => acceptanceFor('unsure', { onUnsure: 'pass' }),
    /onUnsure must be one of/iu,
    'promoting unsure to pass is not an available policy',
  );
});
