import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';

/**
 * Archiving contract for a hook-observed turn: whatever the timeline shows as
 * `chat_response`, APME must hold as BOTH `turns.response` and an
 * `assistant_message` trajectory event.
 *
 * This went unenforced and silently regressed. `setTurnResponse` was reachable
 * only from the PTY session bridge, so direct `claude` / `codex` / standalone
 * `opencode` sessions — which reach the daemon through hooks — archived a
 * prompt and a full tool trajectory with no reply at all: 1589 claude-code
 * turns held 219 responses, none newer than 2026-07-11, and only 15
 * `assistant_message` events existed store-wide (12 of them OpenClaw's).
 * The dashboard could not replay a conversation the timeline showed in full,
 * and the judge scored those turns against silence.
 */

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-resp-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  const ok = await store.init();
  if (!ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('APME store failed to initialize — is better-sqlite3 installed?');
  }
  (store as unknown as { _tmpDir: string })._tmpDir = dir;
  return store;
}

function cleanup(store: ApmeStore) {
  store.close();
  const dir = (store as unknown as { _tmpDir?: string })._tmpDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

const SID = 'observed-session';

/** The daemon's observed-hook sequence for one turn, minus the response. */
function driveTurn(collector: ApmeCollector, prompt: string) {
  collector.ingestHook(SID, 'user_prompt_submit', { message: { content: prompt } });
  collector.ingestHook(SID, 'tool_start', { tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
  collector.ingestHook(SID, 'tool_end', { tool_name: 'Read', tool_response: 'contents' });
}

function kindsFor(store: ApmeStore, taskId: string): string[] {
  return (store.getSample(taskId)?.events ?? []).map((e) => e.kind);
}

describe('observed turn response archiving', () => {
  let store!: ApmeStore;
  let collector!: ApmeCollector;
  beforeEach(async () => {
    store = await makeStore();
    collector = new ApmeCollector(store);
    collector.openRun({ sessionId: SID, agentType: 'claude-code', projectName: 'AgentDeck' });
  });
  afterEach(() => { cleanup(store); });

  it('archives the reply on the turn and as an assistant_message event', () => {
    driveTurn(collector, '커밋하고 푸시하자.');
    const taskId = collector.getActiveTaskId(SID)!;
    expect(kindsFor(store, taskId)).toEqual(['user_message', 'tool']);

    collector.setTurnResponse(SID, '커밋·푸시 완료했습니다. PR #132.');

    const turn = store.listTurns(collector.getRunId(SID)!)[0];
    expect(turn.response).toBe('커밋·푸시 완료했습니다. PR #132.');
    const events = store.getSample(taskId)!.events;
    expect(events.map((e) => e.kind)).toEqual(['user_message', 'tool', 'assistant_message']);
    const assistant = events.find((e) => e.kind === 'assistant_message')!;
    expect(assistant).toMatchObject({ responseKind: 'text', text: '커밋·푸시 완료했습니다. PR #132.' });
  });

  it('tags a tool-only turn so the judge skips it instead of scoring silence', () => {
    driveTurn(collector, 'run the build');
    collector.setTurnResponse(SID, '');

    const turn = store.listTurns(collector.getRunId(SID)!)[0];
    expect(JSON.parse(String(turn.efficiency_json)).response_kind).toBe('tool_only');
  });

  it('keeps each turn\'s reply on its own turn across a multi-turn task', () => {
    driveTurn(collector, 'first');
    collector.setTurnResponse(SID, 'first answer');
    driveTurn(collector, 'second');
    collector.setTurnResponse(SID, 'second answer');

    const turns = store.listTurns(collector.getRunId(SID)!);
    expect(turns.map((t) => [t.prompt, t.response])).toEqual([
      ['first', 'first answer'],
      ['second', 'second answer'],
    ]);
    // One user/tool/assistant arc per turn — the reply must not be duplicated
    // onto the task by landing twice or re-attributing to the newest turn.
    expect(kindsFor(store, collector.getActiveTaskId(SID)!)).toEqual([
      'user_message', 'tool', 'assistant_message',
      'user_message', 'tool', 'assistant_message',
    ]);
  });

  it('lands a late reply on the last closed turn without overwriting one', () => {
    driveTurn(collector, 'only turn');
    collector.setTurnResponse(SID, 'real answer');
    collector.closeTurnForSession(SID);

    // A duplicate/late Stop for the same turn must not clobber the record.
    collector.setLastClosedTurnResponse(SID, 'stale duplicate');
    const turns = store.listTurns(collector.getRunId(SID)!);
    expect(turns[0].response).toBe('real answer');
  });
});
