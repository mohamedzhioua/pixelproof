# `judges/`

Judge adapters. A judge looks at one artifact, answers one verdict per requested
check, and does nothing else.

This layer is to `core/contracts/judge.mjs` what `providers/` is to
`core/contracts/provider.mjs`: vendor knowledge lives here, the contract lives in
`core/`, and the dependency runs one way only (ADR 0002). `core/` never imports
`judges/`.

## What a judge module exports

| Export | Meaning |
| --- | --- |
| `id` | Lowercase kebab-case identity, unique across adapters. |
| `manifest` | Declared capabilities, including an `auth` record. Frozen data, never a probe. |
| `detect(options?)` | Cheap, read-only, no network, no paid call. Returns `{ available, reason }`. |
| `judge(request, options?)` | Takes a protocol-1 judge request, resolves with a protocol-1 judge response, or rejects with an `AdapterError` from the closed taxonomy. |

Three rules are not negotiable:

1. **Availability is not authentication** (ADR 0016). Being on PATH means
   `available`. Login state is `unknown / not safely probeable` unless it can be
   proven at zero cost, and nothing here shells out to find out.
2. **Every reply goes through `parseJudgeResponse(raw, { expectedIds })`.** A
   judge that answers the wrong checks, duplicates one, or omits one is rejected.
   A summary opinion without per-assertion verdicts is a protocol violation, not
   a pass.
3. **No failure resolves to results.** A timeout, a non-zero exit, an
   unparseable reply, or an `ok: false` payload rejects with an `AdapterError`.
   There is no partial-results outcome.

## Bundled

### `codex.mjs`

Drives `codex exec` (verified against codex-cli 0.147.0):

| Flag | Why |
| --- | --- |
| `-i, --image <FILE>` | Attaches the artifact under judgement. |
| `--output-schema <FILE>` | Constrains the reply to the judge-response shape and to the exact check ids that were asked. |
| `-o, --output-last-message <FILE>` | The reply channel. The transcript goes to stderr and the final message to stdout, but the file does not depend on the model emitting single-line JSON. |
| `--sandbox read-only` | The judge looks; it does not write. |
| `--skip-git-repo-check`, `-C <DIR>` | The scratch working directory is not a repository and must not need to be. |
| `--ephemeral`, `--color never` | Leave no session behind; leave no ANSI escapes in a report. |

The request crosses on **stdin**, verbatim: `codex exec` appends a piped stdin as
a `<stdin>` block when a prompt argument is present, so the bare protocol-1
request that `pixelproof judge show --request` emits (ADR 0009 §2) is exactly
what the model sees. Nothing is rewritten into prose on the way.

Authentication uses the CLI's own credentials under `CODEX_HOME`.
`OPENAI_API_KEY` is **not** forwarded by default — the transport forwards nothing
implicitly. A caller that authenticates by key must say so:

```js
await judge(request, { envAllowlist: ['OPENAI_API_KEY'] });
```

Environment overrides: `PIXELPROOF_JUDGE_TIMEOUT_MS`,
`PIXELPROOF_JUDGE_CODEX_MODEL`, `PIXELPROOF_JUDGE_CODEX_EFFORT`.

## Testing a judge

`test/judge-codex.test.mjs` never runs a vendor CLI and never touches the
network. The stand-in is a Node script invoked through `process.execPath` — the
same technique as `test/adapter-subprocess.test.mjs` — which keeps the tests
hermetic and sidesteps the Windows `.cmd`/PATHEXT resolution problem, because the
executable is always a real `.exe` and the script is just an argument. The
`command`/`args` options on `judge()` are the seam.
