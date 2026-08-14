# 0020 — Retakes under a judged run

- **Class:** User-Challenge
- **Status:** Accepted
- **Date:** 2026-08-14

**Confirmed by the maintainer on 2026-08-14**, with both flagged consequences accepted
explicitly rather than inherited from the decision as a whole:

1. **A run can now end in `running`.** An operator who never retakes and never abandons leaves
   an orphan that nothing is pending on, so `judge pending` cannot see it. `doctor`'s
   `judgements:` line counts it — `N runs open between attempts` — or ADR 0009 §4's "an
   abandoned handoff is visible to someone who never knew one happened" would quietly stop
   being true for the retake path.
2. **`running` gains a second meaning for consumers.** It now means either "no attempt has
   finished yet" or "an attempt was rejected and the next one has not started". No member was
   added to the state set, so nothing that switches exhaustively on `state` breaks; but a
   consumer that read `running` as "nothing has been judged yet" is now wrong, and that is
   named here rather than left to be discovered.

Implemented on the same date. Three details were settled during implementation and are
recorded here because they are decisions, not mechanics:

- **`retakes-exhausted` is recorded only when retakes were actually asked for** (a bound above
  1). A run left on the default bound of one never requested a second attempt, so calling its
  rejection "exhausted" would rename the outcome of every judged run that already exists to
  describe a feature it did not use.
- **`--retakes > 1` is refused with the `svg` provider**, before any generation. A retake is a
  corrected prompt, and the svg provider is handed markup, so a second attempt would reproduce
  the first byte for byte — spending the bound to change nothing.
- **A judge that *errored* (`ok: false`) does not open a retake.** That reply says the judging
  failed, not the artifact; spending a generation to answer a broken judge would correct the
  wrong thing. It finalises as ADR 0009 §5 already specified.

## Context

[`skills/image/SKILL.md`](../../skills/image/SKILL.md) has always described a bounded retake loop:
generate, check both tiers, and on failure "construct the next prompt from the prior prompt plus a
direct correction naming each observed violation", up to `spec.retakes` attempts. That loop is
prose executed by an agent. [`V2-PLAN.md`](../V2-PLAN.md) §2 says so plainly — it is "useful
workflow policy, but it is prose executed by Claude, not runtime orchestration".

Two facts, both verified on 2026-08-14, say how far from runtime it still is:

- **`spec.retakes` is read by no code at all.** It appears in
  `specs/product-hero.example.json`, in two skills, and in the README. Nothing in `core/` or
  `surfaces/` looks at it.
- **Scoring is unbuilt.** `spec.scoring` is a Spec v2 idea; the only occurrences of the word in
  the codebase are comments in `core/contracts/judge.mjs` explaining that scoring ranks and never
  waives. There is no function that orders two attempts.

[`V2-BRIEF.md`](../V2-BRIEF.md) §5 pictures the target directly — `attempt-1.png`,
`attempt-2.png`, and a contact sheet across them, all inside **one** run directory.
[0014](./0014-evidence-and-report-versioning.md) §2 already guarantees `attempts[]` is ordered,
contiguous, and starts at 1. The slot exists; nothing fills it past 1.

What makes this more than a loop is that under `--judge host` the two failure verdicts arrive in
**different processes**. A mechanical failure is known inside `generate`. A semantic rejection
arrives at `pixelproof judge submit`, possibly a day later, possibly on another machine. So the
retake decision cannot live in one place, and three accepted decisions constrain where it can
live at all:

- `accepted`, `rejected` and `abandoned` are terminal with no outgoing edges
  ([0014](./0014-evidence-and-report-versioning.md) §2). That is what makes ADR 0009's nonce
  single-use, so it must not be relaxed.
- `core/run/state.mjs` forbids any return to `running`, citing
  [0009](./0009-host-judge-handoff.md) §1: a re-entry would make regeneration-on-resume
  expressible, "and the artifact the host actually looked at would stop being the artifact
  described".
- The **state set** is closed within `pixelproof.run/1`; adding a member costs a major
  ([0014](./0014-evidence-and-report-versioning.md) §2, §7). ADR 0014 §7 named `retaken` and
  `superseded` as plausible future states and priced them at a bump.

## Decision

### 1. One run, several attempts, and the run stays open between them

A retake is a new numbered attempt **inside the same run directory**, not a new run and not a
chain of linked runs. `attempts[]` grows; the report is about all of them; the artifact for
attempt *n* is `attempt-<n>.png` beside its `attempt-<n>.json`.

To get there, `pending-judgement → running` becomes a legal transition, guarded by a rule the
machine cannot express and the caller must not be able to fake: it is taken only by finalisation
logic that is starting a **new attempt number** while the retake bound is unspent.

