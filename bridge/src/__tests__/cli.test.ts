import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  program,
  resolveEsp32OtaDaemonTarget,
  ESP32_OTA_BY_TARGET,
  tokenizeArgString,
  applyGlobalEnvArgs,
  weaveAgentCommand,
  resolveAgentCommand,
} from '../cli.js';

// The claude action dynamically imports './index.js' (same module id as this
// '../index.js') to reach startSession. The explicit factory matters:
// a factory-less automock would evaluate the real index.ts module graph
// (node-pty native binding, better-sqlite3, adapters) just to derive shapes.
const { startSessionMock } = vi.hoisted(() => ({
  startSessionMock: vi.fn(async () => {}),
}));
vi.mock('../index.js', () => ({ startSession: startSessionMock }));

describe('agentdeck CLI parser', () => {
  it('reports a misspelled top-level command as unknown and suggests the closest command', () => {
    let stderr = '';
    program.configureOutput({
      writeErr: (str) => {
        stderr += str;
      },
    });
    program.exitOverride();

    let thrown: unknown;
    try {
      program.parse(['node', 'agentdeck', 'tomebox']);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      code: 'commander.unknownCommand',
      exitCode: 1,
    });

    expect(stderr).toContain("error: unknown command 'tomebox'");
    expect(stderr).toContain('(Did you mean timebox?)');
    expect(stderr).not.toContain('too many arguments');
  });
});

// The esp32-ota `target` is dual-purpose (local pio env vs. daemon device_info.board
// match). Short aliases must resolve to the canonical board string before the
// upload POST, or they build fine but fail the daemon match. Regression guard.
describe('esp32-ota target resolution', () => {
  it('maps short aliases to their canonical device_info.board string', () => {
    expect(resolveEsp32OtaDaemonTarget('ttgo')).toBe('ttgo_t_display');
    expect(resolveEsp32OtaDaemonTarget('amoled')).toBe('round_amoled');
    expect(resolveEsp32OtaDaemonTarget('ips35')).toBe('ips_35');
    expect(resolveEsp32OtaDaemonTarget('led8x32')).toBe('ulanzi_tc001');
    expect(resolveEsp32OtaDaemonTarget('box_40')).toBe('86box');
    expect(resolveEsp32OtaDaemonTarget('box_86')).toBe('86box');
    expect(resolveEsp32OtaDaemonTarget('ips10')).toBe('ips_10');
    expect(resolveEsp32OtaDaemonTarget('ips_101')).toBe('ips_10');
  });

  it('leaves a canonical board string unchanged', () => {
    expect(resolveEsp32OtaDaemonTarget('ttgo_t_display')).toBe('ttgo_t_display');
    expect(resolveEsp32OtaDaemonTarget('inkdeck')).toBe('inkdeck');
    expect(resolveEsp32OtaDaemonTarget('86box')).toBe('86box');
  });

  it('passes an unknown target (e.g. a raw IP) through untouched for IP targeting', () => {
    expect(resolveEsp32OtaDaemonTarget('192.168.68.64')).toBe('192.168.68.64');
  });

  it('every alias resolves to a board that is itself a canonical entry (self-consistent SSOT)', () => {
    const canonical = new Set(Object.values(ESP32_OTA_BY_TARGET).map(v => v.board));
    for (const { board } of Object.values(ESP32_OTA_BY_TARGET)) {
      expect(canonical.has(board)).toBe(true);
      expect(ESP32_OTA_BY_TARGET[board]?.board).toBe(board);
    }
  });

  it('drops the retired esp32_c6_147 board from the OTA target set', () => {
    expect(ESP32_OTA_BY_TARGET['esp32_c6_147']).toBeUndefined();
    expect(ESP32_OTA_BY_TARGET['c6_147']).toBeUndefined();
  });
});

// Env-var default CLI args: global AGENTDECK_COMMANDER_ARGS (agentdeck/commander
// layer) + per-agent AGENTDECK_<AGENT>_ARGS (spawned agent command).
describe('tokenizeArgString', () => {
  it('splits bare flags on whitespace', () => {
    expect(tokenizeArgString('--remote-daemon --daemon-host u2.lan'))
      .toEqual(['--remote-daemon', '--daemon-host', 'u2.lan']);
  });

  it('collapses runs of whitespace and trims', () => {
    expect(tokenizeArgString('  -a   -b  ')).toEqual(['-a', '-b']);
  });

  it('keeps a quoted value with spaces as one token', () => {
    expect(tokenizeArgString('--daemon-host "a b"')).toEqual(['--daemon-host', 'a b']);
    expect(tokenizeArgString("--msg 'hello world'")).toEqual(['--msg', 'hello world']);
  });

  it('returns [] for empty or undefined', () => {
    expect(tokenizeArgString('')).toEqual([]);
    expect(tokenizeArgString(undefined)).toEqual([]);
    expect(tokenizeArgString('   ')).toEqual([]);
  });
});

