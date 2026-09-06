import { describe, expect, it } from 'vitest';
import { prepareForSerial, TIMELINE_HISTORY_BYTE_BUDGET } from '../esp32-serial.js';
import type { BridgeEvent } from '@agentdeck/shared/protocol';

const event = (census?: unknown, size = 1): BridgeEvent => ({
  type: 'sessions_list',
  sessions: Array.from({ length: size }, (_, i) => ({
    id: `session-${i}`, port: 0, alive: true, agentType: 'claude-code', state: 'idle',
    projectName: 'project', ...(census ? { subagents: census } : {}),
  })),
} as BridgeEvent);

describe('IPS10 additive collaboration census', () => {
  it('preserves explicit zero and a parent idle with active children', () => {
    for (const active of [0, 3]) {
      const out = prepareForSerial(event({ active, peak: 3, completed: 2 }), { deviceInfo: { board: 'ips_10' } }) as any;
      expect(out.sessions[0].state).toBe('idle');
      expect(out.sessions[0].subagents).toEqual({ active, peak: 3, completed: 2 });
    }
  });
  it('leaves every other board and unidentified connection unchanged', () => {
    const input = event({ active: 3, peak: 3, completed: 0 });
    const baseline = prepareForSerial(event());
    expect(prepareForSerial(input)).toEqual(baseline);
    for (const board of ['86box', 'inkdeck', 'ips_35', 'future-board']) {
      expect(prepareForSerial(input, { deviceInfo: { board } })).toEqual(baseline);
    }
  });
  it('does not invent a census from absent or malformed evidence', () => {
    for (const c of [undefined, {}, { active: -1, peak: 1, completed: 0 }, { active: 1.2, peak: 2, completed: 0 }]) {
      const out = prepareForSerial(event(c), { deviceInfo: { board: 'ips_10' } }) as any;
      expect(out.sessions[0].subagents).toBeUndefined();
    }
  });
  it('drops only the enhancement when the conservative frame budget is exceeded', () => {
    const input = event({ active: 3, peak: 3, completed: 2 }, 10) as any;
    for (const s of input.sessions) { s.question = '가'.repeat(40); s.activity = '나'.repeat(26); }
    const out = prepareForSerial(input, { deviceInfo: { board: 'ips_10' } }) as any;
    const baseline = prepareForSerial(input) as any;
    expect(Buffer.byteLength(JSON.stringify(baseline))).toBeLessThanOrEqual(TIMELINE_HISTORY_BYTE_BUDGET);
    expect(out).toEqual(baseline);
    expect(out.sessions.every((s: any) => s.subagents === undefined)).toBe(true);
    expect(out.sessions).toHaveLength(10);
  });
});
