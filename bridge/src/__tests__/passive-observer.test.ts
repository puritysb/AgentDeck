import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeKiroCliProcesses,
  CodexRolloutCache,
  collectCodexSessionsFromRollouts,
  confirmMissingProcesses,
  foldHeadlessCodexSessions,
  type ProcInfo,
  collectKiroSessionsFromSnapshots,
  dedupeObservedSessions,
  isAntigravityProcessCommand,
  isClaudeSessionProcessCommand,
  isCodexSessionProcessCommand,
  isKiroCliProcessCommand,
  isKiroIdeProcessCommand,
  nextScanIntervalMs,
  observedStateAfterSilence,
  parseCimProcessTable,
  PassiveSessionObserver,
  parseClaudeTranscript,
  parseCodexRollout,
  parseLsofRollouts,
  parseLsofRolloutProbe,
  parseProcessTable,
  selectClaudeConversationFiles,
  type ClaudeSessionFile,
} from '../passive-observer.js';
import { parseKiroSessionMetadata, parseKiroTranscript } from '../kiro-session.js';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('passive-observer parsers', () => {
  it('expires a silent observed processing state without hiding fresh work', () => {
    const now = Date.parse('2026-08-07T04:00:00.000Z');
    expect(observedStateAfterSilence('processing', now - 11 * 60_000, now)).toBe('idle');
    expect(observedStateAfterSilence('processing', now - 9 * 60_000, now)).toBe('processing');
    expect(observedStateAfterSilence('idle', now - 11 * 60_000, now)).toBe('idle');
    expect(observedStateAfterSilence('processing', undefined, now)).toBe('processing');
  });

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

  it('reads Codex effort and permission mode verbatim from turn_context', () => {
    const base = { model: 'gpt-6-astra', effort: 'ultra' };
    const sandboxed = parseCodexRollout(jsonl([
      { type: 'turn_context', payload: { ...base, sandbox_policy: { type: 'workspace-write' }, collaboration_mode: { mode: 'default' } } },
    ]));
    // An effort level this code has never heard of passes through untouched.
    expect(sandboxed).toEqual(expect.objectContaining({ modelName: 'gpt-6-astra', effort: 'ultra', permissionMode: 'workspace-write' }));
    const planning = parseCodexRollout(jsonl([
      { type: 'turn_context', payload: { ...base, sandbox_policy: { type: 'danger-full-access' }, collaboration_mode: { mode: 'plan' } } },
    ]));
    expect(planning.permissionMode).toBe('plan');
    const silent = parseCodexRollout(jsonl([{ type: 'turn_context', payload: { model: 'gpt-6-astra' } }]));
    // Nothing reported means nothing shown — never a default of our own.
    expect(silent.effort).toBeUndefined();
    expect(silent.permissionMode).toBeUndefined();
  });

  it('summarizes Codex rollout metadata, context, and pending tool calls', () => {
    const summary = parseCodexRollout(jsonl([
      {
        type: 'session_meta',
        payload: {
          id: 'codex-session-1',
          cwd: '/Users/example/github/AgentDeck',
          timestamp: '2026-04-26T01:00:00.000Z',
          originator: 'Codex Desktop',
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
      modelName: 'gpt-5.4',
      effort: 'high',
      state: 'processing',
      currentTask: 'exec_command pnpm typecheck',
      totalTokens: 1500,
      originator: 'Codex Desktop',
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

  it('finds a Claude Code background job launched from the versioned binary', () => {
    // Live 2026-10-10: the job the user was working in ran as the versioned
    // native binary, so argv[0] never said `claude` and the session vanished.
    const job = '/Users/robin/.local/share/claude/versions/2.1.296 --session-id 5b55b9d6-c0e9-4309-9cff-24fffa6eb973 '
      + '--fork-session --resume /Users/robin/.claude/projects/-Users-robin-OpenClaw/d385adf6-9e82-4567-8360-c8d9c9a4483b.jsonl '
      + '--model claude-opus-5-5 --permission-mode auto';
    expect(isClaudeSessionProcessCommand(job)).toBe(true);
    expect(isClaudeSessionProcessCommand('C:\\Users\\robin\\.local\\share\\claude\\versions\\2.1.296.exe --session-id x')).toBe(true);
    // The PTY host that relays the job's terminal is not a conversation.
    expect(isClaudeSessionProcessCommand(
      '/Users/robin/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon-501/c1/pty/5b55b9d6.sock 272 56 -- '
        + '/Users/robin/.local/share/claude/versions/2.1.296 --session-id 5b55b9d6',
    )).toBe(false);
    // Only argv[0] counts — an argument naming the path is not the binary.
    expect(isClaudeSessionProcessCommand('/usr/bin/du -sh /Users/robin/.local/share/claude/versions/2.1.296')).toBe(false);
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

  it('matches Kiro CLI and IDE owners while rejecting Electron helpers', () => {
    expect(isKiroCliProcessCommand('/Users/robin/.local/bin/kiro-cli --v3')).toBe(true);
    expect(isKiroCliProcessCommand('/Users/robin/.local/bin/kiro-cli chat --no-interactive hello')).toBe(true);
    expect(isKiroCliProcessCommand('/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat chat')).toBe(true);
    expect(isKiroCliProcessCommand('kiro-cli --agent doctor')).toBe(true);
    expect(isKiroCliProcessCommand('kiro-cli login --license free')).toBe(false);
    expect(isKiroCliProcessCommand('kiro-cli doctor')).toBe(false);
    expect(isKiroCliProcessCommand('kiro-cli --version')).toBe(false);
    expect(isKiroCliProcessCommand('C:\\Users\\robin\\bin\\kiro.exe')).toBe(true);
    expect(isKiroIdeProcessCommand('/Applications/Kiro.app/Contents/MacOS/Kiro')).toBe(true);
    expect(
      isKiroIdeProcessCommand('/Applications/Kiro CLI.app/Contents/MacOS/kiro_cli_desktop --no-dashboard'),
    ).toBe(false);
    expect(
      isKiroIdeProcessCommand(
        '/Applications/Kiro.app/Contents/Frameworks/Kiro Helper (Renderer).app/Contents/MacOS/Kiro Helper (Renderer) --type=renderer',
      ),
    ).toBe(false);
  });

  it('collapses the Kiro launcher and kiro-cli-chat child to one chat process', () => {
    const processes = [
      { pid: 100, ppid: 1, rssKb: 10, tty: 'ttys001', command: 'kiro-cli chat --legacy-ui' },
      {
        pid: 101,
        ppid: 100,
        rssKb: 20,
        tty: 'ttys001',
        command: '/Users/robin/.local/bin/kiro-cli-chat chat --legacy-ui',
      },
    ];
    expect(activeKiroCliProcesses(processes).map((proc) => proc.pid)).toEqual([101]);
  });

  // The fixture above is two deep with a single kiro-cli-chat. A real chat is
  // four deep and runs kiro-cli-chat TWICE — the `chat` process and an `acp`
  // one under its bun TUI — so the shape that ships was never covered. Measured
  // from `ps` on 2026-08-17, where `diag kiro` reported one conversation as
  // "Processes: 2 (2 CLI)" and bound the surplus row to a 34h-old transcript.
  it('collapses the real four-deep chat tree, acp child included, to one process', () => {
    const processes = [
      { pid: 63535, ppid: 51620, rssKb: 10, tty: 'ttys008', command: 'kiro-cli chat' },
      { pid: 63631, ppid: 63535, rssKb: 20, tty: 'ttys008', command: '/Users/robin/.local/bin/kiro-cli-chat chat' },
      {
        pid: 64083,
        ppid: 63631,
        rssKb: 30,
        tty: 'ttys008',
        command: '/Users/robin/Library/Application Support/kiro-cli/bun /Users/robin/Library/Application Support/kiro-cli/tui.js chat',
      },
      { pid: 64091, ppid: 64083, rssKb: 15, tty: '??', command: '/Users/robin/.local/bin/kiro-cli-chat acp' },
      // The persistent native host is not a chat and must stay out of both lists.
      { pid: 7397, ppid: 1, rssKb: 40, tty: '??', command: '/Applications/Kiro CLI.app/Contents/MacOS/kiro_cli_desktop --no-dashboard' },
    ];
    expect(activeKiroCliProcesses(processes).map((proc) => proc.pid)).toEqual([63631]);
  });

  it('reads Kiro 2.x metadata and transcript turn state', () => {
    const metadata = parseKiroSessionMetadata(
      JSON.stringify({
        cwd: '/repo/kiro',
        title: 'Add passive observation',
        created_at: '2026-08-15T01:00:00.000Z',
        updated_at: '2026-08-15T01:01:00.000Z',
        session_state: { rts_model_state: { model_info: { model_id: 'claude-sonnet-4' } } },
      }),
      'kiro-session',
    );
    expect(metadata).toMatchObject({
      sessionId: 'kiro-session',
      cwd: '/repo/kiro',
      title: 'Add passive observation',
      modelName: 'claude-sonnet-4',
    });

    const working = parseKiroTranscript(
      jsonl([
        { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'inspect the tests' }] } },
        {
          version: 'v1',
          kind: 'AssistantMessage',
          data: { content: [{ kind: 'toolUse', data: { name: 'execute_bash', input: { command: 'pnpm test' } } }] },
        },
        { version: 'v1', kind: 'ToolResults', data: { content: [] } },
      ]),
    );
    expect(working).toMatchObject({
      state: 'processing',
      goal: 'inspect the tests',
      currentTask: 'execute_bash pnpm test',
    });

    const redacted = parseKiroTranscript(
      jsonl([
        { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'call the API' }] } },
        {
          version: 'v1',
          kind: 'AssistantMessage',
          data: {
            content: [
              {
                kind: 'toolUse',
                data: { name: 'shell', input: { command: 'curl -H "Authorization: Bearer secret-123" example.test' } },
              },
            ],
          },
        },
      ]),
    );
    expect(redacted.currentTask).toContain('[REDACTED]');
    expect(redacted.currentTask).not.toContain('secret-123');

    const idle = parseKiroTranscript(
      jsonl([
        { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'inspect the tests' }] } },
        { version: 'v1', kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'All tests pass.' }] } },
      ]),
    );
    expect(idle).toMatchObject({ state: 'idle', response: 'All tests pass.' });
  });

  // `execute_bash` above carries its subject as `input.command`, which is the
  // only shape the fixtures had. Kiro's `read` nests it in `input.operations[]`
  // — captured verbatim from a live `ls -la` turn on 2026-08-17, where the
  // label came out as a bare "read" while Kiro's own UI showed the path.
  it('reads a Kiro tool subject out of the nested operations shape', () => {
    const summary = parseKiroTranscript(
      jsonl([
        { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'ls -la 해줘' }] } },
        {
          version: 'v1',
          kind: 'AssistantMessage',
          data: {
            content: [
              {
                kind: 'toolUse',
                data: {
                  toolUseId: 'tooluse_e6zfT83FyPlU7fK1Tv5z8u',
                  name: 'read',
                  input: {
                    __tool_use_purpose: 'AgentDeck 루트 디렉토리 목록 확인',
                    operations: [{ mode: 'Directory', path: '/Users/robin/github/AgentDeck', depth: 1 }],
                  },
                },
              },
            ],
          },
        },
        { version: 'v1', kind: 'ToolResults', data: { content: [] } },
      ]),
    );
    expect(summary.currentTask).toBe('read /Users/robin/github/AgentDeck');
    // The model's free-text rationale for the call is not the task label.
    expect(summary.currentTask).not.toContain('디렉토리 목록 확인');
  });

  it('reads documented Kiro ACP session notifications for the v3 fallback', () => {
    const summary = parseKiroTranscript(
      jsonl([
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'session/prompt',
          params: { sessionId: 's1', content: [{ type: 'text', text: 'review this code' }] },
        },
        {
          jsonrpc: '2.0',
          method: 'session/notification',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'ToolCall', name: 'fs_read', input: { path: 'src/a.ts' } },
          },
        },
        {
          jsonrpc: '2.0',
          method: 'session/notification',
          params: { sessionId: 's1', update: { sessionUpdate: 'TurnEnd' } },
        },
      ]),
    );
    expect(summary).toMatchObject({ state: 'idle', goal: 'review this code' });
  });

  it('does not complete a Kiro turn after ten minutes of silent tool work', () => {
    const sessions = collectKiroSessionsFromSnapshots(
      [{ pid: 777, ppid: 1, rssKb: 100, tty: 'ttys007', command: 'kiro-cli --resume-id silent' }],
      [{ sessionId: 'silent', transcriptPath: '/tmp/messages.jsonl',
        lastActivityAt: Date.now() - 11 * 60 * 1000, state: 'processing',
        recordKinds: ['turn_start'] }], new Map());
    expect(sessions[0]?.state).toBe('processing');
  });

  it('correlates a naturally launched Kiro process with its newest cwd session', () => {
    const proc = {
      pid: 777,
      ppid: 1,
      rssKb: 100,
      tty: 'ttys007',
      command: '/Users/robin/.local/bin/kiro-cli --v3 --resume-id session-1',
    };
    const sessions = collectKiroSessionsFromSnapshots(
      [proc],
      [
        {
          sessionId: 'newer-but-closed',
          transcriptPath: '/Users/robin/.kiro/sessions/cli/newer-but-closed.jsonl',
          cwd: '/repo/kiro',
          lastActivityAt: Date.now() + 1000,
          state: 'idle',
          recordKinds: ['Prompt', 'AssistantMessage'],
        },
        {
          sessionId: 'session-1',
          transcriptPath: '/Users/robin/.kiro/sessions/cli/session-1.jsonl',
          cwd: '/repo/kiro',
          modelName: 'auto',
          createdAt: Date.parse('2026-08-15T01:00:00.000Z'),
          lastActivityAt: Date.now(),
          state: 'processing',
          goal: 'add observation',
          currentTask: 'fs_read src/a.ts',
          recordKinds: ['Prompt', 'AssistantMessage'],
        },
      ],
      new Map([[777, '/repo/kiro']]),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'observed:kiro:session-1',
      agentType: 'kiro-cli',
      pid: 777,
      cwd: '/repo/kiro',
      state: 'processing',
      currentTask: 'fs_read src/a.ts',
    });
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
      100,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'observed:codex-app:parent',
      agentType: 'codex-app',
      pid: 999,
      cwd: '/repo/parent',
    });
  });

  it('drops stale idle Desktop rollouts while retaining recent and processing chats', async () => {
    const process = {
      pid: 999,
      ppid: 1,
      rssKb: 100,
      command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server',
    };
    const now = 1_000_000;
    const cache = new CodexRolloutCache({
      stat: async (path) => ({
        mtimeMs: path.includes('recent') ? now - 1_000 : now - 91_000,
        size: 10,
      }),
      read: async (path) => jsonl([
        {
          type: 'session_meta',
          payload: {
            id: path.replace('/rollout-', '').replace('.jsonl', ''),
            cwd: '/repo/app',
            originator: 'Codex Desktop',
          },
        },
        ...(path.includes('processing')
          ? [{ type: 'event_msg', payload: { type: 'task_started' } }]
          : []),
      ]),
    });

    const sessions = await collectCodexSessionsFromRollouts(
      [process],
      new Map([[999, [
        '/rollout-stale.jsonl',
        '/rollout-recent.jsonl',
        '/rollout-processing.jsonl',
      ]]]),
      cache,
      now,
    );

    expect(sessions.map((session) => session.id)).toEqual([
      'observed:codex-app:recent',
      'observed:codex-app:processing',
    ]);
  });

  it('keeps an idle Codex CLI rollout because its owning process is the live session', async () => {
    const process = {
      pid: 1000,
      ppid: 1,
      rssKb: 100,
      command: '/opt/homebrew/bin/codex',
    };
    const now = 1_000_000;
    const cache = new CodexRolloutCache({
      stat: async () => ({ mtimeMs: now - 600_000, size: 10 }),
      read: async () => jsonl([{
        type: 'session_meta',
        payload: { id: 'cli-idle', cwd: '/repo/cli', originator: 'codex-tui' },
      }]),
    });

    const sessions = await collectCodexSessionsFromRollouts(
      [process],
      new Map([[1000, ['/rollout-cli-idle.jsonl']]]),
      cache,
      now,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'observed:codex:cli-idle',
      agentType: 'codex-cli',
      state: 'idle',
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

describe('passive-observer scan resilience', () => {
  afterEach(() => { vi.useRealTimers(); });

  const table = [{ pid: 1, ppid: 0, rssKb: 1024, tty: undefined, command: '/sbin/launchd' }];

  /** collect() kicks the scan off in the background; let it settle. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  it('re-reads live or inaccessible missing PIDs and only confirms ESRCH exits', async () => {
    const recovered = { pid: 42, ppid: 1, rssKb: 1024, command: 'claude' };
    const reread = vi.fn(async () => [recovered]);
    expect(await confirmMissingProcesses([42, 43, 44], pid => pid === 43 ? false : undefined, reread))
      .toEqual({ processes: [recovered], exited: 1, unknownPids: [44] });
    expect(reread).toHaveBeenCalledWith([42, 44]);
  });

  it('does not call a failed targeted read an exit while the PID still exists', async () => {
    expect(await confirmMissingProcesses([42], () => true, async () => { throw new Error('ps timeout'); }))
      .toEqual({ processes: [], exited: 0, unknownPids: [42] });
    let calls = 0;
    expect(await confirmMissingProcesses([42], () => ++calls === 1, async () => []))
      .toEqual({ processes: [], exited: 1, unknownPids: [] });
  });

  it('applies exits, replacements and new sessions while retaining only an inconclusive PID', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentdeck-mixed-processes-'));
    vi.stubEnv('HOME', directory);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(directory, '.claude'));
    mkdirSync(join(directory, '.claude', 'sessions'), { recursive: true });
    const hosts = [42, 43, 44, 45].map(pid => ({ pid, ppid: 1, rssKb: 100, command: 'claude' }));
    for (const { pid } of hosts) {
      writeFileSync(join(directory, '.claude', 'sessions', `${pid}.json`), JSON.stringify({
        pid, sessionId: `mixed-${pid}`, cwd: directory, startedAt: Date.now(),
      }));
    }
    let processes = [...table, ...hosts.slice(0, 3)];
    let inconclusive = true;
    const observer = new PassiveSessionObserver(async () => processes,
      pids => confirmMissingProcesses(pids, pid => pid === 43 && inconclusive ? undefined : false,
        async () => []));
    const refreshed = vi.fn();
    observer.onRefreshed = refreshed;
    try {
      vi.useFakeTimers({ now: Date.now() });
      observer.collect([]); await settle();
      const retained = observer.collect([]).find(row => row.pid === 43);
      expect(retained).toBeDefined();
      const stamp = observer.processSnapshot().capturedAt;
      // Even readable replacement metadata cannot refresh an unobserved owner.
      writeFileSync(join(directory, '.claude', 'sessions', '43.json'), JSON.stringify({
        pid: 43, sessionId: 'unconfirmed-replacement', cwd: directory, startedAt: Date.now(),
      }));
      processes = [...table, { ...hosts[2], command: '/bin/zsh' }, hosts[3]];
      vi.advanceTimersByTime(6_000);
      observer.collect([]); await settle();
      expect(observer.collect([]).map(row => row.id).sort()).toEqual([
        'observed:claude:mixed-43', 'observed:claude:mixed-45',
      ]);
      expect(observer.collect([]).find(row => row.pid === 43)).toEqual(retained);
      expect(observer.processes()).toEqual([...processes, hosts[1]]);
      expect(observer.processSnapshot().capturedAt).toBe(stamp);
      expect(observer.diagnostics().processContinuity).toMatchObject({ exited: 1, unknown: 1 });
      expect(refreshed).toHaveBeenCalledTimes(2);

      inconclusive = false;
      vi.advanceTimersByTime(6_000);
      observer.collect([]); await settle();
      expect(observer.collect([]).map(row => row.id)).toEqual(['observed:claude:mixed-45']);
      expect(observer.processes()).toEqual(processes);
      expect(observer.processSnapshot().capturedAt).toBeGreaterThan(stamp);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers a partial nonempty scan and preserves freshness when revalidation is unknown', async () => {
    const claude = { pid: 42, ppid: 1, rssKb: 1024, command: 'claude' };
    let processes = [...table, claude];
    let unknown = 0;
    let command = 'claude';
    const observer = new PassiveSessionObserver(async () => processes, async pids => ({
      processes: unknown ? [] : pids.map(() => ({ ...claude, command })), exited: 0, unknownPids: unknown ? pids : [],
    }));
    observer.collect([]); await settle();
    const seed = [{ id: 'observed:claude:abc', agentType: 'claude-code', pid: 42 }];
    (observer as unknown as { cached: unknown[] }).cached = seed;
    processes = table;
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    observer.collect([]); await settle();
    expect(observer.processes()).toEqual([...table, claude]);
    expect(table).toHaveLength(1);
    expect(observer.diagnostics().processContinuity).toMatchObject({ missing: 1, recovered: 1, unknown: 0 });
    (observer as unknown as { cached: unknown[] }).cached = seed;
    const stamp = observer.processSnapshot().capturedAt;
    unknown = 1;
    vi.advanceTimersByTime(60_000);
    observer.collect([]); await settle();
    expect(observer.collect([])).toEqual(seed);
    expect(observer.processes()).toEqual([...table, claude]);
    expect(observer.processSnapshot().capturedAt).toBe(stamp);
    expect(observer.diagnostics().processContinuity).toMatchObject({ missing: 1, unknown: 1 });
    expect(observer.diagnostics().processContinuity).toMatchObject({ recoveredScans: 1, recoveredPids: 1, inconclusiveScans: 1 });
    unknown = 0;
    command = '/bin/zsh';
    vi.advanceTimersByTime(60_000);
    observer.collect([]); await settle();
    expect(observer.collect([])).toEqual([]);
    expect(observer.processes().find(row => row.pid === 42)?.command).toBe('/bin/zsh');
  });

  it('does not replace established Desktop identities after an unreadable rollout probe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-probe-'));
    const path = join(dir, 'rollout-app.jsonl');
    writeFileSync(path, jsonl([{ type: 'session_meta', payload: {
      id: 'app-kept', cwd: '/repo', source: 'vscode', originator: 'Codex Desktop',
    } }]));
    const host = { pid: 42, ppid: 1, rssKb: 100, command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server' };
    let mode: 'known' | 'unknown' | 'closed' = 'known';
    const observer = new PassiveSessionObserver(async () => [...table, host],
      async () => ({ processes: [], exited: 0, unknownPids: [] }), async () => {
        if (mode === 'unknown') throw new Error('lsof deadline');
        return mode === 'known' ? new Map([[42, [path]]]) : new Map();
      });
    try {
      vi.useFakeTimers({ now: Date.now() });
      const first = new Promise<void>(resolve => { observer.onRefreshed = resolve; });
      observer.collect([]); await first; await settle();
      const seeded = observer.collect([]);
      expect(seeded).toHaveLength(1);
      expect(seeded[0]).toMatchObject({ id: 'observed:codex-app:app-kept', pid: 42 });
      const stamp = observer.diagnostics().codexRolloutCapturedAt;
      mode = 'unknown'; vi.advanceTimersByTime(6_000);
      observer.collect([]); await settle();
      expect(observer.collect([])).toEqual(seeded);
      expect(observer.diagnostics().codexRolloutCapturedAt).toBe(stamp);
      expect(observer.processSnapshot().capturedAt).toBeGreaterThan(stamp);
      expect(observer.diagnostics().codexRolloutReadFailures).toBe(1);
      mode = 'closed'; vi.advanceTimersByTime(6_000);
      const closed = new Promise<void>(resolve => { observer.onRefreshed = resolve; });
      observer.collect([]); await closed; await settle();
      expect(observer.collect([])).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('still removes a confirmed exited owner while another Codex probe is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-probe-exit-'));
    const paths = ['a', 'b'].map(id => {
      const path = join(dir, `rollout-${id}.jsonl`);
      writeFileSync(path, jsonl([{ type: 'session_meta', payload: { id, cwd: '/repo', originator: 'Codex Desktop' } }]));
      return path;
    });
    const hosts = [42, 43].map(pid => ({ pid, ppid: 1, rssKb: 100, command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server' }));
    let exit = false;
    const observer = new PassiveSessionObserver(async () => [...table, ...(exit ? [hosts[1]] : hosts)],
      async pids => ({ processes: [], exited: pids.length, unknownPids: [] }), async () => {
        if (exit) throw new Error('lsof unavailable');
        return new Map([[42, [paths[0]]], [43, [paths[1]]]]);
      });
    try {
      vi.useFakeTimers({ now: Date.now() });
      const first = new Promise<void>(resolve => { observer.onRefreshed = resolve; });
      observer.collect([]); await first; await settle();
      expect(observer.collect([])).toHaveLength(2);
      exit = true; vi.advanceTimersByTime(6_000);
      const next = new Promise<void>(resolve => { observer.onRefreshed = resolve; });
      observer.collect([]); await next; await settle();
      expect(observer.collect([]).map(row => row.id)).toEqual(['observed:codex-app:b']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps an inconclusive Desktop owner through a mixed scan and a subsequent rollout failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mixed-probe-'));
    const hosts = [42, 43, 44].map(pid => ({ pid, ppid: 1, rssKb: 100,
      command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server' }));
    const paths = hosts.map(({ pid }) => {
      const path = join(dir, `rollout-${pid}.jsonl`);
      writeFileSync(path, jsonl([{ type: 'session_meta', payload: {
        id: `mixed-${pid}`, cwd: '/repo', originator: 'Codex Desktop',
      } }]));
      return path;
    });
    let step = 0;
    const observer = new PassiveSessionObserver(async () => [...table,
      ...(step === 0 ? hosts.slice(0, 2) : step === 1 ? [hosts[2]] : hosts.slice(1))],
    pids => confirmMissingProcesses(pids, pid => pid === 43 ? undefined : false, async () => []),
    async pids => {
      if (step === 2) throw new Error('lsof unavailable after owner recovery');
      return new Map(pids.map(pid => [pid, [paths[pid - 42]]]));
    });
    try {
      vi.useFakeTimers({ now: Date.now() });
      observer.collect([]); await vi.waitFor(() => expect(observer.collect([])).toHaveLength(2));
      await settle();
      for (step = 1; step <= 2; step += 1) {
        vi.advanceTimersByTime(6_000);
        observer.collect([]);
        await vi.waitFor(() => expect(observer.collect([]).map(row => row.id).sort()).toEqual([
          'observed:codex-app:mixed-43', 'observed:codex-app:mixed-44',
        ]));
        await settle();
      }
      expect(observer.diagnostics().codexRolloutReadFailures).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats a partial nonempty lsof frame as unknown, but accepts a known process with no rollout', () => {
    expect(() => parseLsofRolloutProbe('p42\nn/tmp/rollout-a.jsonl\n', [42, 99])).toThrow('Incomplete');
    expect(parseLsofRolloutProbe('p42\nn/bin/codex\n', [42])).toEqual(new Map());
  });

  it('retains the process table when a scan comes back empty', async () => {
    let processes = table;
    const observer = new PassiveSessionObserver(async () => processes);

    observer.collect([]);
    await settle();
    expect(observer.processes()).toEqual(table);

    // collectProcessInfo() reports a timeout, a spawn failure or unparseable
    // output as [] rather than throwing — and no running machine has zero
    // processes. Concluding "every session ended" from that is what emptied
    // the roster on a Windows host whose WMI query timed out on every scan.
    processes = [];
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    observer.collect([]);
    await settle();
    expect(observer.processes()).toEqual(table);
  });

  it('retains the last roster when a scan rejects', async () => {
    const seeded = [{ id: 'observed:claude:abc', agentType: 'claude-code' }];
    let fail = false;
    const observer = new PassiveSessionObserver(async () => {
      if (fail) throw new Error('ps: cannot read process table');
      return table;
    });
    // Seed the cache directly: building a real observed session needs a
    // transcript on disk, and the behaviour under test is the failure path.
    (observer as unknown as { cached: unknown[] }).cached = seeded;

    fail = true;
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    expect(observer.collect([])).toEqual(seeded);
    await settle();
    expect(observer.collect([])).toEqual(seeded);
  });

  it('backs the scan cadence off to the cost of the last scan', () => {
    // A fast host keeps the 5s floor…
    expect(nextScanIntervalMs(0)).toBe(5_000);
    expect(nextScanIntervalMs(200)).toBe(5_000);
    // …a host where the process table costs ~11s does not run scans
    // back-to-back forever…
    expect(nextScanIntervalMs(11_000)).toBe(11_000);
    // …and a pathological host is still rescanned within the ceiling.
    expect(nextScanIntervalMs(10 * 60_000)).toBe(60_000);
    expect(nextScanIntervalMs(Number.NaN)).toBe(5_000);
  });

  it.each([
    { duration: 200, cooldown: 4_800, rejects: false },
    { duration: 11_000, cooldown: 11_000, rejects: false },
    { duration: 30_000, cooldown: 30_000, rejects: true },
    { duration: 70_000, cooldown: 60_000, rejects: false },
  ])('schedules a $duration ms scan with $cooldown ms remaining (rejects=$rejects)', async ({ duration, cooldown, rejects }) => {
    vi.useFakeTimers({ now: 100_000 });
    const reader = vi.fn(() => new Promise<never[]>((resolve, reject) => {
      setTimeout(() => rejects ? reject(new Error('scan unavailable')) : resolve([]), duration);
    }));
    const observer = new PassiveSessionObserver(reader);
    observer.collect([]);
    observer.collect([]);
    expect(reader).toHaveBeenCalledTimes(1); // no overlapping scan
    await vi.advanceTimersByTimeAsync(duration);
    observer.collect([]);
    expect(reader).toHaveBeenCalledTimes(1); // completion is not a new scan
    await vi.advanceTimersByTimeAsync(cooldown - 1);
    observer.collect([]);
    expect(reader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    observer.collect([]);
    expect(reader).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(duration);
  });
});

describe('foldHeadlessCodexSessions', () => {
  const CWD = '/tmp/scratch/gen/work/2020s_ai_ai';
  const claudeRow = {
    id: 'observed:claude:4f55869a-38a5-494c-8577-7afad72aae35',
    port: 0, pid: 71456, projectName: 'epoch-of-tech', agentType: 'claude-code' as const,
    alive: true, state: 'processing' as const, controlMode: 'observed' as const,
  };
  const execRow = {
    id: 'observed:codex:01a0f35b-74a5-7bc0-827d-ef80f440478e',
    port: 0, pid: 49460, projectName: '2020s_ai_ai', agentType: 'codex-cli' as const,
    alive: true, state: 'processing' as const, controlMode: 'observed' as const,
    cwd: CWD, startedAt: '2026-09-30T17:27:32.000Z', goal: 'write the chapter',
    codexOriginator: 'codex_exec',
  };
  const table: ProcInfo[] = [
    { pid: 71456, ppid: 1872, rssKb: 1, command: 'claude' },
    { pid: 17384, ppid: 71456, rssKb: 1, command: 'xargs -P 4 -I{} bash -c gen_one {}' },
    { pid: 49451, ppid: 17384, rssKb: 1, command: `timeout 1500 codex exec -C ${CWD} -` },
    { pid: 49460, ppid: 49451, rssKb: 1, command: `/x/bin/codex exec -C ${CWD} -` },
  ];

  it('drops a headless run that descends from an observed session and reports it as that session\'s child', () => {
    const { roster, execChildren } = foldHeadlessCodexSessions([claudeRow, execRow], table);
    expect(roster.map((s) => s.id)).toEqual([claudeRow.id]);
    expect(execChildren).toEqual([{
      sessionId: '01a0f35b-74a5-7bc0-827d-ef80f440478e',
      pid: 49460,
      cwd: CWD,
      parent: { sessionId: '4f55869a-38a5-494c-8577-7afad72aae35', pid: 71456, agentType: 'claude-code', projectName: 'epoch-of-tech' },
      startedAt: Date.parse('2026-09-30T17:27:32.000Z'),
      goal: 'write the chapter',
    }]);
  });

  it('keeps a headless run with no session ancestor as a row, reported with parent null', () => {
    const orphanTable: ProcInfo[] = [
      { pid: 500, ppid: 1, rssKb: 1, command: '/bin/zsh' },
      { pid: 49460, ppid: 500, rssKb: 1, command: `/x/bin/codex exec -C ${CWD} -` },
    ];
    const { roster, execChildren } = foldHeadlessCodexSessions([claudeRow, execRow], orphanTable);
    expect(roster.map((s) => s.id)).toEqual([claudeRow.id, execRow.id]);
    expect(execChildren[0]?.parent).toBeNull();
  });

  it('never leaks codexOriginator onto a roster row and leaves TUI/desktop rows alone', () => {
    const tui = { ...execRow, id: 'observed:codex:tui', codexOriginator: 'codex-tui' };
    const { roster, execChildren } = foldHeadlessCodexSessions([claudeRow, tui], table);
    expect(roster).toHaveLength(2);
    expect(execChildren).toEqual([]);
    for (const row of roster) expect(row).not.toHaveProperty('codexOriginator');
  });
});

describe('selectClaudeConversationFiles', () => {
  const file = (over: Partial<ClaudeSessionFile> & { pid: number; sessionId: string }): { file: ClaudeSessionFile } => ({
    file: { cwd: '/Users/robin/OpenClaw', startedAt: 1, kind: 'interactive', spare: false, ...over },
  });
  const ids = (rows: Array<{ file: ClaudeSessionFile }>) => rows.map((row) => row.file.sessionId);

  it('shows the background job instead of the window it was moved out of, and never a spare', () => {
    // The live 2026-10-10 shape: the window parked into job 5b55b9d6 and a
    // pre-warmed spare in the same cwd. Before, the deck showed the parked
    // window and the spare as two idle OpenClaw rows and no working one.
    const rows = [
      file({ pid: 2237, sessionId: 'd385adf6', parkedJobId: '5b55b9d6' }),
      file({ pid: 28723, sessionId: '5b55b9d6-c0e9', kind: 'bg', jobId: '5b55b9d6' }),
      file({ pid: 28616, sessionId: '64cf355f', kind: 'bg', jobId: '64cf355f', spare: true }),
    ];
    expect(ids(selectClaudeConversationFiles(rows))).toEqual(['5b55b9d6-c0e9']);
  });

  it('keeps a parked window whose job is not visibly alive', () => {
    // A stale parkedJobId is no evidence the window is empty.
    const rows = [file({ pid: 2237, sessionId: 'd385adf6', parkedJobId: '5b55b9d6' })];
    expect(ids(selectClaudeConversationFiles(rows))).toEqual(['d385adf6']);
  });

  it('a spare cannot stand in for the job a window parked into', () => {
    const rows = [
      file({ pid: 2237, sessionId: 'd385adf6', parkedJobId: '64cf355f' }),
      file({ pid: 28616, sessionId: '64cf355f', kind: 'bg', jobId: '64cf355f', spare: true }),
    ];
    expect(ids(selectClaudeConversationFiles(rows))).toEqual(['d385adf6']);
  });

  it('keeps independent background jobs and ordinary windows', () => {
    const rows = [
      file({ pid: 1, sessionId: 'a' }),
      file({ pid: 2, sessionId: 'b', kind: 'bg', jobId: 'b' }),
    ];
    expect(ids(selectClaudeConversationFiles(rows))).toEqual(['a', 'b']);
  });
});


describe('Claude identity read continuity', () => {
  let directory: string | undefined;
  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function settle(): Promise<void> { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
  async function fixture() {
    directory = mkdtempSync(join(tmpdir(), 'agentdeck-claude-continuity-'));
    vi.stubEnv('HOME', directory); vi.stubEnv('CLAUDE_CONFIG_DIR', join(directory, '.claude'));
    const path = join(directory, '.claude', 'sessions', '43210.json');
    mkdirSync(join(directory, '.claude', 'sessions'), { recursive: true });
    const file = { pid: 43210, sessionId: 'continuity-session', cwd: directory, startedAt: Date.now() };
    writeFileSync(path, JSON.stringify(file));
    let processes: ProcInfo[] = [{ pid: 43210, ppid: 1, rssKb: 1024, command: 'claude' }];
    // This fixture owns a synthetic process table, including its exit signal;
    // never consult an unrelated real machine PID that happens to be 43210.
    const observer = new PassiveSessionObserver(async () => processes,
      async pids => ({ processes: [], exited: pids.length, unknownPids: [] }));
    observer.collect([]); await settle();
    expect(observer.collect([]).map(s => s.id)).toEqual(['observed:claude:continuity-session']);
    const scan = async () => { vi.useFakeTimers({ now: Date.now() + 60_000 }); observer.collect([]); await settle(); return observer.collect([]); };
    return { path, file, observer, scan, setProcesses: (next: ProcInfo[]) => { processes = next; } };
  }

  it('retains a known live Claude when its session file is temporarily malformed or missing', async () => {
    const f = await fixture();
    writeFileSync(f.path, '{"pid":');
    expect((await f.scan()).map(s => s.id)).toEqual(['observed:claude:continuity-session']);
    expect(f.observer.diagnostics().claudeIdentityReads).toEqual({ candidates: 1, unreadable: 1, retained: 1 });
    rmSync(f.path);
    expect((await f.scan()).map(s => s.id)).toEqual(['observed:claude:continuity-session']);
    writeFileSync(f.path, JSON.stringify({ ...f.file, sessionId: 'replacement' }));
    expect((await f.scan()).map(s => s.id)).toEqual(['observed:claude:replacement']);
    expect(f.observer.diagnostics().claudeIdentityReads.retained).toBe(0);
  });

  it('still removes an ended process and never invents an identity for an unreadable new process', async () => {
    const f = await fixture(); rmSync(f.path);
    f.setProcesses([{ pid: 1, ppid: 0, rssKb: 1024, command: '/sbin/launchd' },
      { pid: 43211, ppid: 1, rssKb: 1024, command: 'claude' }]);
    expect(await f.scan()).toEqual([]);
    expect(f.observer.diagnostics().claudeIdentityReads.retained).toBe(0);
  });

  it('does not retain an explicitly spare process or one that execed another command', async () => {
    const f = await fixture();
    writeFileSync(f.path, JSON.stringify({ ...f.file, spare: true }));
    expect(await f.scan()).toEqual([]);
    writeFileSync(f.path, JSON.stringify(f.file)); await f.scan();
    f.setProcesses([{ pid: 43210, ppid: 1, rssKb: 1024, command: '/bin/zsh' }]);
    expect(await f.scan()).toEqual([]);
  });
});


describe('Codex explicit terminal evidence', () => {
  const event = (type: string, at?: number, turnId?: string) => ({
    type: 'event_msg', timestamp: at === undefined ? undefined : new Date(at).toISOString(), payload: { type, turn_id: turnId },
  });
  it('rejects an old turn id or time after a newer start', () => {
    for (const end of [event('task_complete', 3_000, 'old'), event('task_complete', 1_000, 'new')]) {
      const summary = parseCodexRollout(jsonl([event('task_started', 2_000, 'new'), end]));
      expect(summary.state).toBe('processing');
      expect(summary.terminalEvent).toBeUndefined();
    }
  });
  it('keeps the current task_started id through its id-less user message', () => {
    const summary = parseCodexRollout(jsonl([
      event('task_started', 2_000, 'new'), event('user_message', 2_100),
      event('task_complete', 3_000, 'old'),
    ]));
    expect(summary.state).toBe('processing');
    expect(summary.terminalEvent).toBeUndefined();
  });
  it('does not carry a prior turn id across a sampled user-message boundary', () => {
    const summary = parseCodexRollout(jsonl([
      event('task_started', 1_000, 'old'), event('task_complete', 2_000, 'old'),
      event('user_message', 3_000), event('task_complete', 4_000, 'new'),
    ]));
    expect(summary.state).toBe('idle');
    expect(summary.terminalEvent).toEqual({ type: 'task_complete', at: 4_000 });
  });
});