describe('applyGlobalEnvArgs', () => {
  const base = ['node', 'agentdeck'];

  it('splices env tokens immediately after the session subcommand', () => {
    const out = applyGlobalEnvArgs([...base, 'claude'], {
      AGENTDECK_COMMANDER_ARGS: '--remote-daemon --daemon-host u2.lan',
    });
    expect(out).toEqual([...base, 'claude', '--remote-daemon', '--daemon-host', 'u2.lan']);
  });

  it('inserts env tokens before user-typed flags (scalar options: retyping wins on last-write)', () => {
    const out = applyGlobalEnvArgs([...base, 'claude', '-c', 'claude --resume X'], {
      AGENTDECK_COMMANDER_ARGS: '--daemon-host h:9120',
    });
    expect(out).toEqual([...base, 'claude', '--daemon-host', 'h:9120', '-c', 'claude --resume X']);
  });

  it('applies to monitor as well', () => {
    const out = applyGlobalEnvArgs([...base, 'monitor'], {
      AGENTDECK_COMMANDER_ARGS: '--local',
    });
    expect(out).toEqual([...base, 'monitor', '--local']);
  });

  it('is a no-op for non-session commands', () => {
    const argv = [...base, 'daemon', 'start'];
    expect(applyGlobalEnvArgs(argv, { AGENTDECK_COMMANDER_ARGS: '--remote-daemon' })).toEqual(argv);
  });

  it('is a no-op for a non-session command whose positional VALUE is a session word', () => {
    // The reviewer's exact shape: `claude` is the <text> positional of `speak`.
    // The decision keys on argv[2], never on a token scan.
    const argv = [...base, 'speak', 'board1', 'claude'];
    expect(applyGlobalEnvArgs(argv, { AGENTDECK_COMMANDER_ARGS: '--local' })).toEqual(argv);
  });

  it('is a no-op when the var is unset or empty', () => {
    const argv = [...base, 'claude'];
    expect(applyGlobalEnvArgs(argv, {})).toEqual(argv);
    expect(applyGlobalEnvArgs(argv, { AGENTDECK_COMMANDER_ARGS: '' })).toEqual(argv);
  });

  it('does not match a session word that appears as a flag value', () => {
    // `claude` here is the value of -c on a `codex` session, not the subcommand.
    const argv = [...base, 'codex', '-c', 'claude'];
    const out = applyGlobalEnvArgs(argv, { AGENTDECK_COMMANDER_ARGS: '--local' });
    expect(out).toEqual([...base, 'codex', '--local', '-c', 'claude']);
  });

  it('skips the splice entirely when the user typed --no-env-args', () => {
    const argv = [...base, 'claude', '--no-env-args'];
    expect(applyGlobalEnvArgs(argv, { AGENTDECK_COMMANDER_ARGS: '--local' })).toEqual(argv);
  });

  it('strips an env-smuggled --no-env-args instead of letting it half-disable the layers', () => {
    // The hatch is a typed-only override: from the env var it would splice
    // normally, then parse to envArgs=false and silently turn off only the
    // per-agent layer. Stripped, the remaining env tokens still apply.
    const out = applyGlobalEnvArgs([...base, 'claude'], {
      AGENTDECK_COMMANDER_ARGS: '--local --no-env-args',
    });
    expect(out).toEqual([...base, 'claude', '--local']);
  });
});

describe('weaveAgentCommand', () => {
  it('appends the per-agent var to the default command', () => {
    expect(weaveAgentCommand('claude-code', 'claude', { AGENTDECK_CLAUDE_ARGS: '--remote-control' }))
      .toBe('claude --remote-control');
  });

  it('appends onto an explicit -c command without replacing it', () => {
    expect(
      weaveAgentCommand('claude-code', 'claude --resume 0000-0000', {
        AGENTDECK_CLAUDE_ARGS: '--remote-control',
      }),
    ).toBe('claude --resume 0000-0000 --remote-control');
  });

  it('uses the agent-specific var and ignores others', () => {
    const env = { AGENTDECK_CLAUDE_ARGS: '--x', AGENTDECK_CODEX_ARGS: '--y', AGENTDECK_OPENCODE_ARGS: '--z' };
    expect(weaveAgentCommand('claude-code', 'claude', env)).toBe('claude --x');
    expect(weaveAgentCommand('codex-cli', 'codex', env)).toBe('codex --y');
    expect(weaveAgentCommand('opencode', 'opencode', env)).toBe('opencode --z');
  });

  it('returns the command unchanged when the var is unset or blank', () => {
    expect(weaveAgentCommand('claude-code', 'claude', {})).toBe('claude');
    expect(weaveAgentCommand('claude-code', 'claude', { AGENTDECK_CLAUDE_ARGS: '   ' })).toBe('claude');
  });
});

