import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CODEX_OTEL_METADATA_RULES } from '@agentdeck/shared';
import { locateCodexRollout, codexRolloutIsSubagent, lastAgentMessageFromCodexRollout, codexTurnOutcomeFromRollout, codexTurnCompletionSince, codexTurnOutcomeFromRolloutPath } from '../codex-rollout-response.js';

/**
 * Observed Codex response capture: codex_stop's payload rarely carries the
 * assistant text, so the daemon reads it from the rollout JSONL tail —
 * `task_complete.last_agent_message` first, else the final `agent_message`.
 * Fixtures mirror real record shapes from ~/.codex/sessions rollouts.
 */
describe('codex rollout response reader', () => {
  const SID = '019ea4a1-ae61-78f1-b420-348c1695f3d7';
  let root: string;

  const dayDir = () => {
    const dir = join(root, '2026', '07', '05');
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const writeRollout = (lines: unknown[], sid = SID) => {
    const path = join(dayDir(), `rollout-2026-07-05T10-00-00-${sid}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('classifies the sanitized actual desktop thread_spawn metadata from a bounded head', async () => {
    writeRollout([{ type: 'session_meta', payload: { id: SID, originator: 'Codex Desktop', cwd: '/sample/workspace',
      source: { subagent: { thread_spawn: { parent_thread_id: 'sample-parent' } } },
      thread_source: 'subagent', parent_thread_id: 'sample-parent', base_instructions: 'x'.repeat(23000) } }]);
    expect(await codexRolloutIsSubagent(SID, root)).toBe(true);
    writeRollout([{ type: 'session_meta', payload: { id: SID, thread_source: 'subagent', parent_thread_id: 'sample-parent' } }]);
    expect(await codexRolloutIsSubagent(SID, root)).toBe(true);
    writeRollout([{ type: 'session_meta', payload: { id: SID, source: 'exec', parent_thread_id: 'sample-parent' } }]);
    expect(await codexRolloutIsSubagent(SID, root)).toBe(false); // Standalone codex exec remains a session.
  });

  it('keeps missing malformed or oversized head evidence unknown', async () => {
    expect(await codexRolloutIsSubagent(SID, root)).toBeUndefined();
    for (const payload of [[], {}, { id: 'other-id', source: { subagent: 'review' } }, { id: SID }, { id: SID, thread_source: 'subagent' }]) {
      writeRollout([{ type: 'session_meta', payload }]);
      expect(await codexRolloutIsSubagent(SID, root)).toBeUndefined();
    }
    writeRollout([{ type: 'session_meta', payload: { id: SID, source: { subagent: 'review' },
      base_instructions: 'x'.repeat(CODEX_OTEL_METADATA_RULES.headBytes) } }]);
    expect(await codexRolloutIsSubagent(SID, root)).toBeUndefined();
  });

  it('locates a rollout by the session uuid embedded in the filename', () => {
    const path = writeRollout([{ type: 'session_meta', payload: { id: SID } }]);
    expect(locateCodexRollout(SID, root)).toBe(path);
    expect(locateCodexRollout('deadbeef-0000-0000-0000-000000000000', root)).toBeNull();
  });

  it('prefers task_complete.last_agent_message (authoritative turn close)', () => {
    writeRollout([
      { type: 'event_msg', payload: { type: 'agent_message', message: 'mid-turn commentary', phase: 'commentary' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'final reply body' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'authoritative reply' } },
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    ]);
    expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('authoritative reply');
  });

  it('reads the same outcome from a path the hook already carried', () => {
    const path = writeRollout([
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'from path' } },
    ]);
    expect(codexTurnOutcomeFromRolloutPath(path).text).toBe('from path');
    expect(codexTurnOutcomeFromRolloutPath(join(root, 'missing.jsonl')).text).toBe('');
  });

  it('falls back to the newest agent_message when no task_complete follows', () => {
    writeRollout([
      { type: 'event_msg', payload: { type: 'agent_message', message: 'older message' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'newest message' } },
    ]);
    expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('newest message');
  });

  it('returns empty for missing rollouts, malformed lines, and bad ids', () => {
    expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('');
    writeFileSync(join(dayDir(), `rollout-2026-07-05T10-00-00-${SID}.jsonl`), 'not json\n{"half":', 'utf-8');
    expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('');
    expect(lastAgentMessageFromCodexRollout('', root)).toBe('');
    expect(lastAgentMessageFromCodexRollout('../../etc/passwd', root)).toBe('');
  });

  /**
   * A failed turn is the case Codex never reports through a hook: it does not
   * run `Stop`, so this file is the only place the failure is observable. It
   * used to be skipped entirely, which is what left the turn spinning with its
   * cause sitting unread on disk.
   */
  describe('failed turns', () => {
    it('reports the error a task_complete carries instead of a reply', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
        { type: 'event_msg', payload: {
          type: 'task_complete',
          last_agent_message: null,
          error: { message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' },
        } },
      ]);
      const out = codexTurnOutcomeFromRollout(SID, root);
      expect(out.text).toBe('');
      expect(out.error).toBe("You've hit your usage limit.");
      expect(out.errorKind).toBe('usage_limit_exceeded');
    });

    it('reports a standalone error record', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'error', message: 'stream disconnected', codex_error_info: 'other' } },
      ]);
      expect(codexTurnOutcomeFromRollout(SID, root).error).toBe('stream disconnected');
    });

    it('unwraps the upstream JSON body Codex nests in the message', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: {
          type: 'error',
          message: JSON.stringify({ type: 'error', status: 400, message: "The 'gpt-5.6-sol' model is not supported." }),
        } },
      ]);
      expect(codexTurnOutcomeFromRollout(SID, root).error)
        .toBe("The 'gpt-5.6-sol' model is not supported.");
    });

    /**
     * The scan must stop at the turn's own opening record. Without that, a
     * failed turn — which contributes no agent_message — walked into the
     * PREVIOUS turn and returned its reply as this one's.
     */
    it('never inherits the previous turn\'s reply', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'an answer from the turn before' } },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'an answer from the turn before' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null,
          error: { message: 'quota exhausted' } } },
      ]);
      const out = codexTurnOutcomeFromRollout(SID, root);
      expect(out.text).toBe('');
      expect(out.error).toBe('quota exhausted');
    });

    it('still returns a successful reply unchanged', () => {
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } },
      ]);
      expect(codexTurnOutcomeFromRollout(SID, root).text).toBe('done');
      expect(lastAgentMessageFromCodexRollout(SID, root)).toBe('done');
    });
  });

  /**
   * Startup recovery for a turn left open across a daemon restart: the
   * rollout, written by Codex itself, says whether that turn finished. The
   * scan is bounded by the turn's own start so an OLDER turn's completion can
   * never be returned for it (real rollouts carry an ISO `timestamp` per
   * record).
   */
  describe('codexTurnCompletionSince', () => {
    const T0 = Date.parse('2026-08-30T01:18:51.514Z');

    it('returns the task_complete newer than the turn, with its reply', () => {
      writeRollout([
        { timestamp: '2026-08-29T20:10:43.358Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'previous turn' } },
        { timestamp: '2026-08-30T01:18:51.514Z', type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: '2026-08-30T01:20:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'working' } },
        { timestamp: '2026-08-30T01:31:37.203Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '처리 결과는 다음과 같습니다.' } },
      ]);
      expect(codexTurnCompletionSince(SID, T0, root)).toEqual({
        completedAt: Date.parse('2026-08-30T01:31:37.203Z'),
        text: '처리 결과는 다음과 같습니다.',
      });
    });

    it('carries the failure Codex wrote on the completion — such a turn fires no Stop', () => {
      // Real shape (2026-09-03): six consecutive turns against a dead endpoint,
      // each `task_complete` with `last_agent_message: null` and an `error`.
      writeRollout([
        { timestamp: '2026-09-03T14:57:37.116Z', type: 'response_item', payload: { type: 'message', role: 'user' } },
        { timestamp: '2026-09-03T14:57:51.181Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null, error: { message: 'unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses', codex_error_info: 'other' } } },
      ]);
      expect(codexTurnCompletionSince(SID, Date.parse('2026-09-03T14:57:37.000Z'), root)).toEqual({
        completedAt: Date.parse('2026-09-03T14:57:51.181Z'),
        text: '',
        error: 'unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses',
        errorKind: 'other',
      });
    });

    it('never attributes an older turn\'s completion to this one', () => {
      writeRollout([
        { timestamp: '2026-08-29T20:10:43.358Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'previous turn' } },
        { timestamp: '2026-08-30T01:18:51.514Z', type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: '2026-08-30T01:20:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'still going' } },
      ]);
      expect(codexTurnCompletionSince(SID, T0, root)).toBeNull();
    });

    it('a later turn opening after the completion does not hide it', () => {
      writeRollout([
        { timestamp: '2026-08-30T01:18:51.514Z', type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: '2026-08-30T01:31:37.203Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } },
        { timestamp: '2026-08-30T01:31:37.308Z', type: 'event_msg', payload: { type: 'task_started' } },
      ]);
      expect(codexTurnCompletionSince(SID, T0, root)?.text).toBe('done');
    });

    it('records without a timestamp cannot be placed, and a missing rollout is no evidence', () => {
      expect(codexTurnCompletionSince(SID, T0, root)).toBeNull();
      writeRollout([
        { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'undated' } },
      ]);
      expect(codexTurnCompletionSince(SID, T0, root)).toBeNull();
    });
  });
});
