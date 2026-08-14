/**
 * `pixelproof doctor` — what can this installation actually do, right now?
 *
 * The command exists because the two things that silently change what
 * Pixelproof can do are invisible at the point of use: whether a provider's CLI
 * is installed, and whether `sharp` resolves. A run without `sharp` still
 * *passes*; it simply stops checking corners and alpha and reports them as
 * SKIP. That is the single most common source of "it said PASS, so why is the
 * image wrong?", so `doctor` names the skipped checks explicitly rather than
 * printing a decoder version and leaving the inference to the reader.
 *
 * Three rules govern everything below.
 *
 * 1. **Read-only.** Detection may look for an executable on PATH and may try to
 *    import an optional module. It must never spend a paid call, require auth to
 *    succeed, or touch the network. `doctor` is what you run *before* you are
 *    willing to spend anything.
 * 2. **Three authentication states, not two.** `available`, `unavailable`, and
 *    `unknown / not safely probeable`. Being on PATH is availability, not a
 *    login. Claiming "ready" for something that will fail at the first call is
 *    exactly the failure mode this project exists to prevent, so an honest
 *    `unknown` is preferred over a confident guess in every case where proving
 *    it would cost a call.
 * 3. **Bounded.** Every probe — module load, detect, decoder import, auth — runs
 *    under a timeout, and the losing side is abandoned and cleared rather than
 *    awaited. A wedged CLI or a hung import turns into a reported line, never a
 *    hung command and never a silent one.
 *
 * The exit code answers one question: can this environment run at all? Zero
 * when at least one provider is available, one when nothing can run. Missing
 * `sharp` is degraded-but-usable and stays zero, with the skips named.
 *
 * ## The `probes` seam
 *
 * `probes` exists so the matrix in `test/doctor-cli.test.mjs` can be exercised
 * without installing, uninstalling, or authenticating anything:
 *
 * ```js
 * probes = {
 *   providers?: () => Promise<Array<{
 *     id, trust?, kinds?, available, reason?, manifest? | capabilities?
 *   }>>,
 *   decoder?: () => Promise<{ sharp: unknown|null, error?: unknown }>,
 *   auth?: (row) => Promise<{ state, detail? }> | { state, detail? },
 *   pending?: () => Promise<Array<{ record: object|null, error: object|null }>>,
 *   output?: Console,     // console-like sink; defaults to the real console
 *   timeoutMs?: number,   // default probe budget; --timeout overrides it
 * }
 * ```
 *
 * Every one of those is bounded by the same timeout as the real probe it
 * replaces, so the tests exercise the timeout path too rather than a
 * fast-path-only imitation of it.
 */

import { hasExpired, listPendingRuns, listStalledRuns } from '../../../core/judge/index.mjs';
import { loadSharpDecoder } from '../../../core/verification/inspect.mjs';
import { printUsage, printUsageError } from '../format-errors.mjs';
import { parseArguments } from '../parse.mjs';

export const DOCTOR_USAGE = `pixelproof environment report

Usage:
  pixelproof doctor [--json] [--timeout <ms>] [--run-dir <path>]

Options:
  --json              Print a machine-readable report
  --timeout <ms>      Budget for each probe (default 3000)
  --run-dir <path>    Run root to scan for pending judgements; also
                      PIXELPROOF_RUN_ROOT (default .pixelproof/runs)
  -h, --help          Show this help

doctor is read-only: it detects installed tools, never invokes a provider to
generate anything, and never spends a paid call. Authentication that cannot be
proven cheaply and safely is reported as "unknown", not as success.
`;

/** Per-probe budget. Small, because every probe here is a local lookup. */
export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export const AUTH_AVAILABLE = 'available';
export const AUTH_UNAVAILABLE = 'unavailable';
export const AUTH_UNKNOWN = 'unknown';

/** The human wording for each state. `unknown` says *why* it is unknown. */
const AUTH_LABEL = Object.freeze({
  [AUTH_AVAILABLE]: 'available',
  [AUTH_UNAVAILABLE]: 'unavailable',
  [AUTH_UNKNOWN]: 'unknown / not safely probeable',
});

