# 0009 — Host judge handoff

- **Class:** User-Challenge
- **Status:** Proposed — the recommended call is written below as the decision; it needs
  maintainer confirmation before Phase 2 implementation begins.
- **Date:** 2026-08-13

## Context

[`V2-BRIEF.md`](../V2-BRIEF.md) §3.2 specifies the `host` judge as: core "emits a machine-readable
checklist file and pauses", the host agent opens the image with its own vision capability, and
"writes verdicts back into a results file".

That deadlocks, and the deadlock is structural rather than a timing bug. The only entity that can
open the image is the agent that ran `pixelproof generate`. While core waits on a verdict file,
that agent is blocked on the child process it spawned. It cannot read the image, cannot write the
file core is waiting for, and cannot even see the checklist. Both parties wait for each other
forever. [`V2-PLAN.md`](../V2-PLAN.md) release blocker 2 flagged this; nothing has designed the
replacement.

Three constraints shape what the replacement may look like.

**The judge protocol is built and must not be bent.** `core/contracts/judge.mjs` already enforces
content-derived check ids (ADR 0010), tri-state verdicts, exactly one result per requested check,
and the consensus/acceptance rules of ADR 0011. Anything the host writes has to satisfy that
validator, not a relaxed sibling of it.

**Identity has already burned this repo twice.** v0.1.1 applied the freshness rule to one of two
artifact paths and adopted a stale file; v0.1.2 could adopt a *foreign* fresh file because
timestamps cannot say whose it is (ADR 0008). A handoff that resumes "the pending run" is the same
class of problem: two runs of the same spec against the same image produce byte-identical
checklists, so nothing derivable from content can tell them apart. Positive identity is required,
not a stricter reading of the same evidence.

**A missing verdict is never a pass.** The brief's §10 and the acceptance rule in ADR 0011 both
say so. A design where the host simply never returns must not converge on acceptance, and must not
be silent about it either.

## Decision

### 1. Two invocations, never a blocking one

`host` is not a synchronous adapter and is not modelled as one. It is a **run state**.

```
pixelproof generate --spec hero.json --out out/hero.png --judge host
  → generates, runs the mechanical tier, writes the run directory,
    writes judge-request-1.json, prints the checklist, exits 2

pixelproof judge submit --run <runId> --results verdicts.json
  → validates identity, records verdicts, finalises, exits 0 or 1
```

Core never waits on a file, never polls, and never holds a process open across the handoff. The
host agent is free the moment the first invocation exits, which is the whole point.

**Command surface.** One new top-level command, `judge`, is added to the registry in
`surfaces/cli/main.mjs`, with sub-verbs peeled off argv before flag parsing (`parseArguments`
would otherwise reject the verb as an unknown argument):

| Command | Purpose |
| --- | --- |
| `pixelproof judge pending [--json]` | List open pending runs with age, deadline and expiry state |
| `pixelproof judge show --run <id> [--request]` | Print the checklist; `--request` prints the bare protocol-1 judge request on stdout |
| `pixelproof judge submit --run <id> [--results <path>\|-] [--interactive]` | Record verdicts and finalise |
| `pixelproof judge abandon --run <id> --reason <text>` | Close a pending run as rejected, on the record |

`--judge <name>` and `--judge-deadline <duration>` are added to `generate` and `verify`. All of
this is new surface: v1 had no semantic tier in the runtime at all, so no documented v1 flag,
output or exit code changes (ADR 0003). Without `--judge` and with no `judge` block in the spec,
behaviour is byte-identical to today.

**Exit codes.** One new code, and only on the new path:

- `0` — accepted.
- `1` — rejected, or the command errored. Unchanged v1 meaning.
- `2` — **`PENDING_JUDGEMENT`: a checklist was written and no verdict exists yet.**

`2` is never a pass. This is load-bearing: every gate already written as "non-zero is failure"
(`set -e`, `if pixelproof generate; then deploy; fi`, a CI step) fails closed on a pending run
without knowing the code exists. `judge submit` returns `2` when it issues a further round, and
`judge pending` returns `2` when any pending run is open, so `2` means the same thing everywhere:
*an outstanding judgement, not a verdict*.

