import { describe, expect, it } from 'vitest';
import {
  CodexRolloutCache,
  collectCodexSessionsFromRollouts,
  dedupeObservedSessions,
  isAntigravityProcessCommand,
  isCodexSessionProcessCommand,
  parseClaudeTranscript,
  parseCodexRollout,
  parseLsofRollouts,
  parseProcessTable,
} from '../passive-observer.js';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('passive-observer parsers', () => {
  it('parses ps output without depending on fixed command columns', () => {
    // ps columns: pid ppid rss tty command (tty added for observed-answer injection)
    const rows = parseProcessTable([
      ' 123 1 20480 ttys004 /opt/homebrew/bin/codex --model gpt-5.4',
      ' 456 123 1024 ?? /bin/zsh -lc claude',
      'not a process row',
    ].join('\n'));

    expect(rows).toEqual([
      {
        pid: 123,
        ppid: 1,
        rssKb: 20480,
        tty: 'ttys004',
        command: '/opt/homebrew/bin/codex --model gpt-5.4',
      },
      {
        pid: 456,
        ppid: 123,
        rssKb: 1024,
        tty: undefined,
        command: '/bin/zsh -lc claude',
      },
    ]);
  });

  it('summarizes Claude transcripts and redacts tool secrets', () => {
    const summary = parseClaudeTranscript(jsonl([
      {
        type: 'user',
        timestamp: '2026-04-26T01:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-26T01:00:01.000Z',
        message: {
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 100_000,
            output_tokens: 1_000,
            cache_read_input_tokens: 50_000,
            cache_creation_input_tokens: 250,
          },
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'curl -H "Authorization: Bearer token-123" https://example.test' },
            },
          ],
        },
      },
    ]));

    expect(summary.modelName).toBe('claude-sonnet-4-5');
    expect(summary.state).toBe('processing');
    expect(summary.totalTokens).toBe(151_250);
    expect(Math.round(summary.contextPercent ?? 0)).toBe(75);
    expect(summary.currentTask).toContain('[REDACTED]');
    expect(summary.currentTask).not.toContain('token-123');
  });

  it('reads idle after an ESC/interrupt marker aborts a pending tool_use', () => {
    // A permission prompt on a pending tool_use, then the user presses ESC.
    // The interrupt fires NO lifecycle hook — the `[Request interrupted…]`
    // record is the only trace — and it must read as idle (turn aborted),
    // not as a fresh 'processing' user turn.
    const summary = parseClaudeTranscript(jsonl([
      {
        type: 'user',
        timestamp: '2026-04-26T01:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'run the build' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-26T01:00:01.000Z',
        message: {
          model: 'claude-sonnet-4-5',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }],
        },
      },
      {
        type: 'user',
        timestamp: '2026-04-26T01:00:05.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
      },
    ]));
    expect(summary.state).toBe('idle');
    // The session goal is still the real first prompt, not the interrupt marker.
    expect(summary.goal).toBe('run the build');
  });

  it('summarizes Codex rollout metadata, context, and pending tool calls', () => {
    const summary = parseCodexRollout(jsonl([
      {
        type: 'session_meta',
        payload: {
          id: 'codex-session-1',
          cwd: '/Users/example/github/AgentDeck',
          timestamp: '2026-04-26T01:00:00.000Z',
        },
      },
      {
        type: 'turn_context',
        payload: { model: 'gpt-5.4', effort: 'high', model_context_window: 200_000 },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 200_000,
            total_token_usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 300 },
            last_token_usage: { input_tokens: 20_000, cached_input_tokens: 10_000 },
          },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'pnpm typecheck' }),
        },
      },
    ]));

    expect(summary).toEqual(expect.objectContaining({
      sessionId: 'codex-session-1',
      cwd: '/Users/example/github/AgentDeck',
      modelName: 'gpt-5.4 high',
      effort: 'high',
      state: 'processing',
      currentTask: 'exec_command pnpm typecheck',
      totalTokens: 1500,
    }));
    expect(Math.round(summary.contextPercent ?? 0)).toBe(15);
  });

  it('reads idle after task_complete even when sampling dropped tool outputs', () => {
    // Head/tail sampling of a large rollout can capture a function_call whose
    // function_call_output fell into the gap between the two windows. The
    // turn-boundary events must clear those phantom pending calls.
    const summary = parseCodexRollout(jsonl([
      { type: 'session_meta', payload: { id: 's1', cwd: '/tmp/p', timestamp: '2026-07-03T23:01:14.000Z' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } },
      {
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call-lost', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      },
      // output for call-lost is missing (sampling gap)
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ]));
    expect(summary.state).toBe('idle');
  });

  it('reads idle after turn_aborted with dangling tool calls', () => {
    const summary = parseCodexRollout(jsonl([
      { type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      {
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      },
      { type: 'event_msg', payload: { type: 'turn_aborted' } },
    ]));
    expect(summary.state).toBe('idle');
  });

  it('clears stale pending calls from a prior turn when a new user message arrives', () => {
    const summary = parseCodexRollout(jsonl([
      {
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call-old', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'next turn' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ]));
    expect(summary.state).toBe('idle');
    expect(summary.hasPendingCalls).toBe(false);
  });

  it('stays processing through mid-turn thinking gaps and agent messages', () => {
    // Most of a working turn is the gap between a tool result and the next
    // tool call. Neither a completed tool call nor a mid-turn agent_message
    // may flip the state to idle — only task_complete/turn_aborted ends it.
    const midTurn = jsonl([
      { type: 'event_msg', payload: { type: 'user_message', message: 'do work' } },
      { type: 'event_msg', payload: { type: 'task_started', model_context_window: 200_000 } },
      {
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'partial progress note' } },
    ]);
    expect(parseCodexRollout(midTurn).state).toBe('processing');

    // task_started alone (user_message lost in the sampling gap) still arms the turn.
    const resumed = jsonl([
      { type: 'event_msg', payload: { type: 'task_started', model_context_window: 200_000 } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c0' } },
    ]);
    expect(parseCodexRollout(resumed).state).toBe('processing');
  });

  it('maps lsof field output to Codex rollout files by pid', () => {
    const rollouts = parseLsofRollouts([
      'p123',
      'n/Users/example/.codex/sessions/2026/04/26/rollout-abc.jsonl',
      'p456',
      'n/Users/example/.codex/config.toml',
      'n/Users/example/.codex/sessions/2026/04/26/rollout-def.jsonl',
    ].join('\n'));

    expect(rollouts.get(123)).toEqual(['/Users/example/.codex/sessions/2026/04/26/rollout-abc.jsonl']);
    expect(rollouts.get(456)).toEqual(['/Users/example/.codex/sessions/2026/04/26/rollout-def.jsonl']);
  });

  it('keeps every rollout a desktop app-server pid holds open, deduped', () => {
    const rollouts = parseLsofRollouts([
      'p999',
      'n/Users/example/.codex/sessions/2026/08/03/rollout-one.jsonl',
      'n/Users/example/.codex/sessions/2026/08/03/rollout-two.jsonl',
      'n/Users/example/.codex/sessions/2026/08/03/rollout-one.jsonl',
    ].join('\n'));

    expect(rollouts.get(999)).toEqual([
      '/Users/example/.codex/sessions/2026/08/03/rollout-one.jsonl',
      '/Users/example/.codex/sessions/2026/08/03/rollout-two.jsonl',
    ]);
  });

  it('admits Codex Desktop app-server but rejects helper lookalikes', () => {
    expect(isCodexSessionProcessCommand(
      '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server',
    )).toBe(true);
    expect(isCodexSessionProcessCommand('/opt/homebrew/bin/codex --model gpt-5.4')).toBe(true);
    expect(isCodexSessionProcessCommand('/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host')).toBe(false);
    expect(isCodexSessionProcessCommand('grep codex')).toBe(false);
  });

  it('marks internal subagent rollouts from session_meta source', () => {
    const parent = parseCodexRollout(jsonl([
      { type: 'session_meta', payload: { id: 'parent', source: 'vscode', originator: 'Codex Desktop' } },
    ]));
    const child = parseCodexRollout(jsonl([
      { type: 'session_meta', payload: { id: 'child', source: { subagent: 'review' }, originator: 'codex_exec' } },
    ]));

    expect(parent.isSubagent).toBe(false);
    expect(child.isSubagent).toBe(true);
  });

  it('reuses unchanged rollout summaries and invalidates changes/removals', async () => {
    let info = { mtimeMs: 1, size: 10 };
    let reads = 0;
    let raw = jsonl([{ type: 'session_meta', payload: { id: 'one', source: 'vscode' } }]);
    const cache = new CodexRolloutCache({
      stat: async () => info,
      read: async () => { reads += 1; return raw; },
    });

    expect((await cache.get('/rollout.jsonl'))?.summary.sessionId).toBe('one');
    expect((await cache.get('/rollout.jsonl'))?.summary.sessionId).toBe('one');
    expect(reads).toBe(1);

    info = { mtimeMs: 2, size: 20 };
    raw = jsonl([{ type: 'session_meta', payload: { id: 'two', source: 'vscode' } }]);
    expect((await cache.get('/rollout.jsonl'))?.summary.sessionId).toBe('two');
    expect(reads).toBe(2);

    cache.retain(new Set());
    expect(cache.size).toBe(0);
  });

  it('surfaces top-level Desktop rollouts and excludes internal subagents', async () => {
    const process = {
      pid: 999,
      ppid: 1,
      rssKb: 100,
      command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server',
    };
    const cache = new CodexRolloutCache({
      stat: async () => ({ mtimeMs: 10, size: 10 }),
      read: async (path) => jsonl([{
        type: 'session_meta',
        payload: path.includes('child')
          ? { id: 'child', cwd: '/repo/child', source: { subagent: 'review' } }
          : { id: 'parent', cwd: '/repo/parent', source: 'vscode', originator: 'Codex Desktop' },
      }]),
    });

    const sessions = await collectCodexSessionsFromRollouts(
      [process],
      new Map([[999, ['/rollout-parent.jsonl', '/rollout-child.jsonl']]]),
      cache,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'observed:codex-app:parent',
      agentType: 'codex-app',
      pid: 999,
      cwd: '/repo/parent',
    });
  });

  it('dedupes a hook-observed Desktop conversation without hiding sibling rollouts', () => {
    const observed = ['parent', 'sibling'].map((id) => ({
      id: `observed:codex-app:${id}`,
      agentType: 'codex-app',
      pid: 999,
      port: 0,
      projectName: id,
      alive: true,
      state: 'idle',
      startedAt: '2026-08-04T00:00:00.000Z',
      controlMode: 'observed',
    }));
    const managed = [{ id: 'parent', pid: 999 }];
    const processes = [{ pid: 999, ppid: 1, rssKb: 10, command: '/Applications/ChatGPT.app/codex app-server' }];

    const result = dedupeObservedSessions(observed as never, managed as never, processes);

    expect(result.map((session) => session.id)).toEqual(['observed:codex-app:sibling']);
  });

  it('recognizes standalone Antigravity processes for CLI daemon passive discovery', () => {
    expect(isAntigravityProcessCommand('/Applications/Antigravity.app/Contents/MacOS/Antigravity')).toBe(true);
    expect(isAntigravityProcessCommand('/opt/homebrew/bin/antigravity --folder /repo')).toBe(true);
    expect(isAntigravityProcessCommand('Antigravity')).toBe(true);

    expect(isAntigravityProcessCommand('Antigravity Helper (Renderer)')).toBe(false);
    expect(isAntigravityProcessCommand('grep Antigravity')).toBe(false);
    expect(isAntigravityProcessCommand('node /usr/local/bin/agentdeck antigravity')).toBe(false);
  });
});