/**
 * Mechanical checks split by whether they need decoded pixels. These names are
 * the check names `core/verification/mechanical.mjs` emits, so a reader can
 * match a SKIP row in a verification table to a line in this report without
 * translation.
 */
export const CHECKS_WITHOUT_DECODER = Object.freeze(['width', 'height', 'aspect', 'maxBytes']);
export const CHECKS_REQUIRING_DECODER = Object.freeze(['corners', 'alpha']);

const DECODER_REMEDIATION = Object.freeze([
  'npm install --include=optional sharp',
  'If this tree was installed with --omit=optional, reinstall: npm ci --include=optional',
]);

/**
 * What to do about a provider that is not available. Keyed by id because the
 * fix is vendor knowledge, and vendor knowledge lives with the vendor rather
 * than in a generic string that tells the user nothing actionable.
 */
const PROVIDER_REMEDIATION = Object.freeze({
  codex: Object.freeze([
    'Install the Codex CLI: npm install -g @openai/codex',
    'Sign in once (interactive, not run by doctor): codex login',
    'Confirm the shim is on PATH: codex --version',
  ]),
  svg: Object.freeze([
    'The svg provider needs nothing installed, so a failure here means the module '
      + 'did not load; reinstall the tree: npm ci',
  ]),
});

function unknownProviderRemediation(id) {
  return [
    `Install the executable that adapter "${id}" names and make sure it is on PATH, `
      + 'then re-run: pixelproof doctor',
  ];
}

/**
 * Authentication policy per built-in.
 *
 * Codex is deliberately `unknown`: the CLI being on PATH says nothing about the
 * subscription behind it, and the only ways to find out — `codex login status`
 * shelling out, or a trial generation — are a network call and a paid call
 * respectively. Neither is allowed here.
 *
 * SVG is `available` because "no credentials exist" is provable at zero cost;
 * that is the one case where a positive claim is honest.
 */
const AUTH_POLICY = Object.freeze({
  codex: Object.freeze({
    state: AUTH_UNKNOWN,
    detail: 'the CLI is present, but its login/subscription state cannot be checked '
      + 'without a network or paid call',
    advice: 'If generation fails with an authentication error, run: codex login',
  }),
  svg: Object.freeze({
    state: AUTH_AVAILABLE,
    detail: 'no credentials are required',
  }),
});

const BUILTIN_LOADERS = Object.freeze([
  { id: 'codex', load: () => import('../../../providers/codex.mjs') },
  { id: 'svg', load: () => import('../../../providers/svg.mjs') },
]);

const TIMED_OUT = Symbol('pixelproof.doctor.timeout');

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error';
  return error.message ?? error.code ?? String(error);
}

/**
 * Race a promise against a timer. The losing promise is abandoned rather than
 * cancelled — nothing here can be cancelled — and the `clearTimeout` below is
 * what stops an abandoned probe from keeping `doctor` alive.
 *
 * The timer is deliberately **not** `unref`'d. When a probe never settles this
 * timer is the only thing that will ever resolve the race, and an unref'd timer
 * does not hold the event loop open: Node drains and exits before it fires, so
 * `doctor` prints nothing at all against exactly the hung probe it exists to
 * survive. `clearTimeout` already guarantees the timer cannot delay exit once
 * the race settles, so `unref` bought nothing and cost the timeout itself.
 *
 * Node 24 hides this; Node 22 reports "Promise resolution is still pending but
 * the event loop has already resolved".
 */
