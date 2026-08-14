/**
 * What `--judge <value>` resolves to (ADR 0021 §3, §5, §6, §10).
 *
 * A panel is the list of authorities that will judge one attempt. Two kinds of
 * member exist and they are not the same shape at all:
 *
 * - **`host`** is a *run state* (ADR 0009 §1). Nothing is spawned; a checklist
 *   is written and the process exits 2, and the answer arrives in a later
 *   invocation.
 * - **a subprocess judge** is a *call*. It is spawned, waited on, and answered
 *   in the same process, so the run never pauses and exit 2 never appears.
 *
 * The panel is what tells the rest of the run which of those it is in, and it is
 * also where ADR 0021 §6's rule lives: escalation means escalating *to the
 * host*, so a panel with no host has no escalation authority and an `unsure`
 * that would escalate is a rejection instead.
 */

import { selectJudge } from './registry.mjs';
import { HOST_JUDGE } from './pending.mjs';

/** A run judged only by the calling agent (ADR 0009). */
export const KIND_HOST = 'host';

/** A run judged only by spawned judges (ADR 0021 §3). */
export const KIND_SUBPROCESS = 'subprocess';

/** Both, in one panel (ADR 0009 §5). Specified, not built (ADR 0021 §10). */
export const KIND_MIXED = 'mixed';

/**
 * The legal values of `run.json`'s `judge.kind`.
 *
 * ADR 0021 §5 widened this from `{"const": "host"}` and kept the envelope at
 * major 1. It is an **open enum** from here on: a fourth kind is additive, not a
 * major bump. `test/judge-registry.test.mjs` pins these three so a fourth cannot
 * arrive without someone deciding it should.
 */
export const JUDGE_KINDS = Object.freeze([KIND_HOST, KIND_SUBPROCESS, KIND_MIXED]);

/**
 * Split a `--judge` value into names.
 *
 * Comma-separated rather than a repeated flag: `parse.mjs` already treats
 * `--judge` as single-valued, and a repeated flag would need array support in
 * the parser for no gain.
 */
export function parsePanelNames(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--judge requires a judge name');
  }

  const names = value.split(',').map((name) => name.trim());
  if (names.some((name) => name === '')) {
    throw new Error(`--judge "${value}" has an empty entry; write names separated by commas, such as codex,host`);
  }

  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new Error(
      `--judge names "${duplicate}" twice. A judge cannot be its own second opinion: `
        + 'a panel is independent authorities, and one asked twice is one authority.',
    );
  }

  return names;
}

/**
 * Resolve names against the registry into the panel a run records.
 *
 * Refuses, before any provider or judge is invoked:
 *
 * - an unknown name, saying what *is* registered;
 * - a judge that does not declare the artifact kind being judged;
 * - more than one member, until ADR 0021 §10's mixed panel is built. It is
 *   refused by name rather than reduced to its first entry, because a run that
 *   quietly drops a judge would report an artifact as judged by authorities that
 *   never saw it.
 *
 * @param {{names: string[], registry: object, kind?: string}} options
 */
export function resolvePanel({ names, registry, kind = 'raster' }) {
  if (names.length > 1) {
    throw new Error(
      `--judge ${names.join(',')} asks for a mixed panel, which is specified (ADR 0009 §5) but not wired yet. `
        + 'Name exactly one judge.',
    );
  }

  const members = names.map((name) => {
    if (name === HOST_JUDGE) {
      return { id: HOST_JUDGE, role: 'judge', trust: 'host', kind: KIND_HOST, entry: null };
    }

    const entry = selectJudge(registry, { id: name, kind });
    return { id: entry.id, role: 'judge', trust: entry.trust, kind: KIND_SUBPROCESS, entry };
  });

  const hasHost = members.some((member) => member.kind === KIND_HOST);
  const subprocess = members.filter((member) => member.kind === KIND_SUBPROCESS);

  return {
    names,
    kind: hasHost && subprocess.length > 0 ? KIND_MIXED : hasHost ? KIND_HOST : KIND_SUBPROCESS,
    // What is recorded in `run.json`. The live `entry` is stripped: a run record
    // is evidence, and a function is not evidence of anything.
    members: members.map(({ entry: _entry, ...member }) => member),
    subprocess,
    hasHost,
  };
}

/**
 * Whether an `unsure` may still be escalated (ADR 0021 §6).
 *
 * ADR 0010's `onUnsure: "escalate"` means escalate *to the host*, and ADR 0009
 * §5 unified escalation with the handoff for exactly that reason. A panel with
 * no host has nobody to escalate to.
 *
 * Re-asking the same subprocess judge is **not** escalation: under ADR 0009 §5's
 * replacement rule its second answer would overwrite its first, which converts
 * "I cannot tell" into a coin flip that reports as a verdict.
 *
 * Reads the recorded panel, so a `judge submit` arriving in a later process
 * reaches the same answer as the process that issued the round.
 */
export function panelCanEscalate(judge) {
  const kind = judge?.kind ?? KIND_HOST;
  if (kind === KIND_HOST || kind === KIND_MIXED) return true;
  const members = Array.isArray(judge?.panel) ? judge.panel : [];
  return members.some((member) => member?.id === HOST_JUDGE);
}
