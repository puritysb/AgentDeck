/**
 * OpenClaw transcript reader — the producer for the tool calls the Gateway
 * stream never carries.
 *
 * EVERY fixture line below is copied VERBATIM from a real store
 * (`~/.openclaw/agents/main/sessions`, OpenClaw 2026.7.1-2, read 2026-08-23),
 * with only long output text shortened. This repo has a specific history of
 * parsers written against imagined fixtures that passed their tests and matched
 * nothing real, so nothing here is composed from what the reader expects.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listOpenClawSessions,
  openClawTimelineForSession,
  summarizeToolArguments,
} from '../openclaw-transcript-timeline.js';

const SID = 'fef73899-0116-4243-9e69-3f0686b646cc';

/** Real lines. `session` header, a user turn, an assistant turn carrying
 *  thinking + a toolCall, its toolResult, a FAILING toolResult (isError with no
 *  exitCode — the shape a non-exec tool produces), and a call left unresolved
 *  because its approval was abandoned. */
const TRANSCRIPT = [
  '{"type":"session","version":3,"id":"fef73899-0116-4243-9e69-3f0686b646cc","timestamp":"2026-08-22T23:52:16.443Z","cwd":"/Users/puritysb/.openclaw/workspace"}',
  '{"type":"message","id":"40296bc1","parentId":"61797528","timestamp":"2026-08-22T23:52:16.501Z","message":{"role":"user","content":"~/github/OpenClaw 저장소에서 다음을 조사하라.","timestamp":1787442736074}}',
  '{"type":"message","id":"577c04b8","parentId":"40296bc1","timestamp":"2026-08-22T23:52:23.315Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"The user wants me to investigate the ~/github/OpenClaw repository.","thinkingSignature":"reasoning_details"},{"type":"toolCall","id":"38e16c61-6e3f-46cb-b3c1-aaeb7ad53d30","name":"exec","arguments":{"command":"ls ~/github/OpenClaw && rg -n \\"8899\\" ~/github/OpenClaw --max-count=3 -l | head -50"}}],"api":"openai-completions","provider":"openrouter","model":"stealth/ox-alpha","usage":{"input":2568,"output":55,"cacheRead":42880,"totalTokens":45503},"stopReason":"toolUse","timestamp":1787442743315}}',
  '{"type":"message","id":"53079fbe","parentId":"577c04b8","timestamp":"2026-08-22T23:52:23.376Z","message":{"role":"toolResult","toolCallId":"38e16c61-6e3f-46cb-b3c1-aaeb7ad53d30","toolName":"exec","content":[{"type":"text","text":"CAPTURE_GUIDE.md\\nCLAUDE.md\\nzsh:1: command not found: rg"}],"details":{"status":"completed","exitCode":0,"exitSignal":null,"exitReason":"exit","durationMs":13},"isError":false,"timestamp":1787442743376}}',
  '{"type":"message","id":"84ea1172","parentId":"53079fbe","timestamp":"2026-08-22T23:52:40.100Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_27be8b4ea0e54e1f97997c2a","name":"message","arguments":{"action":"send","to":"peer"}}],"provider":"openrouter","model":"stealth/ox-alpha","stopReason":"toolUse"}}',
  '{"type":"message","id":"68d855ea","parentId":"84ea1172","timestamp":"2026-08-22T23:52:40.391Z","message":{"role":"toolResult","toolCallId":"call_27be8b4ea0e54e1f97997c2a","toolName":"message","content":[{"type":"text","text":"{\\n  \\"status\\": \\"error\\",\\n  \\"tool\\": \\"message\\"\\n}"}],"details":{"status":"error","tool":"message","error":"message.send buffer has invalid base64 data"},"isError":true,"timestamp":1787442760391}}',
  '{"type":"message","id":"9f11aa02","parentId":"68d855ea","timestamp":"2026-08-23T00:07:07.799Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"6f3c4617-f6e7-4571-a503-5b382061c582","name":"exec","arguments":{"command":"sed -n \'90,135p\' ~/github/OpenClaw/scripts/health-check.sh"}}],"provider":"openrouter","model":"stealth/ox-alpha","stopReason":"toolUse"}}',
].join('\n');