**Resume records verdicts; it does not re-run the run.** `judge submit` never regenerates and
never re-runs the semantic tier. It re-proves artifact identity (below) and finalises. Mechanical
results are deterministic over the same bytes and are already evidenced in the run directory, so
they are not recomputed. Regenerating on resume would produce a *different* artifact than the one
the host actually looked at, leaving verdicts that describe bytes which no longer exist — the
precise failure this project exists to prevent.

### 2. Pending state lives in the run directory, and nowhere else

There is no pending store. The run directory of Phase 2 *is* the pending state, and `run.json` is
the single source of truth for whether a run is open:

```
.pixelproof/runs/2026-08-13T09-21-04Z-a3f9c1d2/
  run.json                 schema, state, resolved spec/provider/judge, acceptance record
  attempt-1.png            the artifact, held here until accepted
  attempt-1.json           mechanical table + recorded semantic verdicts
  judge-request-1.json     the pending envelope (below)
  judge-result-1.json      verdicts as submitted
  report.md / report.json  written at finalisation and at abandonment
```

`run.json` carries `schema: "pixelproof.run/1"` and `state ∈ {running, pending-judgement,
accepted, rejected, abandoned}`, plus `accepted: false` explicitly while pending. `judge pending`
finds open runs by scanning `.pixelproof/runs/*/run.json` — deliberately no index file, because an
index is a second thing that can disagree with the truth. The run id format is
`YYYY-MM-DDTHH-MM-SSZ-<8 hex>`; the time separator is a hyphen because a colon is not a legal
Windows filename character.

The envelope shapes are versioned by the same `protocol: 1` as the judge adapter. The run and
report envelope itself is the subject of ADR 0014 (evidence and report versioning), which is not
yet written; this ADR reserves `state`, `judge-request-<round>.json` and
`judge-result-<round>.json` within it and defers the rest.

**The artifact is promoted to `--out` only on acceptance.** Under `--judge`, the generator writes
into the run directory and the file appears at `--out` when the run is accepted. An abandoned run
therefore leaves no file where a caller would look for one. This is the mechanical form of "an
unanswered checklist is not a pass"; a rejected candidate is still on disk in the run directory,
named in the report, for whoever wants to look at it.

**The envelope wraps the protocol, it does not extend it.** `judge-request-1.json` is:

```json
{
  "schema": "pixelproof.judge-pending/1",
  "protocol": 1,
  "runId": "2026-08-13T09-21-04Z-a3f9c1d2",
  "round": 1,
  "nonce": "9c2f…64 hex…",
  "issuedAt": "2026-08-13T09:21:07Z",
  "expiresAt": "2026-08-14T09:21:07Z",
  "pixelproofVersion": "0.3.0",
  "issuer": { "pid": 4812, "hostname": "…", "cwd": "…" },
  "artifact": { "path": "…/attempt-1.png", "sha256": "…", "bytes": 812344 },
  "specDigest": "…",
  "checksDigest": "…",
  "request": { "protocol": 1, "file": "…/attempt-1.png", "context": "…", "checks": [] }
}
```

`checksDigest` is the SHA-256 of the canonical JSON of the `[id, assertion]` pairs, sorted by id.
`request` is exactly what `validateJudgeRequest()` accepts today, and `response` inside
`judge-result-<round>.json` is exactly what `parseJudgeResponse()` accepts today. Nothing in
`core/contracts/judge.mjs` changes.

Sibling fields on a bare judge request were rejected as an option because ADR 0006's policy is to
reject unknown same-version fields, so that shape would break the moment the validator matches its
own ADR. Wrapping also lets `judge show --request` emit a bare, valid protocol-1 request that a
subprocess judge can consume verbatim, so one piece of host prose serves both judge kinds.

### 3. Identity is proven by a nonce, not inferred from content

`checksDigest` and `artifact.sha256` prove the *subject* is unchanged. They cannot prove *whose
pending run this is*: two concurrent runs of the same spec over the same image compute identical
digests. That is ADR 0008's single-foreign-candidate hole exactly, and the answer is the same —
positive identity, not a stricter reading of the same evidence.

Each pending record carries a **32-byte random `nonce`**. A submission must echo `runId`, `nonce`
and `checksDigest`, and the nonce is **single-use**: finalisation moves `state` off
`pending-judgement`, so a replayed submission finds no open run. Possessing the nonce proves the
submitter read *this* pending file, which is the one thing content cannot demonstrate.

