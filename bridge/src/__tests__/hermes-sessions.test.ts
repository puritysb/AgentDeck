import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HermesSessions, HERMES_SILENCE_TTL_MS } from '../hermes-sessions.js';
const session_id = `hermes-${'a'.repeat(32)}`;
const payload = { session_id, model: 'custom-model', project_name: 'Hermes · telegram' };

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
    sessions.note('hermes_user_prompt_submit', payload, 0);
    expect(sessions.applyTo([], HERMES_SILENCE_TTL_MS)).toEqual([]);
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
