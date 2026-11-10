import { describe, expect, it, vi } from 'vitest';
import { HermesSessions, HERMES_ATTENTION_LEASE_MS, HERMES_SILENCE_TTL_MS } from '../hermes-sessions.js';

const session_id = `hermes-${'a'.repeat(32)}`;
const id = (n: number) => `hermes-input-${n.toString(16).padStart(32, '0')}`;
function open() {
  const sessions = new HermesSessions();
  sessions.note('hermes_user_prompt_submit', { session_id, pid: 42 }, 0);
  return sessions;
}
const input = (n = 1, kind = 'clarify') => ({ session_id, attention_id: id(n), kind });
const request = 'hermes_human_input_request', resolved = 'hermes_human_input_resolved';
const row = (s: HermesSessions, now = 10) => s.applyTo([], now)[0];

describe('Hermes human-input status (Node only)', () => {
  it('restores a live snapshot as display only and expires it without closing a run', () => {
    const s = new HermesSessions();
    const expired = vi.fn(), changed = vi.fn();
    s.onExpired = expired;
    s.onChanged = changed;
    const snapshot = { session_id, inputs: [input(1, 'approval')] };
    expect(s.note('hermes_human_input_snapshot', snapshot, 1)).toBe(true);
    expect(row(s)).toMatchObject({ state: 'awaiting_permission', liveAnswerable: false });
    expect(s.note('hermes_human_input_snapshot', snapshot, 5000)).toBe(true);
    expect(row(s, HERMES_ATTENTION_LEASE_MS + 3)?.state).toBe('awaiting_permission');
    changed.mockClear();
    expect(s.sweepDeparted(undefined, 5000 + HERMES_ATTENTION_LEASE_MS)).toEqual([]);
    expect(row(s, 5000 + HERMES_ATTENTION_LEASE_MS)).toBeUndefined();
    expect(changed).toHaveBeenCalledOnce();
    expect(expired).not.toHaveBeenCalled();
  });

  it('keeps an existing run open while snapshots refresh past the silence TTL', () => {
    const s = open();
    const expired = vi.fn();
    s.onExpired = expired;
    const event = 'hermes_human_input_snapshot';
    const snapshot = { session_id, inputs: [input()] };
    const startedAt = row(s).startedAt;
    const afterTtl = HERMES_SILENCE_TTL_MS + 3_000;
    for (let now = 3_000; now <= afterTtl; now += 3_000) {
      s.note(event, snapshot, now);
      s.applyTo([], now);
    }
    expect(row(s, afterTtl)).toMatchObject({ state: 'awaiting_option', startedAt });
    s.note(event, { session_id, inputs: [] }, afterTtl + 1);
    expect(row(s, afterTtl + 1)).toMatchObject({ state: 'processing', startedAt });
    expect(expired).not.toHaveBeenCalled();
    expect(row(s, afterTtl + HERMES_SILENCE_TTL_MS)).toBeUndefined();
    expect(expired).toHaveBeenCalledExactlyOnceWith(session_id);
  });

  it('applies empty snapshots without creating an execution row', () => {
    const s = new HermesSessions();
    const event = 'hermes_human_input_snapshot';
    expect(s.note(event, { session_id, inputs: [] }, 1)).toBe(true);
    expect(row(s)).toBeUndefined();
    s.note(event, { session_id, inputs: [input()] }, 2);
    expect(row(s).state).toBe('awaiting_option');
    expect(s.note(event, { session_id, inputs: [input(), input()] }, 3)).toBe(false);
    s.note(event, { session_id, inputs: [] }, 4);
    expect(row(s)).toBeUndefined();
  });
  it.each([['clarify', 'awaiting_option'], ['approval', 'awaiting_permission'], ['sudo', 'awaiting_permission']])(
    'reports %s without offering control or exporting prompt content', (kind, state) => {
      const s = open();
      expect(s.note(request, { ...input(1, kind), prompt: 'PRIVATE', options: ['allow'], requestId: 'native' }, 1)).toBe(true);
      expect(row(s)).toMatchObject({ state, liveAnswerable: false, controlMode: 'observed' });
      for (const field of ['requestId', 'options', 'question', 'tty', 'appName']) expect(row(s)).not.toHaveProperty(field);
      expect(JSON.stringify(row(s))).not.toContain('PRIVATE');
      s.note(resolved, input(1, kind), 2);
      expect(row(s).state).toBe('processing');
    });

  it('keeps overlapping waits through unrelated tools and resolves only matching requests', () => {
    const s = open();
    s.note(request, input(), 1);
    s.note(request, input(2, 'approval'), 2);
    s.note('hermes_tool_start', { session_id, tool_name: 'terminal' }, 3);
    s.note('hermes_tool_end', { session_id }, 4);
    expect(row(s).state).toBe('awaiting_permission');
    s.note(resolved, input(99), 5);
    expect(row(s).state).toBe('awaiting_permission');
    expect(s.note(resolved, input(2, 'clarify'), 6)).toBe(false);
    s.note(resolved, input(2, 'approval'), 7);
    expect(row(s).state).toBe('awaiting_option');
    s.note(resolved, input(), 8);
    expect(row(s).state).toBe('processing');
  });

  it('fences resolved-before-request and duplicate events, including the next turn', () => {
    const s = open();
    s.note(resolved, input(), 1);
    s.note(request, input(), 2);
    expect(row(s).state).toBe('processing');
    s.note(request, input(2), 3);
    s.note(request, input(2), 4);
    s.note(resolved, input(2), 5);
    s.note('hermes_user_prompt_submit', { session_id }, 6);
    s.note(request, input(2), 7);
    expect(row(s).state).toBe('processing');
  });

  it.each(['hermes_stop', 'hermes_user_prompt_submit', 'hermes_session_end'])('clears waits at %s', boundary => {
    const s = open(); s.note(request, input(), 1);
    s.note(boundary, { session_id }, 2);
    expect(row(s)?.state ?? 'removed').toBe(boundary === 'hermes_stop' ? 'idle' : boundary === 'hermes_session_end' ? 'removed' : 'processing');
    s.note(request, input(), 3);
    expect(row(s)?.state ?? 'removed').not.toMatch(/^awaiting/);
  });

  it('never creates or resurrects an execution row from attention', () => {
    const s = new HermesSessions();
    expect(s.note(request, input(), 0)).toBe(false);
    s.note('hermes_user_prompt_submit', { session_id, pid: 42 }, 1);
    s.note(request, input(), 2);
    s.sweepDeparted(() => 'dead', 3);
    expect(s.note(request, input(2), 4)).toBe(false);
    expect(s.applyTo([], 4)).toEqual([]);
  });

  it('retires a lost resolution as stale, never as task success', () => {
    const s = open(); s.note(request, input(), 1);
    const expired: string[] = []; s.onExpired = sid => expired.push(sid);
    expect(s.applyTo([], HERMES_SILENCE_TTL_MS + 2)).toEqual([]);
    expect(expired).toEqual([session_id]);
    expect(s.note(resolved, input(), HERMES_SILENCE_TTL_MS + 3)).toBe(false);
  });

  it('does not extend a human wait merely because an otherwise idle CLI is alive', () => {
    const s = new HermesSessions();
    s.note('hermes_session_start', { session_id, pid: 42, platform: 'cli' }, 0);
    s.note(request, input(), 1);
    for (let now = 60_000; now < HERMES_SILENCE_TTL_MS; now += 60_000) s.sweepDeparted(() => 'alive', now);
    expect(s.applyTo([], HERMES_SILENCE_TTL_MS + 2)).toEqual([]);
  });

  it('bounds pending requests without evicting unresolved waits', () => {
    const s = open();
    for (let n = 1; n <= 32; n++) expect(s.note(request, input(n), n)).toBe(true);
    expect(s.note(request, input(33), 33)).toBe(false);
    for (let n = 1; n < 32; n++) s.note(resolved, input(n), n + 40);
    expect(row(s, 80).state).toBe('awaiting_option');
    s.note(resolved, input(32), 81);
    expect(row(s, 82).state).toBe('processing');
  });

  it.each([{ kind: 'smart' }, { attention_id: 'native' }, { session_id: 'bad' }, { kind: null }])('rejects malformed attention %j', patch => {
    const s = open(); expect(s.note(request, { ...input(), ...patch }, 1)).toBe(false);
    expect(row(s).state).toBe('processing');
  });
});
