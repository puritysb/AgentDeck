import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexHookReplayGuard } from '../codex-hook-replay.js';

interface Vector { name: string; event: string; payload: Record<string, unknown>; route: string; routedEvent?: string }
const VECTORS = (JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../shared/hook-harness-vectors.json', import.meta.url)), 'utf8',
)) as { vectors: Vector[] }).vectors;

function vector(namePrefix: string): Vector {
  const v = VECTORS.find((x) => x.name.startsWith(namePrefix));
  if (!v) throw new Error(`missing vector ${namePrefix}`);
  return v;
}
const clone = (p: Record<string, unknown>) => JSON.parse(JSON.stringify(p)) as Record<string, unknown>;

describe('CodexHookReplayGuard (#490)', () => {
  it('replays every shared vector to its route', () => {
    for (const v of VECTORS) {
      const verdict = new CodexHookReplayGuard().admit(v.event, clone(v.payload), 0);
      if (v.route === 'drop') expect(verdict, v.name).toEqual({ kind: 'drop', reason: 'codex-unrouted' });
      else if (v.route === 'codex') expect(verdict, v.name).toEqual({ kind: 'ingest', eventName: v.routedEvent, rerouted: true });
      else expect(verdict, v.name).toEqual({ kind: 'ingest', eventName: v.event, rerouted: false });
    }
  });

  it('ingests one Codex Stop once when both its codex_stop hook and a generic Stop hook deliver it, in either order', () => {
    const stop = vector('Codex Stop (captured)').payload;
    const a = new CodexHookReplayGuard();
    expect(a.admit('codex_stop', clone(stop), 1_000)).toEqual({ kind: 'ingest', eventName: 'codex_stop', rerouted: false });
    expect(a.admit('Stop', clone(stop), 1_200)).toEqual({ kind: 'drop', reason: 'codex-replay' });
    const b = new CodexHookReplayGuard();
    expect(b.admit('Stop', clone(stop), 1_000)).toEqual({ kind: 'ingest', eventName: 'codex_stop', rerouted: true });
    expect(b.admit('codex_stop', clone(stop), 1_300)).toEqual({ kind: 'drop', reason: 'codex-replay' });
  });

  it('keeps two different turns of one thread, and two threads closing with identical text', () => {
    const stop = vector('Codex Stop (captured)').payload;
    const g = new CodexHookReplayGuard();
    expect(g.admit('codex_stop', clone(stop), 0).kind).toBe('ingest');
    expect(g.admit('codex_stop', { ...clone(stop), turn_id: 'turn-2' }, 100).kind).toBe('ingest');
    expect(g.admit('codex_stop', { ...clone(stop), session_id: '01a12890-0000-7000-8000-000000000002' }, 200).kind).toBe('ingest');
  });

  it('does not deduplicate when the payload lacks its discriminator, and forgets after the window', () => {
    const { turn_id: _drop, ...noTurn } = clone(vector('Codex Stop (captured)').payload);
    const g = new CodexHookReplayGuard();
    expect(g.admit('codex_stop', { ...noTurn }, 0).kind).toBe('ingest');
    expect(g.admit('codex_stop', { ...noTurn }, 10).kind).toBe('ingest');
    const stop = vector('Codex Stop (captured)').payload;
    expect(g.admit('codex_stop', clone(stop), 0).kind).toBe('ingest');
    expect(g.admit('codex_stop', clone(stop), 10_001).kind).toBe('ingest');
  });

  it('gives a notify payload its thread as session_id so it lands on the Codex session', () => {
    const notify = clone(vector('Codex notify agent-turn-complete').payload);
    const verdict = new CodexHookReplayGuard().admit('codex_turn_complete', notify, 0);
    expect(verdict.kind).toBe('ingest');
    expect(notify.session_id).toBe(notify['thread-id']);
  });

  it('never re-routes a Claude payload, whatever model it names', () => {
    const glm = vector('claude-glm').payload;
    const gpt = vector('a Claude payload naming an OpenAI model').payload;
    expect(new CodexHookReplayGuard().admit('SessionStart', clone(glm), 0)).toEqual({ kind: 'ingest', eventName: 'SessionStart', rerouted: false });
    expect(new CodexHookReplayGuard().admit('SessionStart', clone(gpt), 0)).toEqual({ kind: 'ingest', eventName: 'SessionStart', rerouted: false });
  });
});
