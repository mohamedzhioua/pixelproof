# 0021 — Judge registry and subprocess judges

- **Class:** User-Challenge
- **Status:** Accepted
- **Date:** 2026-08-14
- **Maintainer confirmation:** confirmed on 2026-08-14, on all four points this document put to the
  gate — widening `judge.kind` in place rather than bumping the envelope major (§5); degrading an
  unescalatable `unsure` to a rejection rather than refusing the run up front (§6); retaking a
  subprocess semantic rejection in the same process (§7); and building the single-judge path now
  with the mixed panel specified but deliberately not built (§10).
- **Supersedes nothing. Amends:** ADR 0009 §5 (escalation with no host in the panel), ADR 0014
  (`run.json`'s `judge.kind`), ADR 0020 §2 (what a semantic rejection does when it arrives in the
  same process).

## Context

`judges/codex.mjs` is finished. It drives `codex exec` with flags verified against codex-cli
0.147.0, pins the reply with `--output-schema`, revalidates every reply through
`parseJudgeResponse(raw, { expectedIds })`, maps vendor diagnostics onto the closed taxonomy, and
has no path on which a timeout, a non-zero exit, or an `ok: false` payload returns results. It is
covered by `test/judge-codex.test.mjs` against a fake CLI through the `command`/`args` seam.

Nothing imports it. `grep -rn "judges/" --include=*.mjs .` returns exactly one hit, and it is that
test file. `--judge codex` is refused by name in `surfaces/cli/judged-run.mjs`:

```js
export const SUPPORTED_JUDGES = Object.freeze([HOST_JUDGE]);
```

So the vendor half exists and the wiring does not. Three things stand between them.

**There is no judge registry, and the provider registry cannot become one.**
`core/adapters/discover.mjs` demands `typeof raw.generate === 'function'` and runs every
registration through `validateManifest()`. That validator is a normalizing allowlist over
*generation geometry* — `minWidth`, `dimensionMultiple`, `seed`, `transparency` — and it returns a
new object built only from those fields. Handed the Codex judge manifest it would silently discard
`role`, `transport`, `auth`, `remediation`, `verdicts`, `batchesChecks` and `constrainedOutput`, and
hand back a fabricated capability record describing image generation that no judge performs.
`judges/codex.mjs` already says so in a comment and deliberately declines to use it. Widening
`validateManifest` to know about both roles would put a lie in the report `doctor` prints; that is
the failure this project exists to prevent, applied to its own diagnostics.

**`host` is a run state, and a subprocess judge is not.** ADR 0009 §1 models `host` as two
invocations because the only entity that can open the image is the agent blocked on the child
process. That deadlock does not exist for a subprocess judge: Pixelproof spawns it, waits for it,
and reads its answer in the same process. Modelling `codex` as a pending state would invent a
handoff nobody is waiting on.

**Acceptance is already implemented once, and must not be implemented twice.**
`core/judge/handoff.mjs`'s submit path folds verdicts, decides the outcome, records the semantic
result, issues escalation, finalises and promotes. A subprocess judge arrives at the same point
holding the same protocol-1 response. A second implementation of "what a judge response means"
would be free to drift from the first, and the drift would be invisible until an artifact was
accepted on one path that the other would have rejected.

ADR 0009 §5 assumes a registry (`judge: ["gemini", "host"]`) without specifying one. This ADR
specifies it.

## Decision

### 1. A judge registry is a second registry, not a widened provider one

`core/judge/registry.mjs` holds the judge registry. It never scans the filesystem and never imports
`judges/`: the composition layer that already imports a judge module hands it over, exactly as
`defaultProviderProbe` in `surfaces/cli/commands/doctor.mjs` hands over providers today. ADR 0002's
one-way dependency is unchanged — `core/` still imports nothing from `judges/`.

The three determinism rules from `discover.mjs` apply unchanged: built-ins keep registration order,
external entries sort by id, and a duplicate id is a hard error rather than last-one-wins.

**Those rules keep one home.** `discover.mjs`'s `buildRegistry` carries the comment "the one place a
registry is built, so the duplicate rule has a single home". Copying it would make that sentence
false on the day it was copied. The indexing half is extracted to `core/adapters/registry.mjs` and
imported by both; each role keeps its own *normalizer*, which is the half that actually differs.

