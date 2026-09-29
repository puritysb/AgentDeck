import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compactSessionLabels } from '../compact-session-labels.js';
import { prepareForSerial, TIMELINE_HISTORY_BYTE_BUDGET } from '../esp32-serial.js';
const vectors = JSON.parse(readFileSync('shared/compact-session-label-vectors.json', 'utf8'));
describe('compact device labels', () => {
  for (const vector of vectors) it(vector.name, () => {
    expect(Object.fromEntries(compactSessionLabels(vector.rows, vector.board))).toEqual(vector.expected);
    expect(Object.fromEntries(compactSessionLabels([...vector.rows].reverse(), vector.board))).toEqual(vector.expected);
  });
  it('keeps the generated Swift contract synchronized', () => {
    execFileSync(process.execPath, ['bridge/generate-compact-session-labels.mjs', '--check']);
  });
  it('numbers before the roster cap, preserving raw identity and controls', () => {
    const sessions = Array.from({length: 12}, (_, i) => ({id: `session-${String(i).padStart(2, '0')}`, projectName: 'AgentDeck', alive: true, port: 0, agentType: 'claude-code' as const, state: i === 11 ? 'awaiting_permission' : 'idle', question: i === 11 ? 'Approve?' : ''}));
    const result = prepareForSerial({type: 'sessions_list', sessions}) as any;
    const awaiting = result.sessions.find((s: any) => s.id === 'session-11');
    expect(awaiting).toMatchObject({projectName: 'AgentDeck', displayName: 'AgentDeck #12', question: 'Approve?', state: 'awaiting_permission'});
    expect(sessions[11]).not.toHaveProperty('displayName');
    expect(result.sessions).toHaveLength(10);
    const ttgo = prepareForSerial({type: 'sessions_list', sessions: sessions.map(s => ({...s, projectName: 'AgentDeck-long-project'}))}, {deviceInfo: {board: 'ttgo_t_display'}}) as any;
    expect(ttgo.sessions.find((s: any) => s.id === 'session-11').displayName).toBe('AgentDeck-lo #12');
    expect(ttgo.sessions.every((s: any) => Buffer.byteLength(s.displayName, 'utf8') < 20)).toBe(true);
  });
  it('adds no label bytes when the baseline frame already exceeds the budget', () => {
    const sessions = Array.from({length: 10}, (_, i) => ({id: String(i), projectName: 'AgentDeck', alive: true, port: 0, question: 'q'.repeat(159), activity: 'a'.repeat(79), lastEventText: 'e'.repeat(99), currentTool: 't'.repeat(39)}));
    const result = prepareForSerial({type: 'sessions_list', sessions}) as any;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(TIMELINE_HISTORY_BYTE_BUDGET);
    expect(result.sessions.every((s: any) => !s.displayName)).toBe(true);
  });
});
