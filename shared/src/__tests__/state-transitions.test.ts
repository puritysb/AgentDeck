/**
 * Guards the state-machine transition table SSOT (shared/src/states.ts).
 *
 * The table is a rule set two daemons run against real sessions — the Node hub
 * and the in-process Swift daemon. A row present in one and missing in the
 * other is not cosmetic: it is a session that wedges in AWAITING_* forever on
 * one platform and recovers on the other, with nothing in either log saying
 * why. So the Swift copy is generated, and this test is what makes "generated"
 * mean something — it fails when the file on disk is not what the current
 * source emits, whether that came from a hand edit or a skipped regenerate.
 *
 * The invariants below are the ones a future edit could break without any
 * single row looking wrong.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { State, transitions, type StateTransition } from '../states.js';
import { OUTPUTS, renderOutput, tableFrom, swiftCaseName } from '../../../scripts/generate-state-transitions.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const table = tableFrom({ State, transitions });

describe('generated mirrors in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(renderOutput(rel, emit, table));
    });
  }

  it('every daemon-only generated file carries the macOS guard', () => {
    // A Daemon/ file without it compiles fine on macOS and breaks only the
    // iOS archive — i.e. it passes every local check and fails at release.
    for (const [rel, emit] of OUTPUTS) {
      if (!rel.includes('/Daemon/')) continue;
      const out = renderOutput(rel, emit, table);
      expect(out.startsWith('#if os(macOS)\n')).toBe(true);
      expect(out.endsWith('#endif\n')).toBe(true);
    }
  });

  it('emits a Swift case name for every state, with a rawValue only where they differ', () => {
    const swift = renderOutput(OUTPUTS[0][0], OUTPUTS[0][1], table);
    for (const value of Object.values(State)) {
      const name = swiftCaseName(value);
      expect(swift).toContain(name === value ? `case ${name}\n` : `case ${name} = "${value}"`);
    }
  });

  it('carries each transition note into the mirror', () => {
    // The rationale is the expensive half of this table, and the half a
    // mirror silently drops. Notes ride the SSOT so they cannot be restated
    // (and then contradicted) on the Swift side.
    const swift = renderOutput(OUTPUTS[0][0], OUTPUTS[0][1], table);
    const noted = transitions.filter((t) => t.note);
    expect(noted.length).toBeGreaterThan(0);
    for (const t of noted) {
      for (const line of t.note!.split('\n')) expect(swift).toContain(`// ${line}`);
    }
  });
});

describe('transition table invariants', () => {
  const key = (t: StateTransition) => `${t.from}|${t.trigger}|${t.source}`;

  it('is deterministic — no two rows match the same (from, trigger, source)', () => {
    // Both daemons resolve with a first-match lookup, so a duplicate key means
    // the winner is decided by array order rather than by any stated rule.
    const seen = new Map<string, StateTransition>();
    for (const t of transitions) {
      expect(seen.has(key(t)), `duplicate: ${key(t)}`).toBe(false);
      seen.set(key(t), t);
    }
  });

  it('leaves AWAITING_* without a wall-clock backstop', () => {
    // An unanswered prompt is a genuine, indefinitely-valid wait. A blind
    // timer here once forced real prompts to IDLE and vanished them from
    // every dashboard; a truly dead session is reaped by liveness instead.
    const awaiting = [State.AWAITING_PERMISSION, State.AWAITING_OPTION, State.AWAITING_DIFF];
    const timedOut = transitions.filter((t) => t.trigger === 'stuck_timeout');
    expect(timedOut.map((t) => t.from)).toEqual([State.PROCESSING]);
    for (const s of awaiting) {
      expect(timedOut.some((t) => t.from === s || t.from === '*')).toBe(false);
    }
  });

  it('gives every AWAITING_* state a hook-driven exit', () => {
    // A prompt answered at the keyboard produces no device action and, for
    // Claude/Codex, no parser signal — the lifecycle hooks are the only
    // dismissal evidence, so a missing one wedges that state forever.
    for (const s of [State.AWAITING_PERMISSION, State.AWAITING_OPTION, State.AWAITING_DIFF]) {
      for (const trigger of ['tool_activity', 'stop', 'user_prompt_submit']) {
        expect(
          transitions.some((t) => t.from === s && t.trigger === trigger && t.source === 'hook'),
          `${s} has no hook exit on ${trigger}`,
        ).toBe(true);
      }
    }
  });

  it('every row targets a real state and a known source', () => {
    const states = new Set<string>(Object.values(State));
    const sources = new Set(['hook', 'pty', 'user', 'internal']);
    for (const t of transitions) {
      expect(states.has(t.to)).toBe(true);
      expect(t.from === '*' || states.has(t.from)).toBe(true);
      expect(sources.has(t.source)).toBe(true);
    }
  });
});