function withTimeout(value, timeoutMs) {
  let timer = null;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  return Promise.race([Promise.resolve(value), expiry]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/** Run a probe under the budget, turning both timeout and throw into data. */
async function boundedProbe(run, timeoutMs, label) {
  try {
    const result = await withTimeout(run(), timeoutMs);
    if (result === TIMED_OUT) {
      return { ok: false, value: null, error: `${label} timed out after ${timeoutMs}ms` };
    }
    return { ok: true, value: result, error: null };
  } catch (error) {
    return { ok: false, value: null, error: messageOf(error) };
  }
}

const DOCTOR_FLAGS = new Map([
  ['--json', 'json'],
  ['-h', 'help'],
  ['--help', 'help'],
]);

const DOCTOR_VALUED = new Set(['--timeout', '--run-dir']);

/**
 * Parse doctor arguments. Throws on an unknown argument or a bad value.
 *
 * `camelCase` is on for `--run-dir`. Every other doctor flag is a single word,
 * so nothing existing is renamed — and `doctor` accepting a run root under a
 * different key from `generate`, `verify` and `judge` would be the two-dialects
 * problem ADR 0003 forbids, in miniature.
 */
export function parseDoctorArguments(argv) {
  const options = parseArguments(argv, {
    flags: DOCTOR_FLAGS,
    valued: DOCTOR_VALUED,
    defaults: { json: false, help: false },
    camelCase: true,
  });

  if (options.timeout !== undefined) {
    const parsed = Number(options.timeout);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error('--timeout must be a positive integer number of milliseconds');
    }
    options.timeout = parsed;
  }

  return options;
}

/**
 * Render a capability record as a sentence. Absent bounds are omitted rather
 * than printed as "none": a provider with no declared pixel ceiling has not
 * declared an infinite one, it has declared nothing, and inventing a value here
 * would be the same lie the rest of this command exists to avoid.
 */
export function describeCapabilities(capabilities) {
  if (typeof capabilities === 'string') return capabilities;
  if (capabilities === null || typeof capabilities !== 'object') return 'not declared';

  const parts = [];
  const bound = (min, max, label, unit) => {
    if (min && max) parts.push(`${label} ${min}-${max}${unit}`);
    else if (max) parts.push(`${label} up to ${max}${unit}`);
    else if (min) parts.push(`${label} from ${min}${unit}`);
  };

  bound(capabilities.minWidth, capabilities.maxWidth, 'width', 'px');
  bound(capabilities.minHeight, capabilities.maxHeight, 'height', 'px');
  if (capabilities.dimensionMultiple) {
    parts.push(`edges a multiple of ${capabilities.dimensionMultiple}`);
  }
  bound(capabilities.minPixels, capabilities.maxPixels, 'total pixels', '');
  if (capabilities.maxAspectRatio) {
    parts.push(`aspect ratio at most ${capabilities.maxAspectRatio}:1`);
  }
  if (parts.length === 0) parts.push('no declared size limits');

  for (const [key, label] of [
    ['transparency', 'transparency'],
    ['seed', 'seed'],
    ['references', 'references'],
    ['negativePrompt', 'negative prompt'],
  ]) {
    parts.push(`${label}: ${capabilities[key] === true ? 'yes' : 'no'}`);
  }

  return parts.join('; ');
}

/**
 * The default provider probe.
 *
 * Built-ins are imported dynamically and each import is bounded, so a provider
 * module that throws or wedges on load becomes one unavailable row instead of
 * taking the whole report down — the same reason `probeRegistry` catches a
 * throwing `detect`. Each `detect` is wrapped in the budget *before*
 * registration, which is how a per-provider bound is obtained without touching
 * `core/`.
 */
export async function defaultProviderProbe(timeoutMs) {
  // Imported lazily so this module stays loadable (and `--help` stays instant)
  // even if a provider module is broken.
  const { discoverProviders, probeRegistry } = await import('../../../core/adapters/discover.mjs');

  const registrations = [];
  const failures = [];

  for (const { id, load } of BUILTIN_LOADERS) {
    const loaded = await boundedProbe(load, timeoutMs, `loading provider "${id}"`);
    if (!loaded.ok) {
      failures.push({ id, trust: 'builtin', kinds: [], available: false, reason: loaded.error });
      continue;
    }

    const module = loaded.value;
    if (!module?.manifest || typeof module.generate !== 'function') {
      failures.push({
        id,
        trust: 'builtin',
        kinds: [],
        available: false,
        reason: 'the module does not export a manifest and a generate function',
      });
      continue;
    }

    registrations.push({
      id,
      manifest: module.manifest,
      generate: module.generate,
      detect: async () => {
        const detected = await boundedProbe(
          async () => (typeof module.detect === 'function' ? module.detect() : true),
          timeoutMs,
          `detecting provider "${id}"`,
        );
        return detected.ok ? detected.value : { available: false, reason: detected.error };
      },
    });
  }

  const registry = discoverProviders({ builtins: registrations });
  const probed = await probeRegistry(registry);
  const manifests = new Map(registrations.map((entry) => [entry.id, entry.manifest]));

  return [
    ...probed.map((row) => ({ ...row, manifest: manifests.get(row.id) ?? null })),
    ...failures,
  ];
}

/** The default authentication probe: policy lookup, never an outward call. */
export function defaultAuthProbe(row) {
  if (row.available !== true) {
    return {
      state: AUTH_UNKNOWN,
      detail: 'not checked while the provider itself is unavailable',
    };
  }
  return AUTH_POLICY[row.id] ?? {
    state: AUTH_UNKNOWN,
    detail: 'this adapter declares no authentication model that can be checked safely',
  };
}

function normaliseAuth(answer) {
  if (answer === null || typeof answer !== 'object' || !Object.hasOwn(AUTH_LABEL, answer.state)) {
    return {
      state: AUTH_UNKNOWN,
      detail: 'the authentication probe did not report a recognised state',
      advice: null,
    };
  }
  return {
    state: answer.state,
    detail: typeof answer.detail === 'string' ? answer.detail : null,
    advice: typeof answer.advice === 'string' ? answer.advice : null,
  };
}

function remediationFor(row) {
  if (row.available) return [];
  return PROVIDER_REMEDIATION[row.id] ? [...PROVIDER_REMEDIATION[row.id]] : unknownProviderRemediation(row.id);
}

async function collectProviders({ probe, authProbe, timeoutMs }) {
  const answer = await boundedProbe(probe, timeoutMs, 'provider detection');
  if (!answer.ok) return { rows: [], error: answer.error };
  if (!Array.isArray(answer.value)) {
    return { rows: [], error: 'the provider probe did not return a list of providers' };
  }

  const rows = [];
  for (const raw of answer.value) {
    const row = {
      id: String(raw?.id ?? 'unknown'),
      trust: raw?.trust ?? 'builtin',
      kinds: Array.isArray(raw?.kinds) ? [...raw.kinds] : [],
      available: raw?.available === true,
      reason: typeof raw?.reason === 'string' ? raw.reason : null,
    };

    const auth = await boundedProbe(
      () => authProbe(row),
      timeoutMs,
      `authentication probe for "${row.id}"`,
    );

    rows.push({
      ...row,
      capabilities: describeCapabilities(raw?.manifest?.capabilities ?? raw?.capabilities ?? null),
      auth: auth.ok
        ? normaliseAuth(auth.value)
        : { state: AUTH_UNKNOWN, detail: auth.error, advice: null },
      remediation: remediationFor(row),
    });
  }

  return { rows, error: null };
}

async function collectDecoder({ probe, timeoutMs }) {
  const answer = await boundedProbe(probe, timeoutMs, 'the sharp decoder probe');
  const available = answer.ok && Boolean(answer.value?.sharp);
  const reason = available
    ? null
    : answer.error ?? (answer.value?.error
      ? messageOf(answer.value.error)
      : 'not installed');

  return {
    name: 'sharp',
    available,
    reason,
    checksAvailable: [...CHECKS_WITHOUT_DECODER, ...(available ? CHECKS_REQUIRING_DECODER : [])],
    checksSkipped: available ? [] : [...CHECKS_REQUIRING_DECODER],
    remediation: available ? [] : [...DECODER_REMEDIATION],
  };
}

/**
 * Count what is still waiting on a host (ADR 0009 §4).
 *
 * This is the one line that makes an abandoned handoff visible to someone who
 * never knew one happened — a run left pending by a crashed agent is invisible
 * everywhere else, and an invisible outstanding judgement reads as "nothing to
 * do". Scanning `run.json` files is read-only, spends nothing, and is bounded by
 * the same probe budget as everything else here.
 *
 * A probe that fails reports zero *and says so*. Silently reporting zero would
 * be the confident-wrong answer this command exists not to give.
 */
async function collectPending({ probe, stalledProbe, timeoutMs }) {
  const answer = await boundedProbe(probe, timeoutMs, 'the pending-judgement scan');
  if (!answer.ok) {
    return { total: 0, expired: 0, unreadable: 0, stalled: 0, error: answer.error };
  }

  // ADR 0020's orphan: a run left `running` because an operator never retook and
  // never abandoned. Nothing is pending on it, so the scan above cannot see it,
  // and ADR 0009 §4's "an abandoned handoff is visible to someone who never knew
  // one happened" would quietly stop being true for the retake path.
  //
  // A failed orphan scan reports zero *and* fails the whole line, for the same
  // reason the pending scan does: "none outstanding" and "I could not look" are
  // different facts, and only one of them means there is nothing to do.
  const stalledAnswer = await boundedProbe(stalledProbe, timeoutMs, 'the open-run scan');
  if (!stalledAnswer.ok) {
    return { total: 0, expired: 0, unreadable: 0, stalled: 0, error: stalledAnswer.error };
  }

  const now = new Date();
  const entries = Array.isArray(answer.value) ? answer.value : [];
  return {
    total: entries.length,
    expired: entries.filter((entry) => entry.record !== null && hasExpired(entry.record.expiresAt, now)).length,
    unreadable: entries.filter((entry) => entry.error !== null).length,
    stalled: Array.isArray(stalledAnswer.value) ? stalledAnswer.value.length : 0,
    error: null,
  };
}

/**
 * Assemble the whole report as data. Rendering is a separate step so `--json`
 * and the human report cannot disagree about what was found.
 */
export async function collectReport({
  probes = undefined,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  runDir = null,
} = {}) {
  const providerProbe = probes?.providers ?? (() => defaultProviderProbe(timeoutMs));
  const decoderProbe = probes?.decoder ?? loadSharpDecoder;
  const authProbe = probes?.auth ?? defaultAuthProbe;
  const pendingProbe = probes?.pending ?? (() => listPendingRuns({ runDir }));
  const stalledProbe = probes?.stalled ?? (() => listStalledRuns({ runDir }));

  const providers = await collectProviders({ probe: providerProbe, authProbe, timeoutMs });
  const decoder = await collectDecoder({ probe: decoderProbe, timeoutMs });
  const pending = await collectPending({ probe: pendingProbe, stalledProbe, timeoutMs });

  const availableIds = providers.rows.filter((row) => row.available).map((row) => row.id);
  const ok = availableIds.length > 0;

  return {
    ok,
    node: process.version,
    platform: process.platform,
    timeoutMs,
    providers: providers.rows,
    providerProbeError: providers.error,
    decoder,
    pending,
    summary: {
      providersAvailable: availableIds.length,
      providersTotal: providers.rows.length,
      availableIds,
      degraded: !decoder.available,
      verdict: ok
        ? (decoder.available ? 'usable' : 'usable (degraded)')
        : 'unusable',
    },
  };
}

const LABEL_WIDTH = 14;

function field(label, value) {
  return `    ${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

function continuation(value) {
  return `    ${' '.repeat(LABEL_WIDTH)}${value}`;
}

/**
 * `2 pending host judgements (1 expired)` — ADR 0009 §4's one line.
 *
 * A failed scan says it failed rather than reporting none. "None outstanding"
 * and "I could not look" are different facts, and only one of them means there
 * is nothing to do.
 */
export function describePending(pending) {
  if (!pending) return 'not scanned';
  if (pending.error) return `could not scan (${pending.error})`;

  // ADR 0020's orphan is reported on the same line as the pending count, and
  // reported even when nothing is pending — that is the whole case it exists
  // for. A run between attempts has no outstanding judgement, so a line that
  // only counted judgements would say "none pending" about a run nobody
  // finished.
  const stalled = (pending.stalled ?? 0) > 0
    ? `${pending.stalled} run${pending.stalled === 1 ? '' : 's'} open between attempts`
      + ' - pixelproof retake --run <id>, or judge abandon'
    : '';

  if (pending.total === 0) return stalled === '' ? 'none pending' : `none pending; ${stalled}`;

  const noun = pending.total === 1 ? 'judgement' : 'judgements';
  const unreadable = pending.unreadable > 0 ? `, ${pending.unreadable} unreadable` : '';
  const line = `${pending.total} pending host ${noun} (${pending.expired} expired${unreadable})`
    + ' - pixelproof judge pending';
  return stalled === '' ? line : `${line}; ${stalled}`;
}

/**
 * The human report, entirely on stdout.
 *
 * Unlike verification — where warnings go to stderr so a piped table stays
 * clean — the whole of `doctor` *is* the report, and splitting it across two
 * streams would only guarantee that whoever pipes it loses the half that
 * explains the other half.
 */
export function renderReport(report) {
  const lines = [
    'Pixelproof doctor',
    `Node ${report.node} on ${report.platform}; probe budget ${report.timeoutMs}ms`,
    '',
    `Providers (${report.summary.providersAvailable} of ${report.summary.providersTotal} available)`,
  ];

  if (report.providerProbeError) {
    lines.push(field('error', report.providerProbeError));
  }

  if (report.providers.length === 0) {
    lines.push('    No providers are registered, so nothing can be generated.');
    for (const step of PROVIDER_REMEDIATION.codex) {
      lines.push(field('fix', step));
    }
  }

  for (const provider of report.providers) {
    lines.push('');
    lines.push(`  ${provider.id} [${provider.available ? 'available' : 'unavailable'}]`);
    if (!provider.available && provider.reason) {
      lines.push(field('reason', provider.reason));
    }
    const authDetail = provider.auth.detail ? ` - ${provider.auth.detail}` : '';
    lines.push(field('auth', `${AUTH_LABEL[provider.auth.state]}${authDetail}`));
    lines.push(field('kinds', provider.kinds.length > 0 ? provider.kinds.join(', ') : 'none declared'));
    lines.push(field('capabilities', provider.capabilities));
    if (provider.auth.advice) {
      lines.push(field('note', provider.auth.advice));
    }
    provider.remediation.forEach((step, index) => {
      lines.push(index === 0 ? field('fix', step) : continuation(step));
    });
  }

  lines.push('');
  lines.push('Decoder');
  lines.push(field(
    'sharp',
    report.decoder.available ? 'installed' : `not installed (${report.decoder.reason})`,
  ));
  lines.push(field('checks run', report.decoder.checksAvailable.join(', ')));
  lines.push(field(
    'checks SKIP',
    report.decoder.checksSkipped.length > 0
      ? `${report.decoder.checksSkipped.join(', ')} (alpha still runs when a spec asks for "any")`
      : 'none',
  ));
  report.decoder.remediation.forEach((step, index) => {
    lines.push(index === 0 ? field('fix', step) : continuation(step));
  });

  lines.push('');
  lines.push('Summary');
  lines.push(field(
    'providers',
    report.summary.providersAvailable > 0
      ? `${report.summary.providersAvailable} available (${report.summary.availableIds.join(', ')})`
      : 'none available; pixelproof generate cannot run',
  ));
  lines.push(field(
    'mechanical',
    report.decoder.available
      ? 'full - every mechanical check can run'
      : `degraded - ${CHECKS_REQUIRING_DECODER.join(' and ')} will report SKIP, not PASS`,
  ));
  lines.push(field('judgements', describePending(report.pending)));
  lines.push(field('verdict', report.summary.verdict));

  return `${lines.join('\n')}\n`;
}

/**
 * `pixelproof doctor`. Prints its own report and answers with an exit code:
 * 0 when at least one provider is available (degraded or not), 1 when nothing
 * in this environment can run.
 */
export async function doctorCommand({ argv = [], probes = undefined } = {}) {
  const output = probes?.output ?? globalThis.console;

  let options;
  try {
    options = parseDoctorArguments(argv);
  } catch (error) {
    printUsageError(error.message, DOCTOR_USAGE, output);
    return 1;
  }

  if (options.help) {
    printUsage(DOCTOR_USAGE, output);
    return 0;
  }

  const timeoutMs = options.timeout ?? probes?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const report = await collectReport({ probes, timeoutMs, runDir: options.runDir ?? null });

  if (options.json) {
    output.log(JSON.stringify(report, null, 2));
  } else {
    output.log(renderReport(report).trimEnd());
  }

  return report.ok ? 0 : 1;
}
