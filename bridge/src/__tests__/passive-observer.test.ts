import { describe, expect, it } from 'vitest';
import {
  CodexRolloutCache,
  collectCodexSessionsFromRollouts,
  dedupeObservedSessions,
  isAntigravityProcessCommand,
  isClaudeSessionProcessCommand,
  isCodexSessionProcessCommand,
  parseCimProcessTable,
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

  it('parses Win32_Process JSON, converting bytes to KB and dropping null command lines', () => {
    const rows = parseCimProcessTable(JSON.stringify([
      {
        ProcessId: 4321,
        ParentProcessId: 812,
        WorkingSetSize: 209_715_200,
        CommandLine: '"C:\\Users\\robin\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe"',
      },
      // Protected/system processes report no command line — nothing observable.
      { ProcessId: 4, ParentProcessId: 0, WorkingSetSize: 151_552, CommandLine: null },
      { ProcessId: 0, ParentProcessId: 0, WorkingSetSize: 8_192, CommandLine: 'System Idle Process' },
    ]));

    expect(rows).toEqual([
      {
        pid: 4321,
        ppid: 812,
        rssKb: 204_800,
        tty: undefined,
        command: '"C:\\Users\\robin\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe"',
      },
    ]);
  });

  it('parses the bare object ConvertTo-Json emits for a single row', () => {
    const rows = parseCimProcessTable(JSON.stringify({
      ProcessId: 5100,
      ParentProcessId: 4321,
      WorkingSetSize: 1_048_576,
      CommandLine: 'codex.exe app-server',
    }));

    expect(rows).toEqual([
      { pid: 5100, ppid: 4321, rssKb: 1024, tty: undefined, command: 'codex.exe app-server' },
    ]);
  });

  it('returns no rows for non-JSON scan output', () => {
    expect(parseCimProcessTable('Get-CimInstance : Access is denied.')).toEqual([]);
  });

  it('parses scan output that arrives with a UTF-8 BOM', () => {
    // Pinning the PowerShell pipe to UTF-8 writes the encoding's preamble into
    // the redirected stream, so the payload leads with U+FEFF. JSON.parse
    // throws on it, and the failure is total and silent: zero processes, no
    // error, Windows observation simply blind.
    const rows = parseCimProcessTable(`\uFEFF${JSON.stringify({
      ProcessId: 5100,
      ParentProcessId: 4321,
      WorkingSetSize: 1_048_576,
      CommandLine: 'codex.exe app-server',
    })}`);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pid).toBe(5100);
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
    // ChatGPT's Electron helpers carry a capital-`Codex` basename, and the
    // code-mode host is a different binary — neither owns a rollout.
    expect(isCodexSessionProcessCommand(
      '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer',
    )).toBe(false);
    expect(isCodexSessionProcessCommand('/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host')).toBe(false);
    expect(isCodexSessionProcessCommand('grep codex')).toBe(false);
  });

  it('matches Win32 command lines — quoted paths, backslashes, .exe suffix', () => {
    // Quoted because the path has spaces; the whitespace split leaves the
    // closing quote on the second token.
    expect(isCodexSessionProcessCommand('"C:\\Program Files\\Codex CLI\\codex.exe" app-server')).toBe(true);
    expect(isCodexSessionProcessCommand('C:\\Users\\robin\\.local\\bin\\codex.exe --model gpt-5.4')).toBe(true);
    // The renderer-helper exclusion must survive the .exe tolerance.
    expect(isCodexSessionProcessCommand('C:\\apps\\Codex --type=renderer')).toBe(false);
    // Windows names the Electron helper after the app: `Codex.exe`, capital C.
    // Folding the whole basename to lowercase for the .exe compare re-admitted
    // exactly the helpers the exact-case rule exists to keep out — only the
    // suffix may fold.
    expect(isCodexSessionProcessCommand(
      '"C:\\Users\\robin\\AppData\\Local\\Programs\\ChatGPT\\Codex.exe" --type=renderer',
    )).toBe(false);
    expect(isCodexSessionProcessCommand(
      '"C:\\Users\\robin\\AppData\\Local\\Programs\\ChatGPT\\Codex.exe"',
    )).toBe(false);
    // A case-insensitive SUFFIX is still tolerated — the filesystem names it.
    expect(isCodexSessionProcessCommand('C:\\Users\\robin\\.local\\bin\\codex.EXE')).toBe(true);
  });

  it('finds an npm-installed Claude Code, which never puts "claude" in argv[0]', () => {
    // On Windows `claude` is a .cmd shim, so the process the scan sees is
    // node.exe running the package's cli.js — the binary name is nowhere in
    // the command line and the old matcher dropped the session entirely.
    expect(isClaudeSessionProcessCommand(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\robin\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"',
    )).toBe(true);
    expect(isClaudeSessionProcessCommand(
      '/usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    )).toBe(true);
    // The native installer's binary, both spellings.
    expect(isClaudeSessionProcessCommand('/Users/robin/.local/bin/claude')).toBe(true);
    expect(isClaudeSessionProcessCommand('"C:\\Users\\robin\\.local\\bin\\claude.exe"')).toBe(true);
    // The desktop app and its Electron children are not a CLI session.
    expect(isClaudeSessionProcessCommand(
      '"C:\\Users\\robin\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\Claude.exe" --type=renderer',
    )).toBe(false);
    // Non-interactive one-shots stay excluded.
    expect(isClaudeSessionProcessCommand('/Users/robin/.local/bin/claude --print "hi"')).toBe(false);
    // An unrelated node process must not be swept in.
    expect(isClaudeSessionProcessCommand('node /Users/robin/src/server.js')).toBe(false);
  });

  it('drops Electron child processes that reuse the app binary name', () => {
    // One running Antigravity IDE on Windows is a dozen processes that all
    // report `Antigravity.exe`. Antigravity is the one observed agent with no
    // downstream identity gate, so each child became its own phantom session.
    const parent = '"C:\\Users\\robin\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe"';
    expect(isAntigravityProcessCommand(parent)).toBe(true);
    for (const type of ['renderer', 'gpu-process', 'utility', 'crashpad-handler']) {
      expect(isAntigravityProcessCommand(`${parent} --type=${type}`)).toBe(false);
    }
    // macOS shapes are unchanged: the CLI, the app binary, the named helper.
    expect(isAntigravityProcessCommand('/opt/homebrew/bin/agy')).toBe(true);
    expect(isAntigravityProcessCommand('/Applications/Antigravity.app/Contents/MacOS/Antigravity')).toBe(true);
    expect(isAntigravityProcessCommand(
      '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app/Contents/MacOS/Antigravity Helper (Renderer)',
    )).toBe(false);
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

  it('counts Codex cached input once when the producer folds it into input_tokens', () => {
    // Live rollouts satisfy total_tokens === input + output, i.e. cached is
    // already inside input_tokens. Re-adding it read one session at 105%
    // context and roughly doubled its token total.
    const summary = parseCodexRollout(jsonl([
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'high', model_context_window: 258_400 } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258_400,
            total_token_usage: {
              input_tokens: 26_805_300,
              cached_input_tokens: 26_281_216,
              output_tokens: 97_519,
              total_tokens: 26_902_819,
            },
            last_token_usage: {
              input_tokens: 159_649,
              cached_input_tokens: 158_464,
              output_tokens: 191,
              total_tokens: 159_840,
            },
          },
        },
      },
    ]));

    expect(summary.totalTokens).toBe(26_902_819);
    expect(summary.contextPercent).toBeCloseTo((159_649 / 258_400) * 100, 5);
    expect(summary.contextPercent ?? 0).toBeLessThan(100);
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