describe('resolveAgentCommand (per-agent half of the --no-env-args hatch)', () => {
  const env = { AGENTDECK_CLAUDE_ARGS: '--remote-control' };

  it('weaves when env args are enabled', () => {
    expect(resolveAgentCommand('claude-code', 'claude', true, env)).toBe('claude --remote-control');
  });

  it('returns the command untouched when the hatch disabled env args', () => {
    expect(resolveAgentCommand('claude-code', 'claude', false, env)).toBe('claude');
  });
});

// The reviewer-required level: prove the env-default/override contract through
// ACTUAL option parsing of the real registered `claude` subcommand — not by
// asserting the transformed argv array. `parseOptions` parses against the real
// declarations without running the action (preferred here for isolation; the
// file-level mock of ../index.js means no parse in this file can start a real
// session). Tokens come from applyGlobalEnvArgs, so the full env→splice→parse
// pipeline is what's asserted.
describe('env defaults through real option parsing', () => {
  const base = ['node', 'agentdeck'];
  const claudeCmd = () => {
    const cmd = program.commands.find((c) => c.name() === 'claude');
    if (!cmd) throw new Error('claude subcommand not registered');
    return cmd;
  };

  // parseOptions does NOT self-manage state (parse/parseAsync do, via
  // _prepareForParse). Save the clean registration-time state exactly once —
  // a re-save while state is contaminated would bake the contamination into
  // every later restore — and restore in afterEach so a failing assertion
  // cannot leak parsed values into the next test.
  beforeAll(() => {
    claudeCmd().saveStateBeforeParse();
  });
  afterEach(() => {
    claudeCmd().restoreStateBeforeParse();
  });

  function parseCommanderTokens(argv: string[], env: NodeJS.ProcessEnv): ReturnType<typeof claudeCmd> {
    const cmd = claudeCmd();
    cmd.parseOptions(applyGlobalEnvArgs(argv, env).slice(3));
    return cmd;
  }

  it('an env-provided boolean flag sticks as the default', () => {
    const cmd = parseCommanderTokens([...base, 'claude'], { AGENTDECK_COMMANDER_ARGS: '--local' });
    expect(cmd.opts().local).toBe(true);
    expect(cmd.opts().envArgs).toBe(true);
  });

  it('--no-env-args genuinely overrides an env boolean per-invocation', () => {
    const cmd = parseCommanderTokens([...base, 'claude', '--no-env-args'], {
      AGENTDECK_COMMANDER_ARGS: '--local',
    });
    expect(cmd.opts().local).toBeUndefined();
    expect(cmd.opts().envArgs).toBe(false);
  });

  it('a retyped scalar option wins over the env default (last-write through parseArg)', () => {
    const cmd = parseCommanderTokens([...base, 'claude', '--weight', '2'], {
      AGENTDECK_COMMANDER_ARGS: '--weight 5',
    });
    expect(cmd.opts().weight).toBe(2);
  });
});

// Action-wiring end-to-end: the only level that catches an inverted predicate
// (opts.envArgs === false vs !== false) between commander and
// resolveAgentCommand. parseAsync self-manages parser state; the real action
// runs with the mocked startSession. NOTE this block must stay AFTER the
// parseOptions block in file order — parseAsync leaves parsed option values on
// the subcommand until the next parse's lazy restore, and an earlier run here
// would contaminate that block's beforeAll snapshot.
describe('claude action wiring (parseAsync end-to-end)', () => {
  const base = ['node', 'agentdeck'];

  // parseAsync leaves parsed option values on the claude subcommand until the
  // NEXT parse's lazy restore — fine while this is the file's last describe
  // (vitest isolates files), but a block appended below would inherit them.
  afterEach(() => {
    startSessionMock.mockClear();
    vi.unstubAllEnvs();
  });

  it('without the hatch: env flags parse in and the agent command is woven', async () => {
    // The real action reads the per-agent var from actual process.env — a
    // local env object cannot reach it, hence the stub.
    vi.stubEnv('AGENTDECK_CLAUDE_ARGS', '--remote-control');
    const env = { AGENTDECK_COMMANDER_ARGS: '--local' };
    await program.parseAsync(applyGlobalEnvArgs([...base, 'claude'], env));
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    const opts = startSessionMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.command).toBe('claude --remote-control');
    expect(opts.modules).toEqual({ mdns: false, adb: false, serial: false, pixoo: false, timebox: false });
  });

  it('--no-env-args disables BOTH layers for the invocation', async () => {
    vi.stubEnv('AGENTDECK_CLAUDE_ARGS', '--remote-control');
    const env = { AGENTDECK_COMMANDER_ARGS: '--local' };
    await program.parseAsync(applyGlobalEnvArgs([...base, 'claude', '--no-env-args'], env));
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    const opts = startSessionMock.mock.calls[0][0] as Record<string, unknown>;
    // Per-agent layer off: command unwoven despite the stubbed var.
    expect(opts.command).toBe('claude');
    // Commander layer off: the env --local never reached the parser.
    expect((opts.modules as Record<string, unknown>).adb).toBe('auto');
  });
});
