import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '@agentdeck/shared';
import { isSubagentOnlyHook, SubagentTimelineTracker } from '../subagent-timeline.js';

describe('SubagentTimelineTracker', () => {
  it('collapses start and stop into existing compatible Timeline types', () => {
    const entries: TimelineEntry[] = [];
    let now = 1_000;
    const tracker = new SubagentTimelineTracker((entry) => entries.push(entry), () => now);

    expect(tracker.handle({
      eventName: 'SubagentStart',
      payload: { agent_id: 'child-1', agent_type: 'Explore' },
      sessionId: 'parent-1',
      agentType: 'claude-code',
      projectName: 'AgentDeck',
    }).childOnly).toBe(true);

    now = 4_000;
    expect(tracker.handle({
      eventName: 'SubagentStop',
      payload: {
        agent_id: 'child-1',
        agent_type: 'Explore',
        last_assistant_message: '인증 흐름에서 경쟁 조건 2건을 확인했습니다.',
      },
      sessionId: 'parent-1',
      agentType: 'claude-code',
      projectName: 'AgentDeck',
    }).childOnly).toBe(true);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: 'tool_exec',
      raw: 'Subagent Explore · dispatched',
      sessionId: 'parent-1',
      summaryKind: 'progress',
    });
    expect(entries[1]).toMatchObject({
      type: 'tool_resolved',
      raw: 'Subagent Explore#ild1 · 3s · 인증 흐름에서 경쟁 조건 2건을 확인했습니다.',
      sessionId: 'parent-1',
      startedAt: 1_000,
      endedAt: 4_000,
      summaryKind: 'heuristic',
    });
  });

  it('consumes child tool hooks without producing per-tool noise or controls', () => {
    const entries: TimelineEntry[] = [];
    const tracker = new SubagentTimelineTracker((entry) => entries.push(entry));
    const payload = {
      session_id: 'parent-1',
      agent_id: 'child-1',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
    };

    expect(isSubagentOnlyHook('PreToolUse', payload)).toBe(true);
    expect(tracker.handle({
      eventName: 'PreToolUse',
      payload,
      sessionId: 'parent-1',
      agentType: 'claude-code',
    }).childOnly).toBe(true);
    expect(entries).toEqual([]);
  });

  it('keeps future child notification and stop hooks out of parent control', () => {
    const payload = { session_id: 'parent-1', agent_id: 'child-1' };
    expect(isSubagentOnlyHook('Notification', payload)).toBe(true);
    expect(isSubagentOnlyHook('Stop', payload)).toBe(true);
  });

  it('summarizes team task completion without exposing team settings', () => {
    const entries: TimelineEntry[] = [];
    const tracker = new SubagentTimelineTracker((entry) => entries.push(entry), () => 9_000);

    tracker.handle({
      eventName: 'TaskCompleted',
      payload: {
        teammate_name: 'reviewer',
        task_subject: '릴리스 호환성 검토 완료',
      },
      sessionId: 'parent-1',
      agentType: 'claude-code',
    });

    expect(entries).toEqual([
      expect.objectContaining({
        type: 'tool_resolved',
        raw: 'Team reviewer · 릴리스 호환성 검토 완료',
      }),
    ]);
  });

  it('recognizes Codex lifecycle names and preserves the provider', () => {
    const entries: TimelineEntry[] = [];
    const tracker = new SubagentTimelineTracker((entry) => entries.push(entry), () => 5_000);

    tracker.handle({
      eventName: 'codex_subagent_stop',
      payload: {
        agent_id: 'agent-2',
        agent_type: 'reviewer',
        last_assistant_message: 'No compatibility regressions found.',
      },
      sessionId: 'thread-1',
      agentType: 'codex-cli',
    });

    expect(entries[0]).toMatchObject({
      type: 'tool_resolved',
      agentType: 'codex-cli',
      raw: 'Subagent reviewer#ent2 · No compatibility regressions found.',
    });
  });

  // The regression this whole file exists for. Measured on a real workflow
  // session (2026-08-17): 66 children, peak 8 concurrent, 260 overlapping
  // pairs — and the parent rendered as one serial list of identical
  // "· Completed" lines with zero start rows surviving.
  it('keeps a simultaneous fan-out distinguishable and counted', () => {
    const entries: TimelineEntry[] = [];
    const upserts: boolean[] = [];
    let now = 1_000;
    const tracker = new SubagentTimelineTracker(
      (entry, upsert) => { entries.push(entry); upserts.push(upsert === true); },
      () => now,
    );

    // Eight children of ONE workflow: same agent_type, same instant. Under
    // content dedup these are one row; only the ids tell them apart.
    for (let i = 0; i < 8; i++) {
      tracker.handle({
        eventName: 'SubagentStart',
        payload: { agent_id: `child-${i}`, agent_type: 'workflow-subagent' },
        sessionId: 'parent-1',
        agentType: 'claude-code',
      });
    }

    // One dispatch row, upserted in place, carrying the width of the fan-out.
    expect(entries).toHaveLength(8);
    expect(new Set(entries.map((e) => e.subagentId)).size).toBe(1);
    expect(upserts.every(Boolean)).toBe(true);
    expect(entries[7].raw).toBe('Subagent ×8 dispatched · workflow-subagent');
    expect(entries[7].ts).toBe(1_000);  // anchored at the burst, not walking

    expect(tracker.summary('parent-1')).toEqual({ active: 8, peak: 8, completed: 0 });

    // Children drain one at a time. Each completion is its own row, and each
    // names WHICH child finished — the ambiguity that made a single
    // "· Completed" read as "the work is done".
    now = 61_000;
    tracker.handle({
      eventName: 'SubagentStop',
      payload: { agent_id: 'child-3', agent_type: 'workflow-subagent' },
      sessionId: 'parent-1',
      agentType: 'claude-code',
    });

    const done = entries[8];
    expect(done.type).toBe('tool_resolved');
    expect(done.raw).toBe('Subagent workflow-subagent#ild3 · 1m · ended · no summary');
    expect(done.subagentId).toBe('child:parent-1:child-3');
    // `peak` survives the drain: 7 running is not the same story as a session
    // that only ever launched 7.
    expect(tracker.summary('parent-1')).toMatchObject({ active: 7, peak: 8, completed: 1 });
  });

  it('reports an explicit zero once a fan-out drains, never absence', () => {
    let now = 1_000;
    const tracker = new SubagentTimelineTracker(() => {}, () => now);

    // A session that never had a child says nothing at all — clients merge
    // retain-on-absent, so "no children ever" and "zero right now" cannot
    // share a representation.
    expect(tracker.summary('parent-1')).toBeNull();

    tracker.handle({
      eventName: 'SubagentStart',
      payload: { agent_id: 'child-1', agent_type: 'Explore' },
      sessionId: 'parent-1',
      agentType: 'claude-code',
    });
    now = 5_000;
    tracker.handle({
      eventName: 'SubagentStop',
      payload: { agent_id: 'child-1', agent_type: 'Explore' },
      sessionId: 'parent-1',
      agentType: 'claude-code',
    });

    expect(tracker.summary('parent-1')).toMatchObject({ active: 0, completed: 1 });
    expect(tracker.summaries().get('parent-1')).toBeDefined();
  });

  it('does not pin a parent at "running" when a stop hook is lost', () => {
    let now = 1_000;
    const tracker = new SubagentTimelineTracker(() => {}, () => now);
    tracker.handle({
      eventName: 'SubagentStart',
      payload: { agent_id: 'child-1', agent_type: 'Explore' },
      sessionId: 'parent-1',
      agentType: 'claude-code',
    });
    expect(tracker.summary('parent-1')).toMatchObject({ active: 1 });

    // Past the 6h active TTL with no stop: the child is written off, but the
    // census row stays so the wire keeps carrying an explicit zero.
    now = 1_000 + 7 * 60 * 60 * 1000;
    expect(tracker.summary('parent-1')).toMatchObject({ active: 0 });
  });

  it('separates one wave from the next', () => {
    let now = 1_000;
    const tracker = new SubagentTimelineTracker(() => {}, () => now);
    const start = (id: string) => tracker.handle({
      eventName: 'SubagentStart',
      payload: { agent_id: id, agent_type: 'w' },
      sessionId: 'p',
      agentType: 'claude-code',
    });
    const stop = (id: string) => tracker.handle({
      eventName: 'SubagentStop',
      payload: { agent_id: id, agent_type: 'w' },
      sessionId: 'p',
      agentType: 'claude-code',
    });

    start('a'); start('b');
    now = 20_000;
    stop('a'); stop('b');
    // Drained — the next dispatch is a new burst, not a continuation.
    now = 200_000;
    start('c');
    expect(tracker.summary('p')).toMatchObject({ active: 1, peak: 2 });
  });

  it('reports a census change so the parent row can be rebroadcast', () => {
    const tracker = new SubagentTimelineTracker(() => {});
    expect(tracker.handle({
      eventName: 'SubagentStart',
      payload: { agent_id: 'c1', agent_type: 'w' },
      sessionId: 'p',
      agentType: 'claude-code',
    }).censusChangedFor).toBe('p');
    // A child's own tool hook is consumed but changes no count — rebroadcasting
    // on it would put a sessions_list frame behind every tool call a child makes.
    expect(tracker.handle({
      eventName: 'PreToolUse',
      payload: { agent_id: 'c1', tool_name: 'Bash' },
      sessionId: 'p',
      agentType: 'claude-code',
    }).censusChangedFor).toBeUndefined();
  });
});