**Roles have separate id namespaces.** `codex` is a provider *and* a judge — one vendor, two roles —
and a shared namespace would force one of them to be renamed for a collision that is not one. Two
registries mean the duplicate rule bites within a role, which is where shadowing is a supply-chain
problem, and is silent across roles, where it is just the vendor's name.

**`host` is refused as a judge id.** `host` is a run state, not a registry entry. A registration
under that name would create two things that could disagree about what `--judge host` means, so
`normalizeJudge` refuses it by name.

### 2. A judge manifest is validated as data, by a judge validator

`validateJudgeManifest()` lands in `core/contracts/judge.mjs`, beside the request and response
validators it belongs with. It checks, and returns frozen:

| Field | Rule |
| --- | --- |
| `protocol` | equals `PROTOCOL_VERSION` |
| `id` | lowercase kebab-case, and not `host` |
| `role` | `'judge'` |
| `transport` | `'subprocess'` (the only one this build has) |
| `kinds` | non-empty subset of the artifact kinds |
| `capabilities.verdicts` | a subset of `VERDICTS`, and must contain all three |
| `capabilities.maxChecks` | positive integer or `null`; **absent means undeclared, not infinite** |
| `capabilities.{vision,attachesArtifact,batchesChecks,confidence,evidence,constrainedOutput}` | booleans, defaulting false |
| `auth` | `{ state: 'known'\|'unknown', detail, advice }` |
| `remediation` | array of strings |

Unknown keys are **refused**, not dropped. ADR 0006's policy of rejecting unknown same-version
fields is the right one here for the reason it is right anywhere: a typo in a capability name that
is silently ignored produces a manifest that claims less than the module can do, and nothing ever
says so. This differs from `validateManifest`, which drops — and that difference is the argument for
two validators rather than one.

The validator runs at *registration*, which is the cheapest possible moment, and the same argument
`discover.mjs` already makes: a malformed capability record should fail before the first paid call,
not during it.

### 3. `--judge codex` is a call, not a state

A run judged only by subprocess judges never enters `pending-judgement`, never writes a nonce
anybody has to echo, and never exits 2. It runs:

```
generate → mechanical tier → (ok) → judge call → fold → decide → accepted | rejected | retake
```

- **Exit 0** on acceptance, with promotion to `--out` under ADR 0009 §2's unchanged rule.
- **Exit 1** on rejection, on a judge error, and on an unresolvable `unsure` (§6).
- **Exit 2 never appears.** It means "an outstanding judgement" everywhere it appears today, and a
  synchronous judge leaves none outstanding. Nothing about "non-zero is failure" changes for
  callers either way.

**`--judge-deadline` is refused with a subprocess-only panel**, for the same reason and in the same
place `--judge-deadline` without `--judge` is already refused: a deadline governs how long a
checklist stays answerable, and nothing is answerable here. The subprocess bound is a *timeout* —
`PIXELPROOF_JUDGE_TIMEOUT_MS`, default 300 000 ms, already implemented in `judges/codex.mjs`. No new
flag is added for it in this slice.

**Panel syntax is comma-separated**: `--judge codex`, `--judge codex,host`. `parse.mjs` already
treats `--judge` as a single-valued flag; a repeated flag would need array support in the parser for
no gain. *(Taste. Stated, not gated.)*

### 4. One function applies a judge response, whatever process it came from

The fold/decide/record/finalise/promote sequence in `core/judge/handoff.mjs` is factored so that
both paths reach the same code with the same protocol-1 response:

- the **host** path reaches it from `judge submit`, after §3's identity checks;
- the **subprocess** path reaches it directly, in-process, with no identity check because there is
  no second process whose claim needs proving.

No acceptance logic is written twice. If a subprocess run and a host run disagree about an identical
set of verdicts, that is a bug in one function rather than a difference between two.

`core/` still does not import `judges/`. The composition layer resolves the registry entry and passes
an invoker into `completeJudgedRun` as a callback — the seam `regenerate` already established for
ADR 0020's retakes.

### 5. A subprocess round leaves the same evidence a host round does