`judge submit` refuses, with exit 1 and a named reason recorded in `run.json`, on any of:

| Reason | Condition |
| --- | --- |
| `PENDING_ID_MALFORMED` | `--run` fails `^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}$` |
| `PENDING_FOREIGN_ROOT` | the resolved run directory is not contained in the run root |
| `PENDING_NOT_FOUND` | no run directory, or no readable `run.json` |
| `PENDING_NOT_OPEN` | `state` is not `pending-judgement` — covers replay and double-submit |
| `PENDING_SCHEMA_UNSUPPORTED` | a `schema` or `protocol` this build does not speak |
| `PENDING_NONCE_MISMATCH` | nonce absent, or not equal to the stored one |
| `PENDING_CHECKS_MISMATCH` | `checksDigest` differs — the spec moved under the host |
| `PENDING_EXPIRED` | `now > expiresAt` |
| `ARTIFACT_CHANGED` | the file no longer hashes to `artifact.sha256` |

The run id is validated by regex *and* the resolved directory is checked for containment before
any path is built from it, so `--run ../../etc` is refused rather than followed. `issuer.hostname`
is recorded but **not** enforced: a run directory can legitimately be shared between a container
and its host, and refusing that would break a real workflow to defend against nothing the nonce
does not already cover.

These are run-rejection reasons, not adapter errors. They do not extend ADR 0006's closed adapter
enum; they are recorded in `run.json` and printed by the report.

`--run` may be omitted **only** when exactly one pending run is open. Two or more is refused,
naming each candidate, which is the same rule and the same reasoning as `selectArtifact(…,
{ policy: 'reject' })`: a run that cannot prove which pending record is its own does not get to
guess.

### 4. An unanswered checklist expires loudly and is never accepted

- Every pending record carries `expiresAt`, default **24 hours**, set by `--judge-deadline`.
- While pending, `run.json` records `accepted: false` with reason `awaiting-host-judgement`. There
  is no code path that sets `accepted: true` without a submission that passed every check in §3.
- After the deadline `judge submit` refuses with `PENDING_EXPIRED`. The run is finalised as
  **rejected**, reason `judgement-abandoned`, with a report. Expiry is a verdict about the
  *process*, never about the artifact.
- Visibility: `pixelproof judge pending` lists open runs with age and an `EXPIRED` marker and exits
  `2` when any exist, so it works as a pre-commit or CI guard. `pixelproof doctor` gains one line —
  `N pending host judgements (M expired)` — which keeps `doctor` read-only and makes an abandoned
  run visible to someone who never knew a handoff happened.
- Abandoned run directories are retained, not swept. The evidence is the point.

### 5. Escalation *is* the host handoff

ADR 0010's `onUnsure: "escalate"` means "escalate to the host". When `host` is itself the judge,
escalating to the entity that just said "I cannot tell" would be a loop. Rather than special-case
it, the two are unified: **escalation is a further pending round containing only the still-unsure
checks.**

- Rounds are bounded at **2**. Round 2 is issued with `onUnsure` forced to `fail`, recorded in the
  record as `escalationTerminal: true`. There is no round 3.
- A round-2 host verdict **replaces** the escalated verdict for that check; it does not join the
  panel for it. Under the default `all` policy, joining would leave round-1 `unsure` combined with
  round-2 `pass` as `unsure` forever, so escalation would resolve nothing. Replacement is what
  makes the host the escalation *authority*, and it is recorded as such in the report.
- In a mixed panel (`judge: ["gemini", "host"]`), subprocess judges run synchronously first, their
  per-check verdicts are recorded, and the host's checklist is then issued as a pending round.
  `combineVerdicts` runs at submit time over the full panel, unchanged.
- **The pending record never contains other judges' verdicts.** Telling a judge what another judge
  said destroys the independence that makes ADR 0010's disagreement signal worth anything.
- A judge response with `ok: false` finalises the run as **rejected**, not as a skipped tier. A
  judge that errored produced no verdicts, and no verdicts is not a pass.

### 6. Which path serves whom

