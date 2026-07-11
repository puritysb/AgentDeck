import { describe, expect, it } from 'vitest';
import {
  isAntigravityProcessCommand,
  parseClaudeTranscript,
  parseCodexRollout,
  parseLsofRolloutLists,
  parseLsofRollouts,
  parseProcessTable,
  isCodexDesktopAppServerCommand,
} from '../passive-observer.js';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('passive-observer parsers', () => {
  it('parses ps output without depending on fixed command columns', () => {
    const rows = parseProcessTable([
      ' 123 1 20480 /opt/homebrew/bin/codex --model gpt-5.4',
      ' 456 123 1024 /bin/zsh -lc claude',
      'not a process row',
    ].join('\n'));

    expect(rows).toEqual([
      {
        pid: 123,
        ppid: 1,
        rssKb: 20480,
        command: '/opt/homebrew/bin/codex --model gpt-5.4',
      },
      {
        pid: 456,
        ppid: 123,
        rssKb: 1024,
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

  it('identifies top-level Codex Desktop rollouts without promoting subagents', () => {
    const desktop = parseCodexRollout(jsonl([{
      type: 'session_meta',
      payload: {
        id: 'desktop-session-1',
        cwd: '/Users/example/github/AgentDeck',
        timestamp: '2026-07-11T01:00:00.000Z',
        originator: 'Codex Desktop',
        source: 'vscode',
      },
    }]));
    const subagent = parseCodexRollout(jsonl([{
      type: 'session_meta',
      payload: {
        id: 'desktop-subagent-1',
        originator: 'Codex Desktop',
        parent_thread_id: 'desktop-session-1',
        source: { subagent: { other: 'guardian' } },
      },
    }]));

    expect(desktop).toEqual(expect.objectContaining({
      originator: 'Codex Desktop',
      source: 'vscode',
      isSubagent: false,
    }));
    expect(subagent.isSubagent).toBe(true);
  });

  it('keeps a Codex Desktop turn processing until task_complete', () => {
    const activeRecords = [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'agent_message' } },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'desktop-call-1',
          name: 'functions.exec',
          input: JSON.stringify({ cmd: 'pnpm build' }),
        },
      },
      {
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'desktop-call-1' },
      },
    ];

    expect(parseCodexRollout(jsonl(activeRecords)).state).toBe('processing');
    expect(parseCodexRollout(jsonl([
      ...activeRecords,
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ])).state).toBe('idle');
  });

  it('recognizes Codex Desktop app-server commands across launch styles', () => {
    expect(isCodexDesktopAppServerCommand(
      '/Applications/Codex.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled',
    )).toBe(true);
    expect(isCodexDesktopAppServerCommand(
      'codex -c features.code_mode_host=true app-server',
    )).toBe(true);
    expect(isCodexDesktopAppServerCommand('/opt/homebrew/bin/codex app-server --listen stdio://')).toBe(false);
    expect(isCodexDesktopAppServerCommand('/opt/homebrew/bin/codex -c other.feature=true app-server')).toBe(false);
    expect(isCodexDesktopAppServerCommand('/opt/homebrew/bin/codex')).toBe(false);
  });

  it('maps lsof field output to Codex rollout files by pid', () => {
    const output = [
      'p123',
      'n/Users/example/.codex/sessions/2026/04/26/rollout-abc.jsonl',
      'n/Users/example/.codex/sessions/2026/04/26/rollout-abc-2.jsonl',
      'p456',
      'n/Users/example/.codex/config.toml',
      'n/Users/example/.codex/sessions/2026/04/26/rollout-def.jsonl',
    ].join('\n');
    const rolloutLists = parseLsofRolloutLists(output);
    const rollouts = parseLsofRollouts(output);

    expect(rolloutLists.get(123)).toEqual([
      '/Users/example/.codex/sessions/2026/04/26/rollout-abc.jsonl',
      '/Users/example/.codex/sessions/2026/04/26/rollout-abc-2.jsonl',
    ]);
    expect(rollouts.get(123)).toBe('/Users/example/.codex/sessions/2026/04/26/rollout-abc-2.jsonl');
    expect(rollouts.get(456)).toBe('/Users/example/.codex/sessions/2026/04/26/rollout-def.jsonl');
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
