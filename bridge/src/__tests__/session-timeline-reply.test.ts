import { describe, expect, it } from 'vitest';
import { buildSessionTimelineReply } from '../session-timeline-reply.js';
import { resolveSessionIdPrefix } from '../session-id-resolve.js';
import type { TimelineEntry } from '../types.js';

// Ids as they really are: a 36-char UUID and the 52-char observed form. A
// board holds the 31-byte cut its sessions_list carried.
const UUID = 'a3dab322-5f0e-4c6b-9d1a-7e2f40c0ffee';
const OBSERVED = `observed:claude:${UUID}`;

function source(rows: Record<string, Array<Record<string, unknown>>>) {
  const asked: Array<{ sessionId: string; toolEvents: boolean }> = [];
  return {
    asked,
    resolveSessionId: (raw: unknown) => (typeof raw === 'string' && raw ? resolveSessionIdPrefix(raw, Object.keys(rows)) : ''),
    entriesFor: (sessionId: string, _sinceMs: number | undefined, toolEvents: boolean) => {
      asked.push({ sessionId, toolEvents });
      return (rows[sessionId] ?? []) as unknown as TimelineEntry[];
    },
  };
}

const turn = (sessionId: string) => [
  { ts: 1752700000000, type: 'chat_start', raw: 'run the suite', sessionId },
  { ts: 1752700001000, type: 'tool_request', raw: 'Bash requested', sessionId, toolEvent: true },
  { ts: 1752700002000, type: 'tool_resolved', raw: 'Bash completed', sessionId, toolEvent: true },
  // The Stop handler keeps up to 3,000 characters of a reply.
  { ts: 1752700003000, type: 'chat_response', raw: 'All tests pass.', detail: '完'.repeat(3000), sessionId },
];

describe('query_session_timeline reply', () => {
  it('answers a board under the id it asked with, for a UUID and an observed id alike', () => {
    for (const id of [UUID, OBSERVED]) {
      const src = source({ [id]: turn(id) });
      const reply = buildSessionTimelineReply({ sessionId: id.slice(0, 31) }, { toolEvents: false, board: true }, src) as
        unknown as { sessionId: string; entries: Array<Record<string, unknown>> };
      expect(src.asked).toEqual([{ sessionId: id, toolEvents: false }]);
      expect(reply.sessionId).toBe(id.slice(0, 31));
      expect(reply.entries.map((e) => e.type)).toEqual(['chat_start', 'chat_response']);
    }
  });

  it('trims a board\'s rows before the byte budget, so a long newest reply still leaves an answer', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => ({ ts: 1752600000000 + i, type: 'chat_start', raw: `prompt ${i}`, sessionId: UUID })),
      ...turn(UUID),
    ];
    const reply = buildSessionTimelineReply({ sessionId: UUID }, { toolEvents: false, board: true }, source({ [UUID]: rows })) as
      unknown as { entries: Array<{ type: string; raw: string; detail?: string; localHm?: string }> };
    expect(reply).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(reply), 'utf8')).toBeLessThan(4096);
    expect(reply.entries.length).toBeGreaterThan(10);
    const newest = reply.entries.at(-1)!;
    expect(newest.type).toBe('chat_response');
    expect(Buffer.byteLength(newest.detail ?? '', 'utf8')).toBeLessThanOrEqual(199);
    expect(newest.localHm).toMatch(/^\d\d:\d\d$/);
  });

  it('gives a dashboard the resolved id and full rows, with tool rows only when it opted in', () => {
    const plain = buildSessionTimelineReply({ sessionId: UUID.slice(0, 31) }, { toolEvents: false, board: false },
      source({ [UUID]: turn(UUID) })) as unknown as { sessionId: string; entries: Array<{ type: string; detail?: string }> };
    expect(plain.sessionId).toBe(UUID);
    expect(plain.entries.map((e) => e.type)).toEqual(['chat_start', 'chat_response']);
    expect(plain.entries[1].detail).toHaveLength(3000);

    const src = source({ [UUID]: turn(UUID) });
    const opted = buildSessionTimelineReply({ sessionId: UUID }, { toolEvents: true, board: false }, src) as
      unknown as { entries: Array<{ type: string }> };
    expect(src.asked).toEqual([{ sessionId: UUID, toolEvents: true }]);
    expect(opted.entries.map((e) => e.type)).toEqual(['chat_start', 'tool_request', 'tool_resolved', 'chat_response']);
  });

  it('answers nothing without a session id or rows', () => {
    const src = source({ [UUID]: [] });
    expect(buildSessionTimelineReply({}, { toolEvents: false, board: true }, src)).toBeNull();
    expect(buildSessionTimelineReply({ sessionId: 42 }, { toolEvents: false, board: true }, src)).toBeNull();
    expect(buildSessionTimelineReply({ sessionId: UUID }, { toolEvents: false, board: true }, src)).toBeNull();
  });
});