**This re-opens an edge a previous decision closed, so it is an amendment and not a reading.**
ADR 0009 §1's reason for closing it is precise: regenerating on resume "would produce a
*different* artifact than the one the host actually looked at, leaving verdicts that describe
bytes which no longer exist". That reason targets re-running *the same* attempt. Attempt *n*'s
bytes, its mechanical table, its verdicts and its round files are immutable once written; attempt
*n+1* occupies a new numbered slot and touches none of them. The verdicts still describe exactly
the bytes they were formed against. The hazard the edge was closed against does not arise, and
the edge is re-opened only for the case that does not raise it.

Two things this deliberately does **not** do:

- It does not add a state, so there is **no `pixelproof.run/2` bump**. ADR 0014 §2 closes the
  state *set*; it says nothing about the transition table, and `running` already means exactly
  what a run between attempts is: in flight.
- It does not reopen a terminal state. `rejected` still has no outgoing edges. A run only stays
  open because it was never finalised, never because it was resurrected.

### 2. Where each failure hands off

| Failure | Known in | What happens |
| --- | --- | --- |
| Mechanical, retakes left | `generate` / `retake` | Recorded, corrected, and regenerated in the same process. No host is involved, so nothing has to wait. |
| Mechanical, bound spent | `generate` / `retake` | Finalised `rejected`, reason `retakes-exhausted`. Exit 1. |
| Semantic, retakes left | `judge submit` | Verdicts recorded on attempt *n*. Run moves to `running`. The correction and the exact retake command are printed. **Exit 1.** |
| Semantic, bound spent | `judge submit` | Finalised `rejected`, reason `retakes-exhausted`. Exit 1. |

`judge submit` never generates. It records, decides, and prints; the next generation is a
separate invocation the operator chooses to spend. That keeps ADR 0009's contract intact —
`surfaces/cli/commands/judge.mjs` stays out of the provider tree, and `judge submit --interactive`
on a human's terminal can never silently start a paid call.

**Exit 1, not 2.** `2` means an outstanding judgement, and after a rejecting submission there is
none — the ball is with whoever decides whether to spend another generation. `1` is also the
honest answer if the caller stops there: nothing was accepted.

### 3. `pixelproof retake --run <id>`

A new top-level command, not a flag on `generate`.

```
pixelproof retake --run <id> [--run-dir <path>] [--judge-deadline <dur>]
```

`generate --retake <id>` was rejected as the surface: every one of `--prompt`, `--out`, `--spec`,
`--size` and `--provider` comes from the run record, so the flag would sit on a command whose
options mostly do not apply and whose `--out` is mandatory. A command whose flags are exactly the
ones that mean something is worth one line in the registry.

`retake` refuses, with exit 1 and a named reason, a run that is terminal, a run with an open
judgement (answer it first), a run that never asked for a judge, and a run whose bound is spent.
It reuses ADR 0009 §3's `PENDING_ID_MALFORMED`, `PENDING_FOREIGN_ROOT`, `PENDING_NOT_FOUND` and
`PENDING_SCHEMA_UNSUPPORTED` unchanged — same mechanism, same names — and adds exactly two codes
for the genuinely new conditions:

| Reason | Condition |
| --- | --- |
| `RETAKE_EXHAUSTED` | `attempts.length >= retakes`; the bound is spent |
| `RETAKE_NOT_OPEN` | the run is terminal, has an unanswered round, or asked for no judge |

That is a deliberate, ADR-recorded extension of a closed set, which is the only way a closed set
should ever grow.

### 4. The correction is assembled from recorded evidence, never invented

The prompt for attempt *n+1* is the original prompt, the same spec folding
`foldSpecIntoPrompt()` already performs, and a **corrections block** built from what attempt *n*
actually recorded:

- a failed mechanical check contributes its name, its expected value and its measured value —
  facts code owns;
- a failed or unsure semantic assertion contributes the assertion verbatim and **the host's own
  `evidence` string verbatim**.

Core does not paraphrase, summarise, or infer a correction. Where a host returned a verdict with
no evidence, the block says the assertion failed and that no evidence was recorded, rather than
inventing a reason. Core is not in the judgement business, and a correction it made up would be
an unattributed instruction to the generator, which is the same class of failure as a judge
saying "looks good".

The original prompt therefore has to be recoverable. It is recorded in `run.json`'s `resolved`
block at generate time — an unversioned diagnostic bag by
[0014](./0014-evidence-and-report-versioning.md) §3, so adding to it costs nothing.