| Environment | Judge | Story |
| --- | --- | --- |
| Agent host (Claude Code, Codex CLI, Gemini CLI, MCP client) | `host` | Runs generate, gets exit 2, reads `judge-request-1.json`, opens the artifact with its own vision capability, writes verdicts, runs `judge submit`. No deadlock: the agent owns both invocations. |
| Human at a terminal | `host` | Exit 2 prints the checklist in plain English plus the exact `judge submit` line to run. `judge submit --interactive` prompts per check (pass/fail/unsure plus one line of evidence) on a TTY, and **refuses when stdin is not a TTY** so it can never hang a pipeline. |
| CI, no interactive host | subprocess judge (`claude`/`codex`) | `host` is not a default anywhere non-interactive. Two-step CI jobs *may* use it, but the supported CI gate is a subprocess judge. |
| CI with no judge configured at all | none | The semantic tier reports `SKIP`, exactly as the mechanical tier does without `sharp`. `--strict` turns that `SKIP` into a failure. A declared assertion that nobody judged is unverified, never passed. |

Host availability is declared, not guessed: a surface sets `PIXELPROOF_HOST` (for example
`claude-code`) in its bundle, and `doctor` reports host judging as available only when it is set or
when `--judge host` is explicit. Guessing "there is probably an agent out there" would produce
pending runs nobody is listening for.

## Consequences

- One new exit code (`2`) enters the vocabulary, on a new flag only. It must be documented as
  "unresolved, not passed" everywhere it appears, and every gate that already treats non-zero as
  failure is correct by default.
- `core/contracts/judge.mjs`, `core/contracts/check-id.mjs` and `schema/judge-adapter.v1.json`
  need **no change**. The envelope wraps them. If a later change appears necessary, that is a
  finding against this ADR, not a licence.
- `surfaces/cli/main.mjs` gains one registry entry. Its exit normaliser already passes an integer
  `2` through unchanged. The `judge` handler must peel its sub-verb before calling
  `parseArguments`, which throws `Unknown argument: submit` on a bare word.
- `runOnce()` currently returns `ok: true` when nothing was declared to check. A pending run must
  not reach that branch; the pending decision is made before the return, or `runOnce` gains an
  explicit third outcome.
- `.pixelproof/` must be added to `.gitignore`, and the run root must be overridable
  (`--run-dir` / `PIXELPROOF_RUN_ROOT`) so CI can place it on a retained path.
- `judge pending` scans run directories. That is linear in run count and fine at local scale; if it
  ever is not, an index may be added as a *cache* rebuilt from `run.json`, never as a second truth.
- Promotion-on-acceptance means `--judge host` and bare `generate` differ in when the file appears
  at `--out`. This is deliberate and confined to the new flag, but it is the part of this design
  most likely to surprise, and it needs a prominent line in the README.
- `skills/image/SKILL.md` must be rewritten around the two-step flow. Today step 6 says "use Claude
  Code's Read tool"; it becomes "read `judge-request-1.json`, open the artifact with the host's
  image-reading capability, submit verdicts", which is host-neutral prose and is the same
  instruction the Codex and Gemini bundles will carry.
- Round bounding at 2 means a genuinely ambiguous assertion terminates in `fail` rather than in an
  endless re-ask. That is the correct default and it will occasionally be annoying.

## Related

Resolves release blocker 2 in [`V2-PLAN.md`](../V2-PLAN.md) and the `host` judge bullet of
[`V2-BRIEF.md`](../V2-BRIEF.md) §3.2. Bound by
[0003 — v1 compatibility façade](./0003-v1-compatibility-facade.md) (the new flag and exit code
must not touch v1's surface), [0004 — Adapter trust classes](./0004-adapter-trust-classes.md) (the
host is neither a trusted module nor an untrusted subprocess — it is a third thing, a caller),
[0006 — Protocol validation and error taxonomy](./0006-protocol-validation-and-error-taxonomy.md)
(the envelope rather than extra fields), and
[0008 — Artifact provenance and freshness](./0008-artifact-provenance-and-freshness.md), whose
single-foreign-candidate lesson is why identity here is a nonce and not a digest. Consumes
[0010 — Check identity, tri-state, and consensus](./0010-check-identity-tri-state-and-consensus.md)
and [0011 — Acceptance versus scoring](./0011-acceptance-versus-scoring.md) unchanged. The run and
report envelope this state lives in belongs to ADR 0014, which is not yet written.
