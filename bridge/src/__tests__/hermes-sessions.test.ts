import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { HermesSessions, HERMES_SILENCE_TTL_MS, hermesPidLiveness, type HermesPidLiveness } from '../hermes-sessions.js';
const session_id = `hermes-${'a'.repeat(32)}`;
const payload = { session_id, model: 'custom-model', project_name: 'Hermes (telegram)' };

describe('Hermes conversation lifetime', () => {
  it('replays captured real CLI tool work through Stop and finalization', () => {
    const capture = JSON.parse(readFileSync(new URL('./fixtures/hermes-cli-observer.json', import.meta.url), 'utf8'));
    const sessions = new HermesSessions();
    const states: string[] = [];
    let stops = 0;
    for (const event of capture.events) {
      expect(sessions.note(event.event, event.payload, event.afterMs)).toBe(true);
      const row = sessions.applyTo([], event.afterMs)[0];
      states.push(row?.state ?? 'removed');
      if (row) expect(row).toMatchObject({ agentType: 'hermes', modelName: 'glm-5.3', liveAnswerable: false });
      if (event.event === 'hermes_stop') {
        stops++;
        expect(event.payload).toMatchObject({ aborted: false, interrupted: false });
        expect(event.payload.last_assistant_message).toContain('323 OBSERVER_OK');
      }
    }
    expect(stops).toBe(1);
    expect(states).toEqual(['idle', 'processing', 'processing', 'processing', 'processing', 'processing', 'idle', 'removed']);
  });
  it('survives multiple turns and keeps tools separate from a final response', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_session_start', payload, 0);
    expect(sessions.applyTo([], 0)[0].state).toBe('idle');
    for (const now of [1, 10]) {
      sessions.note('hermes_user_prompt_submit', payload, now);
      sessions.note('hermes_tool_start', { ...payload, tool_name: 'memory' }, now + 1);
      expect(sessions.applyTo([], now + 1)[0]).toMatchObject({ state: 'processing', currentTask: 'memory', modelName: 'custom-model', liveAnswerable: false });
      sessions.note('hermes_tool_end', payload, now + 2);
      expect(sessions.applyTo([], now + 2)[0].state).toBe('processing');
      sessions.note('hermes_stop', payload, now + 3);
      expect(sessions.applyTo([], now + 3)[0]).toMatchObject({ state: 'idle', agentType: 'hermes', controlMode: 'observed' });
    }
    expect(sessions.applyTo([], 15)).toHaveLength(1);
  });
  it('finalizes and rejects trailing callbacks until explicit reopening', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_user_prompt_submit', payload, 0);
    sessions.note('hermes_session_end', payload, 1);
    expect(sessions.note('hermes_tool_start', payload, 2)).toBe(false);
    expect(sessions.applyTo([], 2)).toEqual([]);
    expect(sessions.note('hermes_user_prompt_submit', payload, 3)).toBe(true);
  });
  it('expires a missing stop without inventing successful completion', () => {
    const sessions = new HermesSessions();
    const retired: string[] = [];
    sessions.onExpired = sid => retired.push(sid);
    sessions.note('hermes_user_prompt_submit', payload, 0);
    expect(sessions.applyTo([], HERMES_SILENCE_TTL_MS)).toEqual([]);
    expect(retired).toEqual([session_id]);
    expect(sessions.note('hermes_stop', payload, HERMES_SILENCE_TTL_MS + 1)).toBe(false);
    sessions.applyTo([], HERMES_SILENCE_TTL_MS + 2);
    expect(retired).toEqual([session_id]);
  });
  it('recovers mid-tool after restart but rejects orphan stops and unknown events', () => {
    const sessions = new HermesSessions();
    expect(sessions.note('hermes_stop', payload)).toBe(false);
    expect(sessions.note('hermes_permission_asked', payload)).toBe(false);
    expect(sessions.note('hermes_tool_start', payload)).toBe(true);
  });
  it('isolates simultaneous profile/conversation identities and rejects malformed ids', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_user_prompt_submit', payload);
    sessions.note('hermes_session_start', { session_id: `hermes-${'b'.repeat(32)}` });
    expect(sessions.applyTo([]).map(s => s.state)).toEqual(['processing', 'idle']);
    expect(sessions.note('hermes_session_start', { session_id: 'unscoped' })).toBe(false);
  });
  it('bounds retained sessions even if a gateway opens many conversations', () => {
    const sessions = new HermesSessions();
    for (let i = 0; i < 150; i++) sessions.note('hermes_session_start', { session_id: `hermes-${i.toString(16).padStart(32, '0')}` }, i);
    expect(sessions.applyTo([], 150)).toHaveLength(128);
  });
});