### 5. Rounds continue; the bound is per attempt

Round numbers do **not** restart per attempt. Attempt 1 uses rounds 1 and possibly 2; attempt 2
starts at round 3. This keeps `judge-request-<round>.json` — the filename ADR 0014 §5 reserved —
unique within the directory without inventing a two-part name. Each round summary records the
`attempt` it belongs to, so ADR 0009 §5's bound of two rounds stays exactly what it was: two per
attempt, one escalation, no round 3 *for that attempt*.

### 6. Retakes are opt-in, and only inside a judged run

`--retakes <n>` overrides `spec.retakes`; absent both, the bound is **1** — a single attempt,
which is what every invocation does today.

`spec.retakes` is honoured only when `--judge` is present. Without `--judge`, `generate` makes
exactly one provider call and behaves byte-identically, and `--retakes` is refused the way
`--judge-deadline` already is. This is not tidiness: `spec.retakes` defaults to 3 in the example
spec and in the skills, so honouring it unconditionally would turn one paid call into three for
every existing caller with a spec — a silent tripling of cost, and a documented-semantic change
ADR 0003 does not permit.

### 7. Nothing is promoted on exhaustion

When the bound is spent and no attempt was accepted, the run finalises `rejected`, **`--out`
stays empty**, and the report lists every attempt with its mechanical table and its verdicts so
an operator can choose one by hand.

`skills/image/SKILL.md` step 8 currently says the opposite — copy the best attempt to the
requested output and label it as not fully passing. That instruction predates
[0009](./0009-host-judge-handoff.md) §2's promotion-on-acceptance and cannot coexist with it: a
file at `--out` is the signal that the spec was satisfied, and a labelled exception is a label a
build script does not read. It also has no ranking function to appeal to, because scoring is
unbuilt; "best" would silently mean "last", which is arbitrary and is sometimes a regression.

**The skill is rewritten to match the tool.** If a best-attempt promotion is wanted later it needs
scoring first, and an amendment to ADR 0009 §2 — not a default that quietly hands back an
unverified image.

## Consequences

- ADR 0009 §1 gains an amendment: `judge submit` still never regenerates, and the run it leaves
  behind may now be open for a *new* attempt rather than final. The sentence that forbids
  re-running is unchanged; what changes is that "not final" becomes a third outcome beside
  accepted and rejected.
- `core/run/state.mjs` gains one edge and the comment explaining why the edge was absent is
  rewritten to explain why it is now present and what still guards it. That comment is load-bearing
  documentation and must not simply be deleted.
- A run can now end in `running` if an operator never retakes and never abandons. That is an
  orphan, and it is invisible to `judge pending` because nothing is pending. **`doctor`'s existing
  line must count it**, or ADR 0009 §4's "an abandoned handoff is visible to someone who never
  knew one happened" quietly stops being true for the retake path.
- `running` acquires a second meaning for a consumer: not only "no attempt has finished yet" but
  also "an attempt was rejected and the next one has not started". `accepted` stays `null` in
  both, which is correct — the run has not decided — and the difference is legible from
  `attempts[]` and from the rejection already appended to `reasons[]`. No consumer that switches
  exhaustively on `state` breaks, because no member was added; but a consumer that read `running`
  as "nothing has been judged yet" would now be wrong, so it is named here rather than left to be
  discovered.
- `judge abandon` must accept a run in `running`, not only one in `pending-judgement`, or a run
  left mid-retake has no way to be closed on the record.
- The bound of 1 means no existing invocation changes what it spends, and the first release that
  honours `spec.retakes` does so only for callers who opted into `--judge`.
- Contact sheets (brief §5) become possible for the first time, since more than one attempt can
  now exist. They are not in this decision's scope.

## Related

Implements the retake half of [`V2-BRIEF.md`](../V2-BRIEF.md) §5 and the loop
[`skills/image/SKILL.md`](../../skills/image/SKILL.md) describes in prose. Amends
[0009 — Host judge handoff](./0009-host-judge-handoff.md) §1 and §2 as described above, and is
bound by its promotion rule everywhere else. Consumes
[0011 — Acceptance versus scoring](./0011-acceptance-versus-scoring.md) unchanged: no count of
attempts and no ranking waives a failed assertion. Sits inside the envelope owned by
[0014 — Evidence and report versioning](./0014-evidence-and-report-versioning.md), whose
`attempts[]` guarantees it fills and whose state set it deliberately does **not** grow. Bound by
[0003 — v1 compatibility façade](./0003-v1-compatibility-facade.md): the bound of 1 and the
`--judge` gating are what keep a bare `generate` byte-identical in output and identical in cost.
