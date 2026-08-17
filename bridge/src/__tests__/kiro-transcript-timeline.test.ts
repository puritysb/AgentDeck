/**
 * Detail-view rows for an observed Kiro session.
 *
 * The fixtures below are TRANSCRIBED from a real Kiro CLI v3 transcript
 * (`~/.kiro/sessions/cli/<uuid>.jsonl`, read 2026-08-17), not imagined. This
 * repo has a specific history of Kiro parsers written against invented shapes
 * that passed their own tests and matched nothing on disk — every one of the
 * five was caught only by going back to real data. So the two properties that
 * an invented fixture would have got wrong are asserted explicitly:
 *
 *   - `meta.timestamp` is in SECONDS (1786933404 → 2026-08-17T02:23Z)
 *   - only `Prompt` carries a timestamp; `AssistantMessage` has none at all
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { kiroTimelineForSession } from '../kiro-transcript-timeline.js';

const UUID = '6b3d3a27-f18e-4276-9438-3491fffe27e7';

/** Verbatim record shapes from the measured transcript. */
const PROMPT = (text: string, tsSeconds: number) => JSON.stringify({
  version: 'v1',
  kind: 'Prompt',
  data: {
    message_id: 'a6081b46-6ef1-4824-88d4-1c3c0408d278',
    content: [{ kind: 'text', data: text }],
    meta: { timestamp: tsSeconds },
  },
});

const ASSISTANT = (text: string) => JSON.stringify({
  version: 'v1',
  kind: 'AssistantMessage',
  data: {
    message_id: '66649d17-50f1-490d-9fe7-befd3777dd9f',
    // A `thinking` block precedes the text block in every real record, and it
    // carries an OBJECT, not a string — a parser that assumed `data` is always
    // a string would concatenate "[object Object]" into the row.
    content: [
      { kind: 'thinking', data: { text: '', signature: null, redactedContent: null } },
      { kind: 'text', data: text },
    ],
  },
});

const TOOL_RESULTS = JSON.stringify({
  version: 'v1',
  kind: 'ToolResults',
  data: { content: [{ kind: 'toolResult', data: { toolUseId: 'tooluse_e6zfT83FyPlU7fK1T' } }] },
});

describe('kiroTimelineForSession', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kiro-sessions-'));
    mkdirSync(join(root, 'cli'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeTranscript(lines: string[], dir = 'cli'): void {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, `${UUID}.jsonl`), lines.join('\n') + '\n');
  }

  it('turns a real transcript into paired chat rows', () => {
    writeTranscript([
      PROMPT('hello', 1786897401),
      ASSISTANT('Hello! How can I help you with AgentDeck today?'),
      PROMPT('hi', 1786933404),
      ASSISTANT('Hi! 무엇을 도와드릴까요?'),
    ]);
    const rows = kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root });
    expect(rows.map((r) => [r.type, r.raw])).toEqual([
      ['chat_start', 'hello'],
      ['chat_response', 'Hello! How can I help you with AgentDeck today?'],
      ['chat_start', 'hi'],
      ['chat_response', 'Hi! 무엇을 도와드릴까요?'],
    ]);
    expect(rows.every((r) => r.agentType === 'kiro-cli')).toBe(true);
    // Keyed by the BARE uuid, because that is what the timeline compares
    // against after `rawSessionId` — the whole point of #216.
    expect(rows.every((r) => r.sessionId === UUID)).toBe(true);
  });

  it('reads the timestamp as seconds, not milliseconds', () => {
    // 1786933404 is 2026-08-17. Read as milliseconds it would be 1970-01-21,
    // which sorts before everything and silently vanishes under any `since`.
    writeTranscript([PROMPT('hi', 1786933404), ASSISTANT('Hi!')]);
    const [prompt, response] = kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root });
    expect(new Date(prompt.ts).toISOString()).toBe('2026-08-17T02:23:24.000Z');
    // The assistant record carries NO timestamp, so it takes its prompt's —
    // nudged so it cannot sort before the thing it answers.
    expect(response.ts).toBe(prompt.ts + 1);
  });

  it('gives every reply record in one turn its own timestamp', () => {
    // Kiro writes SEVERAL AssistantMessage records for one prompt — a reply
    // that resumes after a tool call is a second record, and the measured
    // transcript has two such turns. Stamping them all `prompt + 1` collided
    // them: the timeline's ts-keyed dedup folded them into one row, and the
    // feed's watermark could not tell an unseen record from one it had already
    // emitted, so every reply after a turn's first was silently dropped.
    writeTranscript([
      PROMPT('go', 1786975378),
      ASSISTANT('first part'),
      TOOL_RESULTS,
      ASSISTANT('second part'),
    ]);
    const rows = kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root });
    expect(rows.map((r) => r.raw)).toEqual(['go', 'first part', 'second part']);
    expect(new Set(rows.map((r) => r.ts)).size).toBe(3);
    // Strictly increasing, so `since` can walk them one at a time.
    expect(rows[1].ts).toBeLessThan(rows[2].ts);
    // And the next prompt still sorts after all of them.
    writeTranscript([
      PROMPT('go', 1786975378), ASSISTANT('a'), ASSISTANT('b'),
      PROMPT('next', 1786975379), ASSISTANT('c'),
    ]);
    const ts = kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root }).map((r) => r.ts);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it('keeps thinking blocks and tool results out of the rows', () => {
    writeTranscript([PROMPT('ls -la 해줘', 1786898236), TOOL_RESULTS, ASSISTANT('현재 디렉토리 내용')]);
    const rows = kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('object Object');
    expect(JSON.stringify(rows)).not.toContain('toolUseId');
  });

  it('honours since and limit against the row timestamps', () => {
    writeTranscript([
      PROMPT('old', 1786897401), ASSISTANT('old reply'),
      PROMPT('new', 1786933404), ASSISTANT('new reply'),
    ]);
    const since = 1786900000 * 1000;
    expect(kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root, since })
      .map((r) => r.raw)).toEqual(['new', 'new reply']);
    expect(kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root, limit: 1 })
      .map((r) => r.raw)).toEqual(['new reply']);
  });

  it('returns nothing rather than guessing when it cannot read', () => {
    // No transcript (a v2 session keeps its conversation in SQLite), an
    // unknown session, and a half-written tail line all resolve to "no rows",
    // which the caller renders as "no recent activity".
    expect(kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root })).toEqual([]);
    writeTranscript([PROMPT('hi', 1786933404), '{"kind":"AssistantMessage","data":{"con']);
    expect(kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root })
      .map((r) => r.raw)).toEqual(['hi']);
    expect(kiroTimelineForSession('observed:kiro:', { sessionsRoot: root })).toEqual([]);
  });

  it('finds a session under a workspace-hash directory, not just cli/', () => {
    // v3 keys sessions by workspace hash; `cli` is only one of the directories.
    writeTranscript([PROMPT('hi', 1786933404), ASSISTANT('Hi!')], 'a6cb67a906f608db');
    expect(kiroTimelineForSession(`observed:kiro:${UUID}`, { sessionsRoot: root })).toHaveLength(2);
  });
});