/** Real index shape: keys ARE the session keys. */
const INDEX = JSON.stringify({
  'agent:main:main': { sessionId: 'c0565ce0-9fcc-4ed9-868a-b7d4ae186266', updatedAt: 1787432460000 },
  'agent:main:eval-full-unified-mlx-2026-08-23-a03__openrouter-stealth-ox-alpha__r2': {
    sessionId: SID, updatedAt: 1787443645539,
  },
  'agent:main:cron:41b100c9-2d39-44f6-aa97-58f1c7c89f71': { sessionId: 'aaaa1111', updatedAt: 1787400000000 },
});

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'openclaw-store-'));
  const sessions = join(root, 'agents', 'main', 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'sessions.json'), INDEX);
  writeFileSync(join(sessions, `${SID}.jsonl`), TRANSCRIPT);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listOpenClawSessions', () => {
  it('reads the index keys as session keys, newest first', () => {
    const out = listOpenClawSessions({ stateDir: root });
    expect(out.map((s) => s.sessionKey)).toEqual([
      'agent:main:eval-full-unified-mlx-2026-08-23-a03__openrouter-stealth-ox-alpha__r2',
      'agent:main:main',
      'agent:main:cron:41b100c9-2d39-44f6-aa97-58f1c7c89f71',
    ]);
    expect(out[0].sessionId).toBe(SID);
    expect(out[0].agent).toBe('main');
  });

  it('returns nothing rather than throwing when there is no store', () => {
    expect(listOpenClawSessions({ stateDir: join(root, 'nope') })).toEqual([]);
  });
});

describe('openClawTimelineForSession', () => {
  const rows = () => openClawTimelineForSession(SID, { stateDir: root });

  it('emits one row per tool CALL — the gap the Gateway stream leaves', () => {
    // The Gateway only ever surfaced tools that needed approval, which is a
    // biased sample. All three calls appear here.
    const out = rows();
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.type === 'tool_exec')).toBe(true);
    expect(out.every((r) => r.agentType === 'openclaw')).toBe(true);
  });

  it('names the tool and what it was asked to do', () => {
    expect(rows()[0].raw).toBe('exec · ls ~/github/OpenClaw && rg -n "8899" ~/github/OpenClaw --max-count=3 -l | head -50');
  });

  it('stamps the row at the CALL, not at the result', () => {
    // The call is when the work started, and it is what orders correctly
    // against the live Gateway rows. Stamping at the result would also lose any
    // call still outstanding when the read happened.
    expect(rows()[0].ts).toBe(Date.parse('2026-08-22T23:52:23.315Z'));
  });

  it('completes the row from its matching result, keyed by toolCallId', () => {
    const detail = rows()[0].detail!;
    expect(detail).toContain('ok · exit 0 · 13ms');
    expect(detail).toContain('CAPTURE_GUIDE.md');
    expect(rows()[0].status).toBeUndefined();
  });

  it('puts the outcome and the model ahead of unbounded tool output', () => {
    // An eval session exists to vary which weights ran; output is unbounded and
    // would push that past the clip.
    const lines = rows()[0].detail!.split('\n');
    expect(lines[0]).toContain('ok');
    expect(lines[1]).toBe('model: openrouter/stealth/ox-alpha');
  });

  it('marks a failure reported by isError alone — there is no exit code', () => {
    // Real shape: a non-exec tool fails with details.status "error", isError
    // true, and NO exitCode. Trusting exitCode alone reads this as success.
    const failed = rows()[1];
    expect(failed.raw).toContain('message');
    expect(failed.status).toBe('denied');
    expect(failed.detail).toContain('failed');
  });

  it('keeps a call that never got a result — that is the abandoned approval', () => {
    // This is the exact call whose approval closed unanswered on 2026-08-23.
    // The attempt is real and must be visible; the outcome is genuinely unknown
    // and must not be invented.
    const orphan = rows()[2];
    expect(orphan.raw).toContain("sed -n '90,135p'");
    expect(orphan.status).toBeUndefined();
    expect(orphan.detail).toBe('model: openrouter/stealth/ox-alpha');
  });

  it('honors since/limit so a poller only sees new work', () => {
    const since = Date.parse('2026-08-22T23:52:23.315Z');
    const after = openClawTimelineForSession(SID, { stateDir: root, since });
    expect(after).toHaveLength(2);
    expect(openClawTimelineForSession(SID, { stateDir: root, limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for a session that is not in the store', () => {
    expect(openClawTimelineForSession('does-not-exist', { stateDir: root })).toEqual([]);
  });
});

describe('summarizeToolArguments', () => {
  it('prefers the command for exec — the whole story of the call', () => {
    expect(summarizeToolArguments({ command: 'ls -la' })).toBe('ls -la');
  });

  it('degrades to something TRUE for a tool this build has never seen', () => {
    // An unknown tool must not render as nothing; naming its arguments is a
    // weaker claim than inventing a summary, and weaker is correct here.
    expect(summarizeToolArguments({ selector: '#go', waitMs: 200 })).toBe('#go');
    expect(summarizeToolArguments({ waitMs: 200, retries: 3 })).toBe('waitMs, retries');
    expect(summarizeToolArguments(undefined)).toBe('');
  });
});