describe('Hermes conversations end with their process', () => {
  // `hermes -z` hard-exits (os._exit) without on_session_finalize, measured
  // 2026-10-02 on Hermes main 0a374d167: the turn's Stop arrived, finalize
  // never did, and the row sat idle for the 30-minute silence TTL.
  const other = `hermes-${'b'.repeat(32)}`;
  const probeOf = (verdicts: Record<number, HermesPidLiveness>) => {
    const calls: number[] = [];
    return { calls, probe: (pid: number) => { calls.push(pid); return verdicts[pid] ?? 'unknown'; } };
  };

  it('closes a conversation whose process is gone, and a late callback cannot reopen it', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_user_prompt_submit', { ...payload, pid: 4242 }, 0);
    sessions.note('hermes_stop', { ...payload, pid: 4242 }, 5);
    const { probe } = probeOf({ 4242: 'dead' });
    expect(sessions.sweepDeparted(probe, 10)).toEqual([session_id]);
    expect(sessions.applyTo([], 10)).toHaveLength(0);
    expect(sessions.note('hermes_stop', { ...payload, pid: 4242 }, 11)).toBe(false);
    expect(sessions.applyTo([], 11)).toHaveLength(0);
  });

  it('keeps the conversation while the process runs, or when the probe cannot tell', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_user_prompt_submit', { ...payload, pid: 4242 }, 0);
    expect(sessions.sweepDeparted(probeOf({ 4242: 'alive' }).probe, 10)).toEqual([]);
    expect(sessions.sweepDeparted(probeOf({ 4242: 'unknown' }).probe, 10)).toEqual([]);
    expect(sessions.applyTo([], 10)).toHaveLength(1);
  });

  it('leaves rows from an observer that reports no pid to the silence TTL', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_user_prompt_submit', payload, 0);
    const { calls, probe } = probeOf({});
    expect(sessions.sweepDeparted(probe, 10)).toEqual([]);
    expect(calls).toEqual([]);
    expect(sessions.applyTo([], 10)).toHaveLength(1);
  });

  it('probes a shared gateway process once and closes all of its conversations', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_user_prompt_submit', { ...payload, pid: 7 }, 0);
    sessions.note('hermes_user_prompt_submit', { ...payload, session_id: other, pid: 7 }, 1);
    const { calls, probe } = probeOf({ 7: 'dead' });
    expect(sessions.sweepDeparted(probe, 10).sort()).toEqual([session_id, other].sort());
    expect(calls).toEqual([7]);
  });

  it('reopens a resumed conversation from its new process', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_user_prompt_submit', { ...payload, pid: 4242 }, 0);
    sessions.sweepDeparted(probeOf({ 4242: 'dead' }).probe, 10);
    expect(sessions.note('hermes_user_prompt_submit', { ...payload, pid: 5151 }, 20)).toBe(true);
    expect(sessions.sweepDeparted(probeOf({ 4242: 'dead', 5151: 'alive' }).probe, 30)).toEqual([]);
    expect(sessions.applyTo([], 30)).toHaveLength(1);
  });

  it('keeps a running CLI conversation on screen like OpenClaw, but not a gateway one', () => {
    const sessions = new HermesSessions();
    sessions.note('hermes_user_prompt_submit', { ...payload, pid: 7, platform: 'cli' }, 0);
    sessions.note('hermes_user_prompt_submit', { ...payload, session_id: other, pid: 8, platform: 'telegram' }, 0);
    sessions.note('hermes_stop', { ...payload, pid: 7, platform: 'cli' }, 1);
    // The live process refreshes the CLI row on every sweep; the gateway row ages out.
    for (let now = 60_000; now < HERMES_SILENCE_TTL_MS + 120_000; now += 60_000) {
      sessions.sweepDeparted(() => 'alive', now);
    }
    const rows = sessions.applyTo([], HERMES_SILENCE_TTL_MS + 120_000);
    expect(rows.map((r) => r.id)).toEqual([`observed:hermes:${session_id}`]);
  });

  it('reads only "no such process" as dead', () => {
    expect(hermesPidLiveness(process.pid)).toBe('alive');
    const exited = spawnSync(process.execPath, ['-e', '0']).pid;
    if (exited) expect(hermesPidLiveness(exited)).toBe('dead');
  });
});