`judge-request-<round>.json` is written **before** the call, and `judge-result-<round>.json` from the
reply. The envelope is `pixelproof.judge-pending/1` unchanged: one shape, one reader, and
`judge show --request` keeps emitting a bare protocol-1 request that either judge kind consumes
verbatim (ADR 0009 §2's stated reason for wrapping rather than extending).

The `nonce` is written and is **inert on this path**. It is not answerable, because the run never
enters `pending-judgement` and `judge submit` therefore refuses it with the existing
`PENDING_NOT_OPEN`. The state machine closes that door, not a second rule about which envelopes may
be submitted — one closed door is easier to prove than two.

`run.json`'s `judge.kind` is currently `{ "const": "host" }` in `schema/run.v1.json`. It widens to
`"host" | "subprocess" | "mixed"`, and a new additive field records the panel:

```json
"judge": {
  "kind": "subprocess",
  "panel": [{ "id": "codex", "role": "judge", "trust": "builtin", "kind": "subprocess" }],
  "policy": "all",
  "onUnsure": "escalate"
}
```

**This is the one place this ADR touches a published schema.** It **widens in place and the major
stays `1`**: the field keeps its name and its string type, `"host"` keeps its meaning, and `panel`
is additive in ADR 0014 §3's sense. `kind` is documented in `schema/run.v1.json` as an open enum
from here on, and a test pins the three legal values so a fourth cannot arrive unnoticed.

What that costs is stated rather than buried: a consumer which read `const: "host"` as a promise now
meets a value it has no arm for. The alternative — `pixelproof.run/2` — was rejected because ADR
0014's exact-major-or-refuse read rule would force every consumer to re-declare for a value most of
them will never encounter, and would make every run directory written before this build unreadable
unless a second reader were kept for `/1`.

### 6. With no host in the panel, `escalate` degrades to `fail`, loudly

ADR 0010's `onUnsure: "escalate"` means escalate *to the host*. ADR 0009 §5 unified escalation with
the handoff precisely because the host is the escalation authority. A panel of `["codex"]` has no
such authority.

Re-asking the same subprocess judge is **not** escalation. It is the same authority answering the
same question, and under ADR 0009 §5's replacement rule its second answer would overwrite its first
— which converts "I cannot tell" into a coin flip that reports as a verdict. That is worse than the
honest answer.

**Decision: when the panel contains no `host`, an `unsure` that would escalate is rejected instead**,
recorded as `semantic-unsure` with a named note that no escalation authority was configured, and
printed so the operator can add `,host` to the panel and re-run. `MAX_ROUNDS` is untouched; a panel
that *does* contain `host` escalates exactly as ADR 0009 §5 already specifies.

Refusing the run at the front door — requiring the spec to set `onUnsure: "fail"` explicitly before
`--judge codex` is allowed — was put to the gate and rejected: `escalate` is the default, so that
rule would refuse the plain `--judge codex` invocation this slice exists to enable until every
existing spec had been edited.

### 7. A subprocess semantic rejection retakes in the same process

ADR 0020 §2 left a semantically rejected run *open* and printed the `pixelproof retake` command
rather than regenerating. Its stated reason was that the two verdicts arrive in different
processes, so spending a generation would spend money nobody had authorised in that process. **That
reason does not hold for a subprocess judge**, where the verdict arrives in the same process that
could act on it — which is the exact situation of a mechanical failure, and a mechanical failure
already retakes in-process.

So: a subprocess semantic rejection with the retake bound unspent is corrected and retaken in the
same process. `core/generation/correction.mjs` needs no change — it already assembles the correction
from the judge's own `evidence` strings verbatim, and never invents one.

The cost asymmetry is real and is stated rather than buried: each retake here spends **one
generation plus one judge call**, both paid, where a mechanical retake spends only the generation.
The authorisation for that is `--retakes n`, which the operator typed, and each step prints which
attempt it is spending and against which bound — the line the mechanical path already prints.

Leaving the run open and printing `pixelproof retake` was put to the gate and rejected: it matches
the host path's *shape* while matching nothing else about it, and it asks a human to authorise a
correction the tool has already computed from evidence it already holds.

A judge that **errored** (`ok: false`, timeout, non-zero exit) still does not open a retake, exactly
as ADR 0020 already decided: that reply says the judging failed, not the artifact.

### 8. Trust: built-in judges only, for now

ADR 0004's two classes describe *modules*. Applied here they split cleanly:

- The judge **module** is `builtin` trust: bundled in this repository, imported in-process.
- The vendor **CLI** it drives is a subprocess under ADR 0007's lifecycle — argv-only, `shell:
  false`, an explicit env allowlist, a timeout, and byte caps on response and log.

The registry accepts **built-ins only in this slice**. `TRUST_EXTERNAL` for judges would mean
importing or configuring third-party judge modules, and ADR 0004 is explicit that Pixelproof never
auto-imports arbitrary project code. The shape is reserved, not built; `discoverJudges({ builtins,
external })` refuses a non-empty `external` with a named error rather than silently ignoring it.

`OPENAI_API_KEY` stays off the allowlist. A caller that authenticates by key names it at the call
site, which keeps a secret's crossing of the process boundary a decision somebody made.

**One injection surface deserves naming.** The spec's assertions are already handled: `JUDGE_PROMPT`
declares the `<stdin>` block to be data, never instructions. The *artifact* is not sanitizable — an
image may contain rendered text saying whatever it likes, and the vision model will read it. The
mitigation is structural rather than textual: the judge's only output channel is a schema whose `id`
enum is pinned to the exact checks that were asked, and `parseJudgeResponse` re-checks the pairing
afterwards. An image that talks its way into an extra verdict still cannot get that verdict past
either gate. A judge cannot be talked into *fabricating a pass* for a check that was asked — nothing
can prevent that, which is why a panel and a disagreement signal exist at all.

### 9. `doctor` reports judges the way it reports providers

One new section, the same discipline: bounded import so a broken judge module is one unavailable row
rather than a dead report, bounded `detect`, and **availability is not authentication** (ADR 0016) —
`codex` on PATH reports available with `auth: unknown`, and nothing shells out to prove otherwise.

### 10. Mixed panels: specified here, built in a second slice

For a panel like `["codex", "host"]`, ADR 0009 §5 already fixes the rules and this ADR changes none
of them: subprocess judges run synchronously first, their per-check verdicts are recorded, the host's
checklist is then issued as a pending round (exit 2), `combineVerdicts` runs at submit time over the
full panel, and **the pending record never contains the other judges' verdicts** — telling a judge
what another judge said destroys the independence that makes the disagreement signal worth anything.

**It is not built in this slice**, by decision at the gate. A mixed panel multiplies the state
surface it touches — subprocess-then-pending, escalation authority present again, and §7's
in-process retake crossing a handoff that by definition cannot complete in-process — and none of it
can be proven against the real vendor before quota returns anyway. Single-judge `--judge codex` is
the whole of the value; the panel is where the complexity is.

Until it is built, a `--judge` value naming more than one judge is **refused by name**, saying that
mixed panels are specified and not yet wired. It is not silently reduced to its first entry: a run
that quietly drops a judge from the panel it was asked for would report an artifact as judged by
authorities that never saw it.

## What this ADR does not decide

- **Scoring.** Unchanged and still unbuilt. Nothing here ranks an attempt, and exhaustion still
  promotes nothing (ADR 0020 §7).
- **Degraded SVG semantics.** ADR 0019 stays open; `--judge codex` refuses a non-PNG target at the
  same front door and for the same reason `--judge host` does. `codex.mjs`'s manifest declares
  `kinds: ['raster']`, so the registry refuses the pairing independently.
- **A `claude` or `gemini` judge.** The registry makes them cheap; neither is in this slice.
- **External (third-party) judges.** §8.
- **ADR 0008's single-foreign-candidate hole.** Untouched. A subprocess judge does not narrow it,
  and §5's inert nonce is not a fix for it.

## Proof plan, and what cannot be proven before 2026-08-18

**Hermetic, and available now.** The fake-CLI seam (`command`/`args`) that `test/judge-codex.test.mjs`
already uses covers: registry order, duplicate refusal, the `host` id refusal, cross-role
non-collision, every field of `validateJudgeManifest` including the unknown-key refusal, the
raster/kind refusal, `--judge-deadline` refusal on a subprocess panel, exit 0/1 with no 2, the
written request and result files, the widened `run.json`, §6's degradation, §7's in-process retake
(with a counting fake serving a different image per call, as `test/retake-cli.test.mjs` already
does), and the no-verdicts-is-not-a-pass paths for timeout, non-zero exit and `ok: false`.

Each guard is proven to fire by mutating **every leg it depends on**, not one — the ADR 0020 lesson.
For §6 that means: the degradation must go red both when the escalation branch is restored *and*
when the panel-has-no-host test is inverted, so a test that agrees with the thing it tests cannot
pass for the wrong reason.

**Not provable yet, and not claimed.** `judges/codex.mjs` was verified against codex-cli 0.147.0 in
isolation. The *wired* path — generate, run directory, judge call, fold, accept, promote to `--out`
— has never run against the real vendor, because the Codex account is over quota until
**2026-08-18**. No test in this slice will run it, no release note will say `--judge codex` works
end to end, and the CHANGELOG entry will say what was proven against a fake CLI and what was not.
The end-to-end run happens on or after 2026-08-18 and its receipt is recorded before any such claim
is made.

## Consequences

- `schema/run.v1.json` changes for the first time since ADR 0014 wrote it. §5's widening is the
  smallest change that admits a second judge kind, and it is still a published-schema change.
- `SUPPORTED_JUDGES` stops being a frozen array of one and becomes a registry lookup plus `host`.
  The error message for an unknown judge should name what *is* registered, as `selectProvider`
  already does.
- Two registries with two normalizers is more surface than one registry with a role flag. The
  alternative was a validator that lies about half its inputs; this is the cheaper of the two.
- `--judge codex` puts a paid call behind an ordinary `generate`. `--judge host` never could: it
  handed a checklist to an agent that was already running. This is the first path on which
  Pixelproof spends the user's subscription without a second invocation, and the README needs to say
  so where it says how judging works.
- §7 means a single `generate --judge codex --retakes 3` can spend up to three generations and three
  judge calls. That is what the flag means, and the printed line should say which attempt and which
  bound at each step, as the mechanical path already does.
- ADR 0009 §5's mixed-panel sentence remains unimplemented after this slice if §10's recommendation
  stands. It should be recorded as *deliberately not built*, in the handoff, not left to look like
  an oversight.
- **`pixelproof retake` refuses a subprocess-judged run by name.** This was found while
  implementing rather than while designing, and it is recorded here so it does not read later as
  an oversight. §7 puts the retake *inside* `generate`, so a subprocess run never waits for an
  operator between attempts and `retake` should never be reached for one. Reaching it means the
  run was interrupted, and resuming it would mean re-judging attempt *n+1* through a registry
  that command does not build. It fails closed — naming `judge abandon` and a fresh `generate` —
  rather than resuming as though the run were a host run, which would issue a checklist nobody
  asked for. Making `retake` resume a subprocess run is a later decision, not a bug fix.

## Related

Specifies the registry [0009 — Host judge handoff](./0009-host-judge-handoff.md) §5 assumes.
Bound by [0002 — Four-layer dependency rule](./0002-four-layer-dependency-rule.md) (`core/` never
imports `judges/`), [0004 — Adapter trust classes](./0004-adapter-trust-classes.md) (§8),
[0005 — Adapter manifest and discovery](./0005-adapter-manifest-and-discovery.md) (whose three
determinism rules are reused and whose validator is deliberately not),
[0006 — Protocol validation and error taxonomy](./0006-protocol-validation-and-error-taxonomy.md)
(unknown-field policy, closed error enum),
[0007 — Subprocess lifecycle and resource limits](./0007-subprocess-lifecycle-and-resource-limits.md),
[0010 — Check identity, tri-state, and consensus](./0010-check-identity-tri-state-and-consensus.md)
and [0011 — Acceptance versus scoring](./0011-acceptance-versus-scoring.md) (consumed unchanged),
[0016 — Authentication and support tiers](./0016-authentication-and-support-tiers.md) (availability
is not authentication). Amends
[0014 — Evidence and report versioning](./0014-evidence-and-report-versioning.md) §5 and
[0020 — Retakes under a judged run](./0020-retakes-under-a-judged-run.md) §7.
