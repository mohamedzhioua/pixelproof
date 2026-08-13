# Pixelproof v2 planning response

Plan date: 2026-08-13. Brief of record: [`V2-BRIEF.md`](./V2-BRIEF.md).

The thesis is worth pursuing, but the brief is not implementable unchanged. The Gemini
zero-key path is no longer available to consumer accounts, the proposed synchronous `host`
judge has a control-flow deadlock, and the release bundles too many independent products into
one version. Phase 1 should establish compatibility, protocols, process safety, and truthful
capability discovery; it should not pretend those unresolved claims are already features.

## 1. Repository audit

I audited the tracked project surface on 2026-08-13: README, package metadata and lockfile,
both scripts, both provider modules, all three skills, the example spec, both test files, plugin
metadata, CI, changelog, and license. There is no project `AGENTS.md`, `CONTEXT.md`, existing
`core/`, public package entry point, or ADR set.

### What maps cleanly

| Proposed concern | Existing asset | Assessment |
|---|---|---|
| Mechanical checks | [`scripts/verify.mjs`](../scripts/verify.mjs) exports `verifyImage` and already returns a check table, counts, warnings, notes, decoder, strictness, and `ok` | This is the strongest seed for `core/`. Its PNG-header fallback and explicit `SKIP` behavior already express the optional-decoder policy. |
| Codex provider | [`scripts/providers/codex.mjs`](../scripts/providers/codex.mjs) owns subprocess invocation, Windows argument handling, timeout handling, bounded stdout/stderr tails, and post-run fallback discovery | It is already close to a built-in provider adapter, although its result and error shapes do not match the proposed protocol. |
| SVG provider | [`scripts/providers/svg.mjs`](../scripts/providers/svg.mjs) owns SVG validation, output, and optional `sharp` rasterization | It can become a trusted built-in provider with little conceptual change. |
| Provider selection | [`scripts/generate.mjs`](../scripts/generate.mjs) has an explicit precedence chain: flag, environment, SVG extension, Codex on `PATH` | The behavior is small enough to preserve behind a generic registry and characterize with tests. |
| Spec seed | [`specs/product-hero.example.json`](../specs/product-hero.example.json) plus `assertSpec`, dimension resolution, prompt folding, and verification implement a small v1 contract | v1 can be retained as a normalization input rather than migrated in place. |
| Host semantic loop | [`skills/image/SKILL.md`](../skills/image/SKILL.md) defines atomic visual checks, bounded retakes, correction prompts, and a receipt | This is useful workflow policy, but it is prose executed by Claude, not runtime orchestration that can simply be “extracted.” |
| Claude distribution | [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json), marketplace metadata, and `skills/` form a working Claude Code surface | It can remain a compatibility surface while host-neutral wording is introduced later. |
| Baseline CI | [`.github/workflows/test.yml`](../.github/workflows/test.yml) tests Node 22/24 on Ubuntu and Windows | It is a sound start for the required matrix. |

The local baseline check on 2026-08-13 passed all 7 tests on Node 24.15.0. `sharp` was absent
from the local install, and the existing no-`sharp` test passed. That is evidence for the current
degraded path, not evidence for the full required “with and without `sharp` on three operating
systems” matrix.

### What is entangled or missing

- [`scripts/generate.mjs`](../scripts/generate.mjs) is simultaneously a CLI parser, spec loader,
  provider resolver, dimension resolver, Codex capability validator, prompt compiler, provider
  dispatcher, verifier, reporter, and exit-code policy. This is the main extraction seam.
- [`scripts/verify.mjs`](../scripts/verify.mjs) mixes reusable inspection and check logic with
  argument parsing, console formatting, JSON formatting, and process exit behavior. Its exported
  function helps, but the boundary is not yet clean.
- The two providers share no declared interface. They return different fields, throw arbitrary
  `Error` objects, and detect availability outside the provider modules.
