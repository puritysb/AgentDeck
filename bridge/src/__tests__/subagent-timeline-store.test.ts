/**
 * The two store-level mechanisms that erased subagent parallelism.
 *
 * Both were correct-looking rules with the wrong blast radius, and both were
 * measured on a real session (2026-08-17, `epoch-of-tech`): 72 child
 * completions carrying start timestamps — peak 8 concurrent, 260 overlapping
 * pairs — and **zero** dispatch rows left in the persisted buffer.
 *
 *   1. content dedup collapsed a simultaneous fan-out into one row, because
 *      siblings of one workflow share an `agent_type` and therefore a raw
 *      string; and
 *   2. eviction shed `tool_exec` first, so the dispatch row was always the
 *      first casualty in exactly the sessions that produce the most tool rows.
 */

import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '@agentdeck/shared';
import { BridgeTimelineStore } from '../timeline-store.js';

function dispatch(id: string, ts: number, raw: string): TimelineEntry {
  return { ts, type: 'tool_exec', raw, sessionId: 'p', subagentId: id, startedAt: ts };
}

describe('subagent rows in the bridge timeline store', () => {
  it('keeps siblings of one fan-out that share a label and an instant', () => {
    const store = new BridgeTimelineStore();
    // Same type, byte-identical raw, same millisecond — the exact shape the
    // 8-second dedup drops. Distinct ids are what makes them distinct rows.
    for (let i = 0; i < 8; i++) {
      store.addEntry({
        ts: 1_000,
        type: 'tool_resolved',
        raw: 'Subagent workflow-subagent · ended · no summary',
        sessionId: 'p',
        subagentId: `child:p:${i}`,
      });
    }
    expect(store.getHistory().filter((e) => e.subagentId)).toHaveLength(8);
  });

  it('still dedups identical rows that claim no child identity', () => {
    const store = new BridgeTimelineStore();
    for (let i = 0; i < 8; i++) {
      store.addEntry({ ts: 1_000, type: 'tool_resolved', raw: 'Read config.json', sessionId: 'p' });
    }
    expect(store.getHistory()).toHaveLength(1);
  });

  it('upserts a growing dispatch burst in place, past the 1s tolerance', () => {
    const store = new BridgeTimelineStore();
    store.upsertEntry(dispatch('burst:p:1', 1_000, 'Subagent ×1 dispatched · w'));
    // A fan-out can keep growing for the whole burst window; the generic
    // timestamp-proximity upsert would have forked a second row here.
    store.upsertEntry(dispatch('burst:p:1', 1_000, 'Subagent ×8 dispatched · w'));

    const rows = store.getHistory().filter((e) => e.type === 'tool_exec');
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).toBe('Subagent ×8 dispatched · w');
  });

  it('does not shed the dispatch row ahead of ordinary tool rows', () => {
    const store = new BridgeTimelineStore();
    store.addEntry(dispatch('burst:p:1', 1, 'Subagent ×8 dispatched · w'));
    // Overflow the 200-entry buffer with plain tool rows. The rule "shed
    // tool_exec first" is right for these; applying it to the dispatch row
    // split it from the completions it pairs with.
    for (let i = 0; i < 400; i++) {
      store.addEntry({ ts: 100 + i, type: 'tool_exec', raw: `Bash cmd-${i}`, sessionId: 'p' });
    }
    expect(store.getHistory().some((e) => e.subagentId === 'burst:p:1')).toBe(true);
  });
});

/**
 * The same rule with the wrong blast radius, one agent over.
 *
 * OpenClaw reaches the daemon over the Gateway WebSocket, and that stream
 * carries no tool calls at all — so its tool rows are read from OpenClaw's own
 * transcript and are the ONLY account of what it did. "Shed `tool_exec` first"
 * targets the observed-agent hook firehose (measured at 87% of a live buffer);
 * applied to a producer that emits nothing else, it did not thin those rows but
 * removed them entirely. Measured 2026-08-23: the feed logged its emission and
 * the buffer never held a single row.
 */
describe('OpenClaw transcript rows vs. tool_exec-first eviction', () => {
  const openclawRow = (ts: number, raw: string) => ({
    ts,
    type: 'tool_exec' as const,
    raw,
    detail: 'session: main\nok · exit 0',
    agentType: 'openclaw',
    sessionId: 'openclaw-gateway',
  });

  it('does not let an OpenClaw row evict itself on insertion into a full buffer', () => {
    const store = new BridgeTimelineStore();
    // A busy machine: the buffer is already at capacity with other agents'
    // turns, which is the steady state whenever anything else is running.
    for (let i = 0; i < 200; i++) {
      store.addEntry({ ts: 100 + i, type: 'chat_response', raw: `reply ${i}`, sessionId: `c${i}` });
    }
    store.addEntry(openclawRow(9_000, 'read · heartbeat-state.json'));
    // `addEntry` pushes then evicts. With the carve-out missing, the row just
    // added was the only plain `tool_exec` in the buffer and so was its own
    // first casualty — the emission and the absence looked identical.
    expect(store.getHistory().filter((e) => e.agentType === 'openclaw')).toHaveLength(1);
  });

  it('sheds an observed agent\'s tool rows ahead of OpenClaw\'s', () => {
    const store = new BridgeTimelineStore();
    store.addEntry(openclawRow(1, 'read · heartbeat-state.json'));
    for (let i = 0; i < 400; i++) {
      store.addEntry({ ts: 100 + i, type: 'tool_exec', raw: `Bash cmd-${i}`, sessionId: 'p' });
    }
    expect(store.getHistory().some((e) => e.agentType === 'openclaw')).toBe(true);
  });
});
