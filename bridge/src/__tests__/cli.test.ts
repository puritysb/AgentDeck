import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  program,
  resolveEsp32OtaDaemonTarget,
  resolveOtaIdentityFromManifest,
  inlineOtaPayload,
  ESP32_OTA_BY_TARGET,
  tokenizeArgString,
  applyGlobalEnvArgs,
  weaveAgentCommand,
  resolveAgentCommand,
  daemonPostureArgs,
  buildPlist,
  isWorktreeCheckoutPath,
  waitForRestartedDaemon,
  managedPtyCompatibilityNotice,
} from '../cli.js';
import { allModulesOff } from '../modules/types.js';

// The claude action dynamically imports './index.js' (same module id as this
// '../index.js') to reach startSession. The explicit factory matters:
// a factory-less automock would evaluate the real index.ts module graph
// (node-pty native binding, better-sqlite3, adapters) just to derive shapes.
const { startSessionMock } = vi.hoisted(() => ({
  startSessionMock: vi.fn(async () => {}),
}));
vi.mock('../index.js', () => ({ startSession: startSessionMock }));

describe('agentdeck CLI parser', () => {
  it('registers a weather command with set/show/clear subcommands', () => {
    const weather = program.commands.find((command) => command.name() === 'weather');
    expect(weather?.commands.map((command) => command.name())).toEqual(['set', 'show', 'clear']);
  });

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

  it('marks every managed per-session command as legacy compatibility in --help metadata', () => {
    for (const name of ['claude', 'codex', 'opencode', 'monitor']) {
      const command = program.commands.find((candidate) => candidate.name() === name);
      expect(command?.description()).toContain('[legacy compatibility]');
    }
  });
});