- “Retake loop,” semantic verdicts, scoring, run evidence, reporting, cache, batch verification,
  and consensus do not exist in runtime code. Calling Phase 1 an extraction of all `core/`
  responsibilities understates how much is greenfield work.
- Codex dimension rules live in the CLI and are only enforced for
  `--size` without `--spec`. The same dimensions resolved from a spec bypass that preflight.
  Moving the rules into capabilities will intentionally fix an inconsistency, so the gate cannot
  literally promise zero behavior change.
- The freshness guarantee is weaker than the README and brief imply. A pre-existing file at the
  requested output path is accepted because the provider never removes or timestamps it before
  launch. Fallback discovery also scans every Codex session under one home and can adopt another
  concurrent run's post-start PNG. Existing tests cover stale fallback rejection, but not these
  two cases.
- `package.json` is `"private": true` and has no `bin` entry. A local `bin/pixelproof.mjs` is
  possible, but npm/MCP/action distribution is not defined merely by adding that file.
- The current tests concentrate on Codex fallback and one no-`sharp` CLI case. There are no
  compatibility tests for help/error text, provider precedence, environment flags, SVG,
  successful `sharp` pixel checks, direct stale outputs, process-tree termination, or exact
  documented CLI output.

## 2. Risks, incorrect assumptions, and scope corrections

External sources below were retrieved on 2026-08-13 unless a publication or update date is
shown.

### Release blockers

