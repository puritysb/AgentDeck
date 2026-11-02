import { describe, expect, it } from 'vitest';
// Recording-only sample feed; these checks do not claim live controller execution.
// @ts-expect-error developer fixture is intentionally plain JavaScript
import { communications, makeTourScene, tourDetail, tourTasks } from '../product-tour-fixture.mjs';

describe('product tour recording boundaries', () => {
  it('keeps every visual-only agent non-answerable and identifies supported agent types', () => {
    const frames = makeTourScene('overview', 1800000000000);
    const sessions = frames.find((f: any) => f.type === 'sessions_list').sessions;
    expect(new Set(sessions.map((s: any) => s.agentType)).size).toBe(7);
    expect(sessions.some((s: any) => s.agentType === 'kiro-cli')).toBe(true);
    for (const s of sessions) {
      expect(s.controllerInput).toBe(false);
      expect(s.controllerAnswerable).toBe(false);
      expect(s.liveAnswerable).toBe(false);
      expect(s.port).not.toBe(9120);
    }
    expect(frames.find((f: any) => f.type === 'usage_update').claudeRateLimits).toBeUndefined();
  });
  it('provides attributed timeline anchors and typed task evidence, separate from sample AI judgement', () => {
    const frames = makeTourScene('history', 1800000000000);
    const entries = frames.find((f: any) => f.type === 'timeline_history').entries;
    for (const e of entries) expect(Number.isInteger(e.ts)).toBe(true);
    expect(entries.some((e: any) => e.sessionId === 'tour-codex' && e.type === 'chat_start')).toBe(true);
    const task = tourTasks('tour-claude', 1800000000000)[0];
    const detail = tourDetail(task.id, 1800000000000);
    expect(detail.sample.sessionId).toBe(task.sessionId);
    expect(detail.sample.events[0].kind).toBe('user_message');
    expect(detail.sample.events.at(-1).kind).toBe('assistant_message');
    expect(detail.evals[0].judgeModel).toMatch(/^sample-/);
    expect(detail.feedback).toBeUndefined();
    expect(tourDetail('missing')).toBeNull();
  });
  it('distinguishes explicit reply requests from one-way notifications', () => {
    const snapshot = communications(1800000000000);
    expect(snapshot.schema).toBe('agentdeck-communications/v1');
    expect(snapshot.events.map((e: any) => e.messageIntent)).toEqual(['request', 'notification']);
    expect(() => makeTourScene('unrecognised')).toThrow();
  });
});
