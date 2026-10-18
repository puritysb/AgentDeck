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

  it.each(['projection-first', 'final-first'] as const)(
    'keeps the full OpenClaw final in one assistant slot (%s)',
    (order) => {
      driveTurn(collector, `long response ${order}`);
      const full = `${'full-response-block '.repeat(550)}AUTHORITATIVE-TAIL`;
      const projection = full.slice(0, 8_000);
      if (order === 'projection-first') {
        collector.setTurnResponse(SID, projection, 'session_message_projection');
        collector.setTurnResponse(SID, full, 'chat_final');
      } else {
        collector.setTurnResponse(SID, full, 'chat_final');
        collector.setTurnResponse(SID, projection, 'session_message_projection');
      }

      const turn = store.listTurns(collector.getRunId(SID)!)[0];
      expect(turn.response).toBe(full.slice(0, 10_000));
      expect(JSON.parse(String(turn.efficiency_json)).response_source).toBe('chat_final');
      const assistants = store.getSample(collector.getActiveTaskId(SID)!)!.events
        .filter((event) => event.kind === 'assistant_message');
      expect(assistants).toHaveLength(1);
      expect(assistants[0]).toMatchObject({ text: full.slice(0, 10_000) });
    },
  );

  it('retains a session-message projection when no chat final is observable', () => {
    driveTurn(collector, 'hidden run');
    collector.setTurnResponse(SID, 'projection-only answer', 'session_message_projection');
    const turn = store.listTurns(collector.getRunId(SID)!)[0];
    expect(turn.response).toBe('projection-only answer');
    expect(JSON.parse(String(turn.efficiency_json)).response_source)
      .toBe('session_message_projection');
  });
});

/**
 * Which turn a Stop's reply belongs to is the collector's question.
 *
 * The daemon used to answer it with its TIMELINE: a `chat_start` among the
 * session's last 24 rows with no completion after it. The timeline drops a
 * `<task-notification>` prompt, and a long turn's own tool rows push its
 * prompt out of those 24 — so both turns read as closed and their reply went
 * to the PREVIOUS turn: dropped when that turn had one, a turn early when it
 * did not. Over 30 days (2026-10-18) 558 of 1,145 Claude Stop turns took that
 * path and 247 kept no reply, against none of the 587 that reached their
 * open turn.
 */
describe('Stop reply attribution (recordStopReply)', () => {
  let store!: ApmeStore;
  let collector!: ApmeCollector;
  beforeEach(async () => {
    store = await makeStore();
    collector = new ApmeCollector(store);
    collector.openRun({ sessionId: SID, agentType: 'claude-code', projectName: 'AgentDeck' });
  });
  afterEach(() => { cleanup(store); });

  /** One Stop as the daemon delivers it: the reply, then the close. */
  function stop(reply: string) {
    collector.recordStopReply(SID, reply);
    collector.noteTurnStop(SID);
  }

  it('lands each reply on the turn its Stop closes, whatever opened that turn', () => {
    driveTurn(collector, 'fix the build');
    stop('build fixed');
    // Delivered to an idle session: a fresh turn the timeline cannot see.
    driveTurn(collector, '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>');
    stop('the background test run passed');

    const turns = store.listTurns(collector.getRunId(SID)!);
    expect(turns.map((t) => t.response)).toEqual(['build fixed', 'the background test run passed']);
  });

  it('never lands a reply a turn early when the previous turn kept none', () => {
    // The off-by-one chain: a replyless turn used to absorb the NEXT turn's
    // reply, and that turn then absorbed the one after it.
    driveTurn(collector, 'run the migration');
    stop('');
    driveTurn(collector, '<task-notification>done</task-notification>');
    stop('migration finished cleanly');

    const turns = store.listTurns(collector.getRunId(SID)!);
    expect(turns.map((t) => t.response)).toEqual(['', 'migration finished cleanly']);
    expect(JSON.parse(String(turns[0].efficiency_json)).response_kind).toBe('tool_only');
  });

  it('with no open turn, fills the last closed turn once and never clobbers it', () => {
    driveTurn(collector, 'only turn');
    collector.noteTurnStop(SID);
    collector.recordStopReply(SID, 'recovered late');
    collector.recordStopReply(SID, 'duplicate Stop');
    collector.recordStopReply(SID, '');

    expect(store.listTurns(collector.getRunId(SID)!)[0].response).toBe('recovered late');
  });

  it('fills the empty slot an early Stop wrote when the deferred re-read finds the reply', () => {
    // The Stop's transcript read came back empty (Claude had not written the
    // record yet), so the open turn got '' and closed; the daemon's deferred
    // re-read then applies the reply to the last closed turn.
    driveTurn(collector, 'run the full suite');
    stop('');
    collector.setLastClosedTurnResponse(SID, 'all 412 tests passed');

    const turn = store.listTurns(collector.getRunId(SID)!)[0];
    expect(turn.response).toBe('all 412 tests passed');
    const assistants = store.listSampleEventRows(String(turn.task_id))
      .filter((e) => e.kind === 'assistant_message' && e.turnId === turn.id);
    expect(assistants).toHaveLength(1);
    expect(JSON.parse(String(assistants[0].payload)))
      .toMatchObject({ text: 'all 412 tests passed', responseKind: 'text' });
  });
});
