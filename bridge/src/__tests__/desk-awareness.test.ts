import { describe, it, expect } from 'vitest';
import type { SessionInfo, TimelineEntry } from '@agentdeck/shared';
import { deskSignal, renderDeskAwareness } from '../pixoo/desk-awareness.js';
const row = (state: string, alive = true): SessionInfo => ({ id: state, port: 0, projectName: 'test', alive, state });
const result = (ts: number, status?: TimelineEntry['status']): TimelineEntry => ({ ts, type: 'chat_response', raw: 'Result', status });
describe('desk awareness', () => {
  it('prioritizes real waiting over recent results and ignores dead sessions', () => {
    expect(deskSignal([row('awaiting_permission'), row('processing'), row('awaiting_option', false)], [result(99)], 100)).toEqual({kind:'waiting',count:1});
  });
  it('does not mistake idle, missing sessions, or abandoned work for completion', () => {
    expect(deskSignal([row('idle')], [result(99,'abandoned')], 100).kind).toBe('idle');
    expect(deskSignal([], [], 100).kind).toBe('idle');
    expect(deskSignal(null, [], 100).kind).toBe('unknown');
  });
  it('retains explicit results for 90 seconds, rejects future timestamps', () => {
    expect(deskSignal([], [result(100)], 89999).kind).toBe('done');
    expect(deskSignal([], [result(100)], 90100).kind).toBe('idle');
    expect(deskSignal([], [result(101)], 100).kind).toBe('idle');
  });
  it.each([11,32] as const)('keeps quiet states stable and attention visible at %s pixels', size => {
    const work = [row('processing')];
    expect(renderDeskAwareness(size, work, [], 100)).toEqual(renderDeskAwareness(size, work, [], 2000));
    expect(renderDeskAwareness(size, [row('awaiting_permission')], [], 100)).not.toEqual(renderDeskAwareness(size, work, [], 100));
    expect(renderDeskAwareness(size, null, [], 100)).not.toEqual(renderDeskAwareness(size, [], [], 100));
  });
});