1. **The Gemini default path is false as written.** Gemini CLI exists and remains installable
   via npm/Homebrew, but Google says that on 2026-06-18 it stopped serving Gemini CLI requests
   for Gemini Code Assist for individuals, Google AI Pro, and Google AI Ultra, and disabled
   “Login with Google” for those users. Only Standard/Enterprise Code Assist and API-key/cloud
   paths remain unaffected. Google's current repository README still advertises the old
   consumer-login path, so the docs conflict; the dated deprecation notice is controlling.
   ([Google deprecation notice, last updated 2026-06-23](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals);
   [Gemini CLI repository/install instructions, accessed 2026-08-13](https://github.com/google-gemini/gemini-cli))

   Image generation is not a built-in Gemini CLI subscription tool “in the same pattern as
   Codex.” The Gemini CLI README points media generation to an external GenMedia MCP project;
   that project requires Google Cloud Application Default Credentials and a project, and labels
   itself not officially supported. Therefore `gemini` must be an opt-in API/Vertex adapter, or
   be removed until another supported zero-key contract is proven. The Definition of Done for a
   consumer with “only Gemini CLI” and no key is currently impossible.
   ([Google Cloud GenMedia MCP README, accessed 2026-08-13](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia))

2. **The synchronous `host` judge design deadlocks.** If an agent launches
   `pixelproof generate` and core “pauses” waiting for a verdict file, that same agent is blocked
   waiting for the child process and cannot inspect the image or write the verdict. `host` is
   not a normal synchronous adapter. It needs a two-step protocol: emit a pending checklist and
   exit with a distinct status, then let the host submit verdicts and resume/finalize the run.

3. **The trust model contradicts the adapter contract.** A dynamically imported `.mjs` module
   executes with the Pixelproof process's full authority; it is not an untrusted subprocess.
   The brief must choose either (a) trusted bundled/in-process modules plus untrusted external
   executables, or (b) subprocess isolation for every adapter. The recommended call is (a), with
   explicit trust labels and no loading of arbitrary project modules by default.

4. **The executable provider protocol is incomplete.** Generation request/response is defined,
   but `detect` and `capabilities` negotiation for executables is not. “Validate adapter JSON”
   refers to a configuration shape that the brief never defines. Core cannot preflight an
   arbitrary executable until there is a versioned manifest or a separate handshake operation.

5. **“Provably satisfies” is too strong for model judgments.** Mechanical checks can produce
   reproducible evidence; a vision model produces a fallible, nondeterministic opinion.
   Multi-vendor agreement reduces some correlated error but is not proof or true statistical
   independence. Product language should be “evidence-backed acceptance gate,” and judge/model
   versions must be recorded.

6. **Scoring can undermine the thesis.** `minScore: 90` can accept an artifact with a failed
   assertion unless hard gates are distinguished from ranking signals. The recommended rule is:
   hard mechanical and required semantic assertions always gate; score ranks otherwise eligible
   attempts and explains the best failed attempt. Any “soft” check must be explicitly marked
   soft in the spec.

### Empirical feasibility checks

- **Codex can be a visual host: confirmed at the CLI capability level.** Official OpenAI
  documentation lists `--image/-i` on `codex exec`, non-interactive execution, a final-message
  output file, and `--output-schema` validation. That is enough to attach the artifact and request
  per-assertion JSON verdicts. It does not prove Pixelproof's inverse Codex-host/Claude-judge flow
  end to end; that still needs a live Phase 2 proof with authentication, file permissions,
  failure handling, and the asynchronous host handoff.
  ([OpenAI Codex developer commands, accessed 2026-08-13](https://learn.chatgpt.com/docs/developer-commands?surface=cli))

- **MCP adds real reach, but distribution is immature.** Codex clients and Gemini CLI both
  support stdio/HTTP MCP servers, so an MCP surface reaches hosts that cannot install a Claude
  Code plugin. The official MCP Registry, however, is still preview and stores metadata rather
  than artifacts; a local server still needs an npm/Docker/other distribution, and this repo is
  currently private-to-npm. MCP is a valid later surface, not the first distribution solution.
  ([OpenAI MCP support, accessed 2026-08-13](https://learn.chatgpt.com/docs/extend/mcp);
  [Gemini CLI MCP support, last updated 2026-06-18](https://geminicli.com/docs/tools/mcp-server/);
  [official MCP Registry overview, accessed 2026-08-13](https://modelcontextprotocol.io/registry/about);
  [registry publishing quickstart, accessed 2026-08-13](https://modelcontextprotocol.io/registry/quickstart))

- **A composite GitHub Action is reasonable for the mechanical gate.** Composite actions may
  contain both `run` and `uses` steps, so the action can install an explicit Node 22/24 runtime
  and invoke repo-local JS cross-platform. `sharp` publishes prebuilt binaries for current
  Linux, macOS, and Windows targets, but its documentation warns that optional dependencies and
  cross-platform npm lockfiles need care. The action must test installation failure and honestly
  `SKIP`/fail under `strict`. It must not assume a semantic judge is authenticated on a hosted
  runner; Anthropic's own GitHub Action documents API/cloud credentials for CI.
  ([GitHub composite metadata syntax, accessed 2026-08-13](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax?learn=create_actions);
  [`setup-node`, accessed 2026-08-13](https://github.com/actions/setup-node);
  [`sharp` installation, accessed 2026-08-13](https://sharp.pixelplumbing.com/install/);
  [Claude Code GitHub Actions, accessed 2026-08-13](https://docs.anthropic.com/en/docs/claude-code/github-actions))

  The advertised `pixelproof/verify@v2` is not a valid reference to this current repository
  unless distribution moves to an owner/repository pair with exactly that name. A root action in
  this repo would use `mohamedzhioua/pixelproof@v2`; a subdirectory action would add the
  subdirectory before `@v2`.

- **Pure-JS pHash and delta-E over raw pixels are feasible with bounded inputs.** `sharp` can
  resize and return raw pixel buffers. A DCT perceptual hash can operate on a fixed small
  downsample, making the JavaScript work fixed and tiny relative to decoding. CIEDE2000 is a
  numeric formula with published reference data suitable for a dependency-free implementation.
  Palette extraction should likewise operate on a bounded sample, not every full-resolution
  pixel. This is an engineering inference from the documented primitives, and it should be
  confirmed with a microbenchmark on the maximum supported image size.
  ([`sharp` resize API, accessed 2026-08-13](https://sharp.pixelplumbing.com/api-resize/);
  [`sharp` raw buffers, accessed 2026-08-13](https://sharp.pixelplumbing.com/api-output/#raw);
  [pHash DCT design/validation, accessed 2026-08-13](https://www.phash.org/docs/design.html);
  [Sharma, Wu, and Dalal CIEDE2000 implementation paper, published 2005](https://doi.org/10.1002/col.20070))

  Two cautions matter. pHash itself says DCT hashes are not semantically meaningful and gives a
  threshold derived from its corpus, so duplicate thresholds need Pixelproof-specific
  calibration. “OCR-free text likelihood” is a noisy heuristic, not verification; it may
  prioritize model review but should not hard-fail acceptance without a measured false-positive
  policy.

### Architecture and ordering risks

- The existing “newest post-start PNG” fallback is not safe under concurrent Codex runs and does
  not protect a stale direct target. Phase 1 must fix provenance before abstracting the code.
- Process safety needs more than a timeout: bounded stdin/stdout/stderr, maximum JSON-line size,
  schema rejection, no shell command strings, environment policy, exact output-path validation,
  symlink/path checks, and real process-group termination on Unix and Windows. The current Unix
  code signals only the immediate child.
- The provider request is biased toward generative rasters. It does not define HTML template
  input, SVG source, multi-file assets, or how `negative` behaves for providers without a native
  negative prompt. Hiding these in untyped `options` defeats portable capabilities.
- Judge result IDs arrive before Spec v2 defines stable check IDs. Composition, negative-to-check
  expansion, scoring weights, consensus, and report diffs all require deterministic IDs. The
  identity rule belongs in foundations, even if Spec v2 syntax ships later.
- `all`/`any`/`majority` is underspecified for `unsure`, missing results, judge errors, and a
  two-judge tie. A truth table is required before Phase 2.
- The cache key is incomplete. It omits adapter/protocol version, provider configuration,
  reference file contents, refinement inputs, and model alias resolution. A cached image must
  still be provenance-checked and normally reverified against the current verifier/judges.
- “Every invocation” should not create a run for `doctor`, `spec validate`, or `cache clear`.
  Limit evidence directories to generate, verify, and tournament operations.
- Run directories in Phase 2 precede the stable report/check/spec identity designed in Phase 3.
  Define the report envelope and check IDs before persisting evidence, even if most Spec v2
  features remain Phase 3.
- The `html` provider is promised and required by the proof example but appears in no
  implementation phase. Browser detection, fonts, rendering flags, network policy, and
  reproducibility are substantial and need their own phase.
- `init`, batch `verify --dir`, `watch`, and the HTML provider are also absent from the phase task
  lists. `watch` in particular is a separate cross-platform daemon UX and should be deferred
  until the non-watching commands are proven.
- Tournament, cache, contact sheets, JUnit, SARIF, MCP, three host bundles, a GitHub Action, and
  three polished examples are too much for one v2 release. SARIF is not required merely to get a
  PR annotation; GitHub workflow commands can annotate an asset path with less machinery.
- The “one new provider file, under 40 lines” Definition of Done is a demo constraint, not a
  maintainability guarantee. A real provider also needs tests and documentation. Keep “zero
  core changes,” drop the line-count promise, and allow provider-owned tests/fixtures.
- Existing array concatenation for `extends` can duplicate checks, judges, and variants; matrix
  expansion can explode cost. Composition needs cycle detection, path rules, deduplication/IDs,
  and a maximum expanded-run count.

### Recommended scope correction

Treat the six phases as a roadmap, not one release gate:

1. **Foundations release:** v1 characterization, core extraction, complete adapter manifests and
   schemas, Codex/SVG ports, truthful `doctor`, process/provenance hardening, and compatibility
   shims.
2. **Evidence release:** asynchronous host handoff, one proven subprocess judge, heuristic
   prefilters, stable run/report schemas, and calibrated acceptance semantics.
3. **CI/spec release:** the smallest useful Spec v2 subset, batch verification, and the GitHub
   Action. This validates the differentiated product before provider tournaments.
4. **Expansion releases:** HTML, key-based Google/OpenAI providers, variants, cache/tournament,
   then MCP and additional host bundles. Add `watch` only with demonstrated demand.

### Open questions requiring maintainer decisions or a proof

- May the Google provider require an API key/Vertex credentials, or should it be removed from v2?
  Do not substitute Antigravity CLI until its generation, automation, authentication, and
  licensing contracts are separately verified.
- Is `host` allowed to be an explicit two-command/resume flow? Recommended: yes.
- Are built-in modules trusted while third-party adapters must be executables? Recommended: yes.
- Are all v1 console strings and JSON fields byte-for-byte public, or only flags, exits, and
  documented semantics? Recommended: snapshot the documented examples and preserve JSON fields;
  allow clearer diagnostics for newly detected safety failures.
- Which noninteractive judge is the first supported CI judge, and which secret/cloud
  authentication methods are acceptable?
- Are semantic assertions always hard gates? Recommended: yes; scoring ranks, it does not waive.
- Which color contract is intended: CIEDE2000 under sRGB/D65, what alpha compositing background,
  which ICC/profile behavior, and whether palette compliance applies to all sampled pixels or
  only dominant clusters?
- What corpus defines “duplicate,” what Hamming threshold is acceptable, and where is the
  accepted-asset index stored?
- Will Pixelproof become a public npm package? That decision controls CLI, MCP Registry, and
  GitHub Action installation.
- Is the macOS CI cost acceptable for the full Node × OS × `sharp` matrix? It is required by the
  stated Definition of Done.

## 3. Proposed ADR list

The class column follows the project's planning convention: Mechanical decisions can be made
from constraints, Taste decisions choose among reversible designs, and User-Challenge decisions
need maintainer confirmation. Each User-Challenge row includes the recommended call.

| ADR | Class | Decision and one-line rationale |
|---|---|---|
| 0001 — v2 scope and non-goals | User-Challenge | Confirm the staged releases above and defer `watch`/tournament polish, because the current all-at-once scope cannot produce reviewable gates. |
| 0002 — Four-layer dependency rule | Mechanical | `surfaces → core → contracts` with vendor code behind adapters keeps core vendor-neutral and makes boundary tests possible. |
| 0003 — v1 compatibility façade | User-Challenge | Keep legacy scripts as in-process shims and freeze documented exits/output; permit only explicit safety-tightening changes. |
| 0004 — Adapter trust classes | User-Challenge | Trust bundled `.mjs` adapters, require third-party adapters to run out of process, and never auto-import arbitrary project code. |
| 0005 — Adapter manifest and discovery | Mechanical | Use a versioned declarative manifest/handshake so detection and capabilities are available before generation and a new provider does not alter core. |
| 0006 — Protocol validation and error taxonomy | Mechanical | Validate bounded request/response objects at both boundaries and map all failures to the closed public error enum. |
| 0007 — Subprocess lifecycle and resource limits | Mechanical | Spawn without a shell, bound output, enforce deadlines, and kill the whole process tree to uphold the untrusted-adapter constraint. |
| 0008 — Artifact provenance and freshness | User-Challenge | Require a run-owned target or isolated provider workspace plus post-start identity checks; do not keep global “newest PNG” as the sole correlation mechanism. |
| 0009 — Host judge handoff | User-Challenge | Model `host` as pending/submit/resume rather than a synchronous adapter to avoid deadlock and support humans as well as agents. |
| 0010 — Check identity, tri-state, and consensus | Mechanical | Stable IDs and an explicit truth table are prerequisites for composition, scoring, disagreement reports, and `unsure` handling. |
| 0011 — Acceptance versus scoring | User-Challenge | Hard assertions always gate while scores rank candidates; this preserves the product thesis and prevents weighted acceptance of known failures. |
| 0012 — Spec resolution and expansion limits | Taste | Normalize v1/v2 into one internal form, detect `extends` cycles, and cap variant expansion for predictable cost. |
| 0013 — Pixel engine, color science, and heuristic status | User-Challenge | Keep `sharp` optional, standardize sRGB/D65 CIEDE2000, downsample boundedly, and label text/pHash results as calibrated heuristics. |
| 0014 — Evidence and report versioning | Mechanical | Version `run.json`/`report.json` before persistence so later spec and surface changes do not corrupt consumers. |
| 0015 — Cache identity and invalidation | Mechanical | Hash resolved inputs, reference contents, adapter/model versions, and verification versions separately to prevent false hits. |
| 0016 — Authentication and support tiers | User-Challenge | Codex subscription remains the local default; CI/model providers are explicitly key/cloud/preauthenticated, and Google is not advertised as zero-key. |
| 0017 — Package and surface distribution | User-Challenge | Decide public npm ownership and action coordinates before MCP/action work; registry metadata alone is not distribution. |
| 0018 — HTML rendering determinism | Taste | Treat browser rendering as an optional provider with pinned discovery, offline/network policy, font recording, and reproducibility warnings. |

## 4. Concrete Phase 1 task breakdown

### Phase 1 goal and adjusted gate

**Goal:** create stable internal seams and truthful capability discovery while preserving the
documented v1 commands.

**Gate:** all legacy flags, successful outputs, JSON fields, and exit behavior remain compatible;
`pixelproof doctor` is an explicitly additive command; stale-output and process-termination
holes may be tightened as documented safety fixes. No Gemini, judge execution, run directories,
Spec v2 behavior, cache, tournament, MCP, action, or HTML rendering enters this phase.

### Tests to write before movement

| First red test file | Behaviors frozen or exposed |
|---|---|
| `test/generate-cli.compat.test.mjs` | Help/error text, required options, provider precedence, default 1024 square, `--size` parsing, spec-authoritative dimensions and warning, exit status, stdout/stderr channel, environment model/effort/timeout behavior. |
| `test/verify-cli.compat.test.mjs` | Human table headline/summary, JSON field set, `--strict` semantics, empty mechanical block, invalid spec/check errors, exact exit codes, path normalization. Replace the narrow current file or retain it while adding these cases. |
| `test/verify-core.test.mjs` | Width, height, aspect tolerance, corners tolerance, alpha modes, max bytes, malformed PNG, with-`sharp` results, and explicit no-`sharp` skips through an injected/isolated capability seam. |
| `test/svg-provider.test.mjs` | Valid SVG passthrough, malformed XML/root/viewBox rejection, PNG rasterization with `sharp`, and companion-SVG plus warning without it. |
| `test/codex-provider.test.mjs` additions | Reject a pre-existing direct target, never adopt a concurrent unrelated PNG, accept only run-owned post-start output, preserve literal prompt arguments, bound logs, classify exit/no-file/timeout, and kill a spawned descendant on Windows and Unix. |
| `test/provider-protocol.test.mjs` | Exact request/response schemas, unknown fields policy, manifest/capability validation, closed errors, unsupported size/reference/seed preflight, malformed/trailing/oversized stdout, and output-path mismatch. |
| `test/judge-protocol.test.mjs` | Schema only in Phase 1: stable check IDs, complete one-result-per-check rule, verdict enum, confidence bounds, duplicate/missing IDs, and protocol-version rejection. |
| `test/provider-discovery.test.mjs` | Flag/env/extension/default selection, missing executable, duplicate IDs, deterministic ordering, trusted module versus executable metadata, and an echo fixture discovered without a core edit. |
| `test/doctor-cli.test.mjs` | Deterministic matrices for no provider, Codex only, SVG only, `sharp` present/absent, auth unknown, and precise remediation; tests must fake probes and never require live vendor calls. |
| `test/legacy-shims.test.mjs` | `scripts/generate.mjs` and `scripts/verify.mjs` produce the same normalized output/exit as the corresponding `bin/pixelproof.mjs` generate or verify command for every documented example. |

Do not use snapshots containing absolute temp paths or platform-specific quoting without
normalization. Provider tests should use fake executables and temporary directories; live model
calls do not belong in the required unit/integration suite.

### Slice 1 — Record the decisions and compatibility contract

Planned files:

- `docs/adr/0001-v2-scope-and-non-goals.md` through the Phase 1-relevant ADRs 0008, plus
  `docs/adr/README.md` as an index.
- `test/fixtures/` only for small committed binary/spec fixtures that cannot be built clearly in
  tests; no fixture may depend on `.pixelproof-scratch/`.
- The compatibility tests listed above.

Actions:

1. Resolve the User-Challenge ADRs that block Phase 1: compatibility strictness, adapter trust,
   provenance, and Google removal from the zero-key promise.
2. Capture normalized golden outputs for every README command before moving code.
3. Add a test proving the currently documented stale-fallback rule, then add failing tests for
   stale direct targets and concurrent unrelated outputs so the safety correction is explicit.

Checkpoint: only ADRs/tests/fixtures changed; existing implementation still passes old tests and
the new characterization subset except for the deliberately exposed safety/protocol gaps.

### Slice 2 — Define contracts before adapters

Planned files:

- `schema/provider-adapter.v1.json` — manifest, capability, request, success, and failure shapes.
- `schema/judge-adapter.v1.json` — request, per-check result, success, and failure shapes.
- `schema/adapter-config.v1.json` — executable path/argv, trust, timeout, environment names, and
  any static capability declaration if the handshake does not supply it.
- `core/contracts/provider.mjs` and `core/contracts/judge.mjs` — dependency-free runtime
  validation and normalization.
- `core/contracts/errors.mjs` — the closed error codes and mapping helpers.
- `core/contracts/check-id.mjs` — deterministic IDs needed by the judge protocol.

Actions:

1. Decide whether executable capabilities come from a static manifest or a
   `{ protocol: 1, operation: "describe" }` handshake; document exactly one method.
2. Define maximum request/response/log sizes, unknown-field policy, protocol negotiation, path
   encoding, and error-to-exit mapping.
3. Keep JSON Schema and hand-written validation in parity with table-driven conformance fixtures.

Checkpoint: protocol tests green; no vendor names imported anywhere under `core/contracts/`.

### Slice 3 — Extract the reusable v1 core without adding v2 behavior

Planned files:

- `core/spec/load-v1.mjs` — parse and normalize today's spec shape.
- `core/spec/dimensions.mjs` — positive integers, aspect parsing, defaults, and precedence.
- `core/verification/inspect.mjs` — `sharp` discovery, metadata, raw pixels, and PNG-header
  fallback.
- `core/verification/mechanical.mjs` — current checks and `SKIP` decisions.
- `core/verification/result.mjs` — stable result/count/strict policy.
- `core/generation/prompt-v1.mjs` — current prompt folding only.
- `core/generation/run-once.mjs` — generic one-attempt provider invocation followed by optional
  mechanical verification; no retakes, evidence directory, or scoring yet.

Actions:

1. Move pure logic in small commits/checkpoints without renaming public flags.
2. Inject decoder/provider/environment probes so tests do not mutate global installs.
3. Keep console formatting out of core.

Checkpoint: core tests and all characterization tests green; `core/` imports no provider or
surface module.

### Slice 4 — Build the generic adapter runtime and port Codex/SVG

Planned files:

- `core/adapters/discover.mjs` — deterministic registry/discovery against manifests.
- `core/adapters/preflight.mjs` — generic capability checks.
- `core/adapters/subprocess.mjs` — bounded JSON I/O, timeout, process-group termination, and
  error mapping.
- `core/artifacts/provenance.mjs` — run-owned target setup and post-run validation.
- `providers/codex.mjs` and `providers/svg.mjs` — trusted built-ins implementing the provider
  contract.
- `scripts/providers/codex.mjs` and `scripts/providers/svg.mjs` — temporary re-export shims if
  preserving these import paths is desired.
- `test/fixtures/providers/echo.mjs` and fake executable fixtures — discovery/conformance proof,
  not production providers.

Actions:

1. Move all Codex-specific dimensions to its capability record and apply them regardless of
   whether dimensions came from `--size`, a spec, or defaults.
2. Replace global fallback correlation with the ADR-approved provenance scheme. If compatibility
   requires scanning Codex's generated-images directory, isolate the invocation's Codex home or
   record a unique run marker and reject ambiguity.
3. Ensure timeout kills descendants and the parser cannot be flooded by adapter output.
4. Prove an echo fixture is added without modifying `core/`; do not impose an arbitrary
   40-line production rule.

Checkpoint: provider/provenance/process tests green on all three OS families; legacy Codex and
SVG CLI behavior remains compatible except the approved safety tightening.

### Slice 5 — Add the CLI surface and legacy shims

Planned files:

- `surfaces/cli/parse.mjs` — shared subcommand/legacy argument parsing.
- `surfaces/cli/format-verification.mjs` and `surfaces/cli/format-errors.mjs` — current text/JSON
  presentation.
- `surfaces/cli/commands/generate.mjs`, `verify.mjs`, and `doctor.mjs`.
- `surfaces/cli/main.mjs` — routing and exit policy.
- `bin/pixelproof.mjs` — executable entry point.
- Existing `scripts/generate.mjs` and `scripts/verify.mjs` — thin in-process shims.
- `package.json` — additive `bin` and scripts entries; no required dependencies.
- `package-lock.json` only if npm updates root package metadata.

Actions:

1. Keep legacy usage banners and flag meanings stable.
2. Make `pixelproof generate` and `verify` call the same command handlers as the shims, not spawn
   another Node process.
3. Keep `doctor` read-only. Authentication checks must be bounded and distinguish
   `available`, `unavailable`, and `unknown/not safely probeable` rather than claiming success.

Checkpoint: all shim equivalence and doctor matrix tests green.

### Slice 6 — Expand CI to enforce the real gate

Planned files:

- [`.github/workflows/test.yml`](../.github/workflows/test.yml) — Node 22/24 ×
  Ubuntu/macOS/Windows × optional dependencies present/omitted, subject to the maintainer's cost
  confirmation.
- `package.json` test scripts only if separate conformance/compatibility commands improve CI
  diagnosis.
- `README.md` and `CHANGELOG.md` — only the additive `doctor`/CLI and approved safety change;
  no v2 marketing claims yet.

Actions:

1. Run `npm ci` for the `sharp` lane and `npm ci --omit=optional` for the degraded lane.
2. Assert `sharp` actually imports in the first lane and does not import in the second; do not
   infer lane state from npm success.
3. Run the full suite on each required matrix cell and retain serial process-spawning tests.
4. Add a boundary check that `core/` does not import `providers/` or `surfaces/`, and verify no
   required runtime dependencies were introduced.

Phase 1 is complete only when:

- all documented v1 commands pass compatibility tests;
- both protocol schemas and validators pass conformance tests;
- Codex/SVG run behind the generic provider contract;
- stale or ambiguous artifacts are rejected;
- timeouts terminate process trees;
- `doctor` reports capabilities without live paid calls;
- the Node/OS/`sharp` matrix is green; and
- only the additive CLI/doctor and approved safety tightening are user-visible.

There is no data migration in Phase 1. Rollback is the legacy-script façade: each slice remains
reviewable and revertible while the old entry points stay present. Do not delete
`scripts/providers/` shims or change package distribution until the compatibility gate and
public-package ADR are accepted.
