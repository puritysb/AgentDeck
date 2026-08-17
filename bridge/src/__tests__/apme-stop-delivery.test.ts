/**
 * Stop-delivery attribution (`turns.end_source`) — the standing instrument for
 * Claude Stop-hook loss.
 *
 * The Stop hook is the sole authority that closes a Claude turn and its
 * delivery is fire-and-forget, so the failure mode is invisible by
 * construction: a turn whose Stop dropped looks exactly like a turn that
 * closed normally, one prompt later. These tests pin the three signals apart
 * — real Stop, watchdog-recovered Stop, and no Stop at all — plus the
 * denominator rule that keeps the resulting rate honest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-stop-'));
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

function prompt(collector: ApmeCollector, sessionId: string, text: string) {
  collector.ingestHook(sessionId, 'UserPromptSubmit', { message: { content: text } });
}

function turnsOf(store: ApmeStore, runId: string) {
  return store.listTurns(runId) as Array<Record<string, unknown>>;
}

describe('turns.end_source', () => {
  let store!: ApmeStore;
  let collector!: ApmeCollector;
  const SID = 'sess-stop';

  beforeEach(async () => {
    store = await makeStore();
    collector = new ApmeCollector(store);
  });
  afterEach(() => { cleanup(store); });

  function openRun(): string {
    const runId = collector.openRun({ sessionId: SID, agentType: 'claude-code', projectName: 'demo' });
    expect(runId).toBeTruthy();
    return runId as string;
  }

  it('a real Stop closes the turn and tags it `stop`', () => {
    const runId = openRun();
    prompt(collector, SID, 'first');
    collector.noteTurnStop(SID);

    const [t] = turnsOf(store, runId);
    expect(t.end_source).toBe('stop');
    expect(t.ended_at).toBeTypeOf('number');
  });

  it('a watchdog-injected Stop is tagged `synthetic_stop`, not `stop`', () => {
    const runId = openRun();
    prompt(collector, SID, 'first');
    collector.noteTurnStop(SID, { synthetic: true });

    const [t] = turnsOf(store, runId);
    expect(t.end_source).toBe('synthetic_stop');
  });

  it('a turn still open when the next prompt arrives is tagged `next_prompt`', () => {
    // This is the unrecovered-loss bucket: no Stop, and no watchdog either.
    const runId = openRun();
    prompt(collector, SID, 'first');
    prompt(collector, SID, 'second');

    const rows = turnsOf(store, runId);
    expect(rows).toHaveLength(2);
    expect(rows[0].end_source).toBe('next_prompt');
    expect(rows[1].end_source).toBeNull(); // still open
    expect(rows[1].ended_at).toBeNull();
  });

  it('a duplicate/late Stop cannot re-attribute an already-closed turn', () => {
    // A synthetic Stop racing a real one must not overwrite the real
    // attribution — otherwise the watchdog would inflate its own fire rate.
    const runId = openRun();
    prompt(collector, SID, 'first');
    collector.noteTurnStop(SID);
    collector.noteTurnStop(SID, { synthetic: true });

    const [t] = turnsOf(store, runId);
    expect(t.end_source).toBe('stop');
  });

  it('`ended_at` is stamped at the Stop, not at the following prompt', () => {
    // Before this, a turn's duration silently included however long the user
    // took to type next — an overnight gap read as a 9-hour turn.
    const runId = openRun();
    prompt(collector, SID, 'first');
    collector.noteTurnStop(SID);
    const closedAt = turnsOf(store, runId)[0].ended_at as number;

    prompt(collector, SID, 'second');
    expect(turnsOf(store, runId)[0].ended_at).toBe(closedAt);
  });

  it('closing the run tags the open turn `session_end`, `/clear` tags it `clear`', () => {
    const runId = openRun();
    prompt(collector, SID, 'abandoned mid-turn');
    collector.closeRun(SID);
    expect(turnsOf(store, runId)[0].end_source).toBe('session_end');

    const runId2 = collector.openRun({ sessionId: SID, agentType: 'claude-code' }) as string;
    prompt(collector, SID, 'cleared mid-turn');
    collector.splitRun(SID);
    expect(turnsOf(store, runId2)[0].end_source).toBe('clear');
  });

  it('a cancel is tagged `interrupted`, even though it arrives as a synthetic Stop', () => {
    // ESC always reaches the collector through the watchdog's synthetic Stop
    // (there is no real one to deliver), so reading `synthetic` first would
    // file every user cancel as a dropped hook.
    const runId = openRun();
    prompt(collector, SID, 'first');
    collector.noteTurnStop(SID, { synthetic: true, interrupted: true });

    expect(turnsOf(store, runId)[0].end_source).toBe('interrupted');
  });

  it('a client abort is tagged `aborted`, even though it arrives as a synthetic Stop', () => {
    // Usage limit / expired auth / API error: Claude Code writes the message
    // and fires no Stop, so the abort can only ever reach the collector as a
    // synthetic one — reading `synthetic` first would file an exhausted usage
    // window as dropped infrastructure.
    const runId = openRun();
    prompt(collector, SID, 'first');
    collector.noteTurnStop(SID, { synthetic: true, aborted: true });

    expect(turnsOf(store, runId)[0].end_source).toBe('aborted');
  });

  it('a cancel outranks an abort when both flags somehow arrive', () => {
    const runId = openRun();
    prompt(collector, SID, 'first');
    collector.noteTurnStop(SID, { synthetic: true, interrupted: true, aborted: true });

    expect(turnsOf(store, runId)[0].end_source).toBe('interrupted');
  });

  it('a displaced turn whose transcript shows a cancel is `interrupted`, not `next_prompt`', () => {
    // Cancel-then-retype buries the marker under the new prompt within
    // seconds, so the watchdog never sees it as the tail. Left unattributed,
    // the commonest ESC shape would inflate the unrecovered-loss bucket.
    const seen: Array<{ path: string; since: number }> = [];
    const c = new ApmeCollector(store, undefined, (path, since) => {
      seen.push({ path, since });
      return { interruptedAt: since + 1_000, abortedAt: null, sawAssistant: true };
    });
    const runId = c.openRun({ sessionId: SID, agentType: 'claude-code' }) as string;
    c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'first' }, transcript_path: '/t.jsonl' });
    c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'second' }, transcript_path: '/t.jsonl' });

    expect(turnsOf(store, runId)[0].end_source).toBe('interrupted');
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/t.jsonl');
  });

  it('a displaced turn whose transcript shows a client abort is `aborted`', () => {
    // The watchdog closes these at +15s, but not when it was swept for
    // idleness first or the daemon restarted mid-turn — and an aborted turn is
    // exactly the shape that then sits open until the next morning's prompt.
    const c = new ApmeCollector(store, undefined, (_p, since) =>
      ({ interruptedAt: null, abortedAt: since + 2_000, sawAssistant: true }));
    const runId = c.openRun({ sessionId: SID, agentType: 'claude-code' }) as string;
    c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'first' }, transcript_path: '/t.jsonl' });
    c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'second' }, transcript_path: '/t.jsonl' });

    expect(turnsOf(store, runId)[0].end_source).toBe('aborted');
  });

  it('a displaced turn the assistant never answered is `superseded`, not a lost Stop', () => {
    // Two prompts ~130ms apart (queued messages, <task-notification> pairs):
    // one model turn serves both and owes exactly one Stop, which closes the
    // last of them. The first row never ran, so nothing was lost for it.
    const c = new ApmeCollector(store, undefined, () =>
      ({ interruptedAt: null, abortedAt: null, sawAssistant: false }));
    const runId = c.openRun({ sessionId: SID, agentType: 'claude-code' }) as string;
    c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'first' }, transcript_path: '/t.jsonl' });
    c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'second' }, transcript_path: '/t.jsonl' });

    expect(turnsOf(store, runId)[0].end_source).toBe('superseded');
  });

  it('no evidence in the window still means `next_prompt` — absence is never a verdict', () => {
    const c = new ApmeCollector(store, undefined, () =>
      ({ interruptedAt: null, abortedAt: null, sawAssistant: true }));
    const runId = c.openRun({ sessionId: SID, agentType: 'claude-code' }) as string;
    c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'first' }, transcript_path: '/t.jsonl' });
    c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'second' }, transcript_path: '/t.jsonl' });

    expect(turnsOf(store, runId)[0].end_source).toBe('next_prompt');
  });

  it('never reads a transcript for a non-Claude agent or a pathless hook', () => {
    // The marker and the JSONL shape are Claude Code's; a Codex turn has
    // neither, and probing one would be a wasted read at best.
    let probed = 0;
    const c = new ApmeCollector(store, undefined, () => {
      probed++;
      return { interruptedAt: Date.now(), abortedAt: null, sawAssistant: true };
    });
    c.openRun({ sessionId: 'codex-sess', agentType: 'codex-cli' });
    c.ingestHook('codex-sess', 'UserPromptSubmit', { message: { content: 'a' }, transcript_path: '/t.jsonl' });
    c.ingestHook('codex-sess', 'UserPromptSubmit', { message: { content: 'b' }, transcript_path: '/t.jsonl' });

    const runId = c.openRun({ sessionId: 'claude-sess', agentType: 'claude-code' }) as string;
    c.ingestHook('claude-sess', 'UserPromptSubmit', { message: { content: 'a' } });
    c.ingestHook('claude-sess', 'UserPromptSubmit', { message: { content: 'b' } });

    expect(probed).toBe(0);
    expect(turnsOf(store, runId)[0].end_source).toBe('next_prompt');
  });

  it('an unreadable transcript falls back to `next_prompt` rather than guessing', () => {
    // Both shapes of "cannot read": a throw, and the probe's own null. Neither
    // may become `superseded` — "no assistant record" and "no transcript" are
    // different facts and only the first one is evidence.
    for (const probe of [
      () => { throw new Error('EACCES'); },
      () => null,
    ]) {
      const c = new ApmeCollector(store, undefined, probe as never);
      const runId = c.openRun({ sessionId: SID, agentType: 'claude-code' }) as string;
      c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'first' }, transcript_path: '/t.jsonl' });
      c.ingestHook(SID, 'UserPromptSubmit', { message: { content: 'second' }, transcript_path: '/t.jsonl' });

      expect(turnsOf(store, runId)[0].end_source).toBe('next_prompt');
    }
  });

  it('the response still lands on the turn when the Stop closes it first', () => {
    // Ordering contract: callers record the response before noteTurnStop, but
    // the daemon's observed path can reach setTurnResponse after — the
    // last-closed fallback has to keep working or every observed turn would
    // archive a prompt with no reply.
    const runId = openRun();
    prompt(collector, SID, 'first');
    collector.noteTurnStop(SID);
    collector.setTurnResponse(SID, 'the answer');

    const [t] = turnsOf(store, runId);
    expect(t.response).toBe('the answer');
    expect(t.end_source).toBe('stop');
  });
});

describe('ApmeStore.stopDelivery', () => {
  let store!: ApmeStore;
  let collector!: ApmeCollector;

  beforeEach(async () => {
    store = await makeStore();
    collector = new ApmeCollector(store);
  });
  afterEach(() => { cleanup(store); });

  it('buckets each closing signal and keeps open turns in the denominator', () => {
    const sid = 'sess-a';
    collector.openRun({ sessionId: sid, agentType: 'claude-code' });
    prompt(collector, sid, 'p1'); collector.noteTurnStop(sid);                    // stop
    prompt(collector, sid, 'p2'); collector.noteTurnStop(sid, { synthetic: true }); // synthetic
    prompt(collector, sid, 'p3'); prompt(collector, sid, 'p4');                   // p3 → next_prompt
    // p4 is left open.

    const [row] = store.stopDelivery({ sinceMs: 0 });
    expect(row.agentType).toBe('claude-code');
    expect(row.total).toBe(4);
    expect(row.stop).toBe(1);
    expect(row.syntheticStop).toBe(1);
    expect(row.nextPrompt).toBe(1);
    expect(row.interrupted).toBe(0);
    expect(row.open).toBe(1);
    expect(row.preInstrument).toBe(0);
  });

  it('counts cancels in their own column, outside every loss bucket', () => {
    // The whole point of the column: a user's ESC key must not be reported as
    // infrastructure loss. It is not `stop` either — no Stop hook ever ran.
    const sid = 'sess-esc';
    collector.openRun({ sessionId: sid, agentType: 'claude-code' });
    prompt(collector, sid, 'p1'); collector.noteTurnStop(sid);
    prompt(collector, sid, 'p2'); collector.noteTurnStop(sid, { synthetic: true, interrupted: true });

    const [row] = store.stopDelivery({ sinceMs: 0 });
    expect(row.interrupted).toBe(1);
    expect(row.syntheticStop).toBe(0);
    expect(row.nextPrompt).toBe(0);
    expect(row.stop).toBe(1);
    // The rate the CLI prints: adjudicated turns only, cancels excluded.
    expect(row.stop + row.syntheticStop + row.nextPrompt).toBe(1);
  });

  it('reports pre-instrument rows separately instead of guessing a bucket', () => {
    const sid = 'sess-b';
    const runId = collector.openRun({ sessionId: sid, agentType: 'claude-code' }) as string;
    prompt(collector, sid, 'p1'); collector.noteTurnStop(sid);
    // Simulate a row written before the column existed.
    const turnId = store.listTurns(runId)[0].id as string;
    store.updateTurn(turnId, { endSource: null });

    const [row] = store.stopDelivery({ sinceMs: 0 });
    expect(row.stop).toBe(0);
    expect(row.preInstrument).toBe(1);
  });

  it('windows on started_at and can filter to one agent', () => {
    collector.openRun({ sessionId: 'c-claude', agentType: 'claude-code' });
    prompt(collector, 'c-claude', 'p'); collector.noteTurnStop('c-claude');
    collector.openRun({ sessionId: 'c-codex', agentType: 'codex-cli' });
    prompt(collector, 'c-codex', 'p'); collector.noteTurnStop('c-codex');

    expect(store.stopDelivery({ sinceMs: 0 })).toHaveLength(2);
    const claudeOnly = store.stopDelivery({ sinceMs: 0, agentType: 'claude-code' });
    expect(claudeOnly).toHaveLength(1);
    expect(claudeOnly[0].agentType).toBe('claude-code');
    // A window that starts in the future excludes everything.
    expect(store.stopDelivery({ sinceMs: Date.now() + 60_000 })).toHaveLength(0);
  });
});