describe('managed PTY compatibility contract', () => {
  it.each(['claude', 'codex', 'opencode'] as const)(
    'points agentdeck %s users to daemon-first direct launch',
    (command) => {
      const notice = managedPtyCompatibilityNotice(command).join('\n');
      expect(notice).toContain(`agentdeck ${command}`);
      expect(notice).toContain('agentdeck daemon install');
      expect(notice).toContain(`run \`${command}\` directly`);
      expect(notice).toContain('AGENTDECK_<AGENT>_ARGS');
      expect(notice).toContain('No removal date is set');
      expect(notice).toContain('discussions/278');
      expect(notice).toContain('issues/273');
      expect(notice).not.toContain('will be removed');
    },
  );

  it('points monitor users to all normal agent entry points', () => {
    const notice = managedPtyCompatibilityNotice('monitor').join('\n');
    expect(notice).toContain('agentdeck monitor');
    expect(notice).toContain('run `claude`, `codex`, or `opencode` normally');
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
    expect(resolveEsp32OtaDaemonTarget('trmnl_75')).toBe('trmnl_75');
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

describe('esp32-ota manifest identity resolution', () => {
  it('selects one exact product + board + channel tuple', () => {
    const fixture = new URL('../../../schemas/surface-protocol/v1/fixtures/pocket-daily-reader.json', import.meta.url);
    expect(resolveOtaIdentityFromManifest(fixture.pathname, 'xteink_x3')).toEqual({
      productId: 'io.pocketdaily.reader', board: 'xteink_x3', updateChannel: 'stable',
    });
  });

  it('fails instead of guessing when a board has no registered identity', () => {
    const fixture = new URL('../../../schemas/surface-protocol/v1/fixtures/pocket-daily-reader.json', import.meta.url);
    expect(() => resolveOtaIdentityFromManifest(fixture.pathname, 'ttgo_t_display'))
      .toThrow(/no OTA identity/);
  });
});

describe('esp32-ota sandbox retry payload', () => {
  it('preserves stage and the exact Surface namespace on inline retry', () => {
    expect(inlineOtaPayload('xteink_x3', 'ZmlybXdhcmU=', {
      stage: true,
      identity: {
        productId: 'io.pocketdaily.reader', board: 'xteink_x3', updateChannel: 'stable',
      },
    })).toEqual({
      target: 'xteink_x3', firmwareB64: 'ZmlybXdhcmU=', stage: true,
      productId: 'io.pocketdaily.reader', board: 'xteink_x3', updateChannel: 'stable',
    });
  });

  it('keeps the live retry a live OTA request', () => {
    expect(inlineOtaPayload('trmnl_75', 'AA==')).toEqual({
      target: 'trmnl_75', firmwareB64: 'AA==',
    });
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

  // #273 "Custom launch arguments": the woven string is re-parsed by the
  // platform shell at spawn (PtyManager uses `$SHELL -l -c` / `cmd.exe /d /s
  // /c`), so the weave's contract is that it appends and otherwise keeps its
  // hands off. Quoting or escaping here would corrupt a command the user wrote
  // for their own shell, and the damage would only appear at spawn time.
  it('leaves the user\'s shell quoting and metacharacters untouched', () => {
    expect(
      weaveAgentCommand('claude-code', 'claude --resume "my session"', {
        AGENTDECK_CLAUDE_ARGS: '--remote-control',
      }),
    ).toBe('claude --resume "my session" --remote-control');

    expect(
      weaveAgentCommand('codex-cli', 'cd $HOME/work && codex', {
        AGENTDECK_CODEX_ARGS: '--full-auto',
      }),
    ).toBe('cd $HOME/work && codex --full-auto');
  });

  it('does not re-quote a Windows-style command', () => {
    expect(
      weaveAgentCommand('claude-code', 'C:\\Program Files\\claude\\claude.exe', {
        AGENTDECK_CLAUDE_ARGS: '--remote-control',
      }),
    ).toBe('C:\\Program Files\\claude\\claude.exe --remote-control');
  });

  // The env value itself is appended raw — it is NOT tokenized (that is
  // AGENTDECK_COMMANDER_ARGS' job). A quoted value must therefore survive with
  // its quotes intact for the shell to group it.
  it('appends a quoted env value verbatim rather than tokenizing it', () => {
    expect(
      weaveAgentCommand('claude-code', 'claude', {
        AGENTDECK_CLAUDE_ARGS: '--append-system-prompt "be terse"',
      }),
    ).toBe('claude --append-system-prompt "be terse"');
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
describe('daemon autostart posture', () => {
  it('--enterprise is the admin spelling of the loopback posture', () => {
    expect(daemonPostureArgs({ enterprise: true })).toEqual(['--loopback']);
    expect(daemonPostureArgs({ loopback: true })).toEqual(['--loopback']);
  });

  it('does not fold --local into --enterprise', () => {
    // They answer different questions: --local is "no hardware", --enterprise
    // is "no LAN behaviour at all". Some sites want hardware on a lab subnet
    // with discovery off, so the two must remain independently selectable.
    expect(daemonPostureArgs({ enterprise: true })).not.toContain('--local');
    expect(daemonPostureArgs({ local: true })).toEqual(['--local']);
    expect(daemonPostureArgs({ local: true, enterprise: true })).toEqual(['--local', '--loopback']);
  });

  it('a plain install carries no posture flags', () => {
    expect(daemonPostureArgs({})).toEqual([]);
  });

  it('the LaunchAgent argv carries the posture, one <string> per flag', () => {
    const plist = buildPlist(['--loopback']);
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>--foreground</string>');
    expect(plist).toContain('<string>--loopback</string>');
    // Order matters: the flags must follow the subcommand, not precede it.
    expect(plist.indexOf('<string>--loopback</string>')).toBeGreaterThan(
      plist.indexOf('<string>--foreground</string>'),
    );
  });

  it('a plain LaunchAgent is byte-identical to the pre-posture one', () => {
    expect(buildPlist()).toBe(buildPlist([]));
    expect(buildPlist()).not.toContain('--loopback');
  });
});

describe('worktree checkout guard (autostart/plugin installs)', () => {
  // 2026-09-19 incident: `streamdeck link` + CLI link + daemon install ran from
  // the luna-reserve worktree; merging it removed the directory and the plugin
  // symlink dangled, silently killing every Stream Deck status key.
  it('classifies a worktree path by path segment', () => {
    expect(
      isWorktreeCheckoutPath('/Users/x/github/AgentDeck/__worktrees/luna-reserve/bridge/dist/cli.js'),
    ).toBe(true);
  });

  it('accepts the main checkout and npm-global install paths', () => {
    expect(isWorktreeCheckoutPath('/Users/x/github/AgentDeck/bridge/dist/cli.js')).toBe(false);
    expect(isWorktreeCheckoutPath('/opt/homebrew/bin/agentdeck')).toBe(false);
  });

  it('matches only the whole path segment, not a substring of another name', () => {
    expect(isWorktreeCheckoutPath('/Users/x/__worktrees_archive/bridge/dist/cli.js')).toBe(false);
  });

  it('classifies Windows-style paths on any platform', () => {
    expect(isWorktreeCheckoutPath('C:\\repo\\AgentDeck\\__worktrees\\task-1\\bridge\\dist\\cli.js')).toBe(true);
    expect(isWorktreeCheckoutPath('C:\\Users\\x\\AppData\\Roaming\\npm\\agentdeck')).toBe(false);
  });
});

describe('claude action wiring (parseAsync end-to-end)', () => {
  const base = ['node', 'agentdeck'];

  // parseAsync leaves parsed option values on the claude subcommand until the
  // NEXT parse's lazy restore — fine while this is the file's last describe
  // (vitest isolates files), but a block appended below would inherit them.
  afterEach(() => {
    startSessionMock.mockClear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prints the compatibility notice before starting the still-functional bridge', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await program.parseAsync([...base, 'claude', '--no-env-args']);

    expect(startSessionMock).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('LEGACY COMPATIBILITY MODE'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('agentdeck daemon install'));
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
    // Every registered module, not the five that used to be listed by hand:
    // `broadcast` and `idotmatrix` were missing, and initModules() reads an
    // absent key as 'auto' — so --local still spawned the iDotMatrix BLE client.
    expect(opts.modules).toEqual(allModulesOff());
    expect((opts.modules as Record<string, unknown>).idotmatrix).toBe(false);
    expect((opts.modules as Record<string, unknown>).broadcast).toBe(false);
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

  it('a session bridge drives no device but ADB, even without --local', async () => {
    // Not a --local concern: initModules() reads an absent key as 'auto', so
    // every module added after this record was written arrived switched ON in
    // ordinary sessions. idotmatrix did, and each session bridge spawned its
    // own Python BLE client alongside the daemon's.
    await program.parseAsync([...base, 'claude', '--no-env-args']);
    const opts = startSessionMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.modules).toEqual({ ...allModulesOff(), adb: 'auto' });
  });
});

describe('waitForRestartedDaemon — `daemon restart` reports what it measured', () => {
  const noInfo = () => null;
  const noPort = () => null;
  /** The daemon this command stopped. Every case has one; a restart implies it. */
  const STOPPED = 36318;

  const wait = (over: Partial<Parameters<typeof waitForRestartedDaemon>[0]> = {}) =>
    waitForRestartedDaemon({
      spawnedPid: 4242,
      stoppedPid: STOPPED,
      preferredPort: 9120,
      probeHealth: async () => null,
      readDaemonInfo: noInfo,
      findDaemonPort: noPort,
      timeoutMs: 400,
      ...over,
    });

  it('returns no-daemon when nothing ever answers', async () => {
    // The defect this replaced: `spawn()` resolving a pid was treated as proof
    // the daemon started, so a child that died on EADDRINUSE was still
    // announced as `Daemon restarted (PID …)` and the real reason sat unread
    // in the daemon log.
    const probeHealth = vi.fn(async () => null);
    expect(await wait({ probeHealth })).toEqual({ ok: false, reason: 'no-daemon' });
    expect(probeHealth).toHaveBeenCalled();
  });

  it('does NOT accept the daemon it was trying to replace', async () => {
    // A port probe alone is satisfied by the OLD daemon when the stop silently
    // failed — which would report a restart that never happened. Rejecting the
    // stopped pid is the whole reason a pid is compared at all.
    const probeHealth = vi.fn(async () => ({ pid: STOPPED }));
    expect(await wait({ probeHealth }))
      .toEqual({ ok: false, reason: 'stop-failed', pid: STOPPED, port: 9120 });
  });

  it('accepts the spawned pid on the preferred port', async () => {
    const probeHealth = vi.fn(async (port: number) => (port === 9120 ? { pid: 4242 } : null));
    expect(await wait({ probeHealth, timeoutMs: 2000 })).toEqual({
      ok: true, daemon: { pid: 4242, port: 9120, build: null, ours: true },
    });
  });

  // ── the 2026-09-08 defect ────────────────────────────────────────────
  //
  // On any machine that ran `agentdeck daemon install`, the pid that ends up
  // serving the port is routinely NOT the child this command forked. The
  // daemon SIGKILLs itself on /shutdown, every supervisor reads a signalled
  // death as a failure, and launchd/systemd respawn it in a few seconds — the
  // respawn takes the port, our own child hits `daemon start`'s incumbent
  // guard and exits 0, and a wait keyed on the child's pid can only time out.
  // Measured twice: `restart FAILED — no daemon with PID <n> is answering`
  // while PID 13155 served the new build on 9120 the entire time.
  it('accepts a supervisor respawn on the same build and flags it as not ours', async () => {
    const probeHealth = vi.fn(async (port: number) =>
      (port === 9120 ? { pid: 13155, mode: 'daemon', build: '86d87e1745db' } : null));
    expect(await wait({ probeHealth, expectedBuild: '86d87e1745db', timeoutMs: 2000 })).toEqual({
      ok: true,
      daemon: { pid: 13155, port: 9120, build: '86d87e1745db', ours: false },
    });
  });

  it('survives the child exiting deliberately before the supervisor binds', async () => {
    // The full shape of the incident: our child loses the race and exits
    // ("already running") while the supervisor's daemon is still coming up.
    // The child's exit is no longer evidence of anything, so the floor has to
    // outlast a respawn — giving up at the child's exit is the false failure.
    let up = false;
    setTimeout(() => { up = true; }, 500);
    const childAlive = { v: true };
    setTimeout(() => { childAlive.v = false; }, 50);
    const probeHealth = vi.fn(async (port: number) =>
      (port === 9120 && up ? { pid: 13155, mode: 'daemon', build: 'b1' } : null));
    expect(await wait({
      probeHealth, expectedBuild: 'b1', timeoutMs: 2000, isChildAlive: () => childAlive.v,
    })).toEqual({ ok: true, daemon: { pid: 13155, port: 9120, build: 'b1', ours: false } });
  });

  it('refuses a respawn serving a DIFFERENT build than the one on disk', async () => {
    // The supervisor launches whatever `agentdeck` resolves to at ITS path,
    // which may be another install. "A daemon restarted" and "your code is
    // live" are different claims, and this is the one place they come apart.
    const probeHealth = vi.fn(async (port: number) =>
      (port === 9120 ? { pid: 13155, mode: 'daemon', build: 'old0build00' } : null));
    expect(await wait({ probeHealth, expectedBuild: 'new0build00' })).toEqual({
      ok: false, reason: 'stale-build', pid: 13155, port: 9120,
      build: 'old0build00', expected: 'new0build00',
    });
  });

  it('does not call an unknown build a mismatch', async () => {
    // Absence is not information. Refusing here would reintroduce exactly the
    // false failure this function exists to remove — an installed copy has no
    // dist identity to compare, and a daemon predating the field sends none.
    const probeHealth = vi.fn(async () => ({ pid: 13155, mode: 'daemon' }));
    expect(await wait({ probeHealth, expectedBuild: 'new0build00', timeoutMs: 2000 })).toEqual({
      ok: true, daemon: { pid: 13155, port: 9120, build: null, ours: false },
    });
    const noExpectation = vi.fn(async () => ({ pid: 13155, mode: 'daemon', build: 'whatever' }));
    expect(await wait({ probeHealth: noExpectation, expectedBuild: null, timeoutMs: 2000 }))
      .toMatchObject({ ok: true });
  });

  it('ignores an answer that is explicitly not a daemon', async () => {
    // A session bridge's hook server answers /health on 9121+ with its own pid.
    const probeHealth = vi.fn(async () => ({ pid: 777, mode: 'session' }));
    expect(await wait({ probeHealth })).toEqual({ ok: false, reason: 'no-daemon' });
  });

  it('keeps waiting past the floor while the child is still alive', async () => {
    // The budget used to be a derived constant, and it was wrong twice: the
    // child can spend `EXIT_WAIT_MS + BINDABLE_WAIT_MS` negotiating a Swift
    // incumbent's stand-down BEFORE it even reaches its own port-reclaim wait,
    // so the whole worst case runs past a minute. Liveness is a real
    // condition; the timeout is only a floor.
    let answers = false;
    setTimeout(() => { answers = true; }, 600);
    const probeHealth = vi.fn(async (port: number) => (port === 9120 && answers ? { pid: 4242 } : null));
    expect(await wait({ probeHealth, timeoutMs: 200, isChildAlive: () => true }))
      .toEqual({ ok: true, daemon: { pid: 4242, port: 9120, build: null, ours: true } });
  });

  it('gives up once the child has EXITED without anything answering', async () => {
    // The other half of the same rule: a floor that never expires would hang
    // on a child that died on startup.
    const probeHealth = vi.fn(async () => null);
    expect(await wait({ probeHealth, timeoutMs: 200, isChildAlive: () => false }))
      .toEqual({ ok: false, reason: 'no-daemon' });
  });

  it('finds the daemon on a fallback port and reports THAT port', async () => {
    // Landing elsewhere is a different outcome from not starting, and the
    // caller says which one happened instead of calling both a failure.
    const probeHealth = vi.fn(async (port: number) => (port === 9121 ? { pid: 4242 } : null));
    expect(await wait({
      probeHealth, readDaemonInfo: () => ({ httpPort: 9121 }), timeoutMs: 2000,
    })).toEqual({ ok: true, daemon: { pid: 4242, port: 9121, build: null, ours: true } });
  });

  it('waits rather than giving up on the first miss', async () => {
    let calls = 0;
    const probeHealth = vi.fn(async () => (++calls < 3 ? null : { pid: 4242 }));
    expect(await wait({ probeHealth, timeoutMs: 5000 })).toMatchObject({ ok: true });
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});


describe('observed run environment arguments', () => {
  it('inserts defaults before typed run options', () => {
    expect(applyGlobalEnvArgs(['node', 'ad', 'run', 'codex', '-c', 'codex --resume typed'], {
      AGENTDECK_COMMANDER_ARGS: '-c "codex --resume default"',
    })).toEqual(['node', 'ad', 'run', '-c', 'codex --resume default', 'codex', '-c', 'codex --resume typed']);
  });
  it('keeps the typed both-layer escape hatch for run', () => {
    const argv = ['node', 'ad', 'run', 'claude', '--no-env-args'];
    expect(applyGlobalEnvArgs(argv, { AGENTDECK_COMMANDER_ARGS: '--remote-daemon' })).toBe(argv);
  });
});
