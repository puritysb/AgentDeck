import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every rung is a subprocess, so the ladder is exercised against a fake
// `execFile`. promisify() resolves with the callback's second argument, which
// is why the fake answers `{ stdout, stderr }` rather than two strings.
type ExecReply = { stdout?: string; stderr?: string; code?: string | number };
const execCalls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
let execRoute: (file: string, args: string[]) => ExecReply = () => ({ stdout: '' });
vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv },
    cb: (err: unknown, out?: { stdout: string; stderr: string }) => void,
  ) => {
    execCalls.push({ file, args, env: opts?.env });
    const reply = execRoute(file, args);
    if (reply.code !== undefined) {
      cb(Object.assign(new Error(`${file} failed`), { code: reply.code, stderr: reply.stderr ?? '' }));
    } else {
      cb(null, { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' });
    }
  },
}));

import {
  parseTmuxPanes, buildItermSelectScript, buildTerminalAppSelectTabScript,
  buildPostKeysScript, buildAppButtonPressScript, buildAppKeysScript,
  escapeAppleScript, parseCmuxEnv, isCmuxSocketRefusal, cmuxErrorMessage,
  injectObservedText, injectObservedSelection,
} from '../observed-inject.js';
import { parseProcessTable, appNameFromCommand, resolveHostApp } from '../passive-observer.js';

describe('parseTmuxPanes', () => {
  it('maps pane ttys (dev-prefix stripped) to pane ids', () => {
    const out = '/dev/ttys004\t%1\n/dev/ttys008\t%3\n';
    const map = parseTmuxPanes(out);
    expect(map.get('ttys008')).toBe('%3');
    expect(map.get('ttys004')).toBe('%1');
  });

  it('ignores malformed lines', () => {
    expect(parseTmuxPanes('garbage\n\n').size).toBe(0);
  });
});

describe('buildItermSelectScript', () => {
  it('targets the session by tty and types Down x index then Enter', () => {
    const s = buildItermSelectScript('ttys008', 2);
    expect(s).toContain('if tty of s is "/dev/ttys008"');
    expect(s.match(/character id 27/g)?.length).toBe(2);
    expect(s).toContain('write s text ""');
  });

  it('index 0 is a bare Enter', () => {
    const s = buildItermSelectScript('ttys001', 0);
    expect(s).not.toContain('character id 27');
    expect(s).toContain('write s text ""');
  });

  // Measured 2026-08-06 on a live picker: arrows and the Enter that acts on
  // them, delivered as one burst, make the TUI answer with the option the
  // cursor was on BEFORE the arrows — every device answer silently became
  // option 0. The caller sends them as separate, paced calls, so the arrow
  // script must be able to omit its Enter.
  it('can emit the arrows without the Enter that would act on them', () => {
    const s = buildItermSelectScript('ttys008', 2, { enter: false });
    expect(s.match(/character id 27/g)?.length).toBe(2);
    expect(s).not.toContain('write s text ""');
  });
});

describe('parseProcessTable with tty column', () => {
  it('parses tty and treats ?? as none', () => {
    const out = '  123   1  1000 ttys008 claude\n  456   1  2000 ?? claude daemon run\n';
    const rows = parseProcessTable(out);
    expect(rows[0].tty).toBe('ttys008');
    expect(rows[1].tty).toBeUndefined();
  });
});

describe('buildTerminalAppSelectTabScript', () => {
  it('selects the tab by tty without activating the app', () => {
    const s = buildTerminalAppSelectTabScript('ttys003');
    expect(s).toContain('if tty of t is "/dev/ttys003"');
    expect(s).toContain('set selected of t to true');
    // focus-free: selecting a tab must never raise Terminal
    expect(s).not.toContain('activate');
  });

  it('returns notfound when no tab matches', () => {
    expect(buildTerminalAppSelectTabScript('ttys009')).toContain('return "notfound"');
  });
});

describe('buildPostKeysScript', () => {
  it('matches by bundle id first, then localized name', () => {
    const s = buildPostKeysScript({ bundleIds: ['com.apple.Terminal'], names: ['Terminal', '터미널'] }, 2);
    const bundleAt = s.indexOf('wantBundles.indexOf');
    const nameAt = s.indexOf('wantNames.indexOf');
    expect(bundleAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(bundleAt);
    expect(s).toContain('"com.apple.Terminal"');
    expect(s).toContain('터미널');
  });

  it('posts to the pid (never activates) and ends with Return', () => {
    const s = buildPostKeysScript({ bundleIds: ['com.openai.chat'] }, 3);
    expect(s).toContain('CGEventPostToPid');
    expect(s).toContain('for (let i = 0; i < 3; i++) key(125)');
    expect(s).toContain('key(36)');
    expect(s).not.toContain('activate');
  });

  // A grouped AskUserQuestion does not close on its last answer: it shows a
  // "Review your answers → Submit answers" confirmation. Nobody is at that
  // screen when a device answered, so the last selection carries a second
  // Return. Single-question prompts must NOT get one — it would land in the
  // prompt box as an empty submit.
  it('carries a second Return only when a grouped prompt needs submitting', () => {
    expect(buildPostKeysScript({ bundleIds: ['com.apple.Terminal'] }, 1, 2))
      .toContain('i < 2; i++) { key(36)');
    expect(buildPostKeysScript({ bundleIds: ['com.apple.Terminal'] }, 1))
      .toContain('i < 1; i++) { key(36)');
  });
});

describe('buildAppButtonPressScript', () => {
  it('matches the button by label with prefix tolerance and clicks it', () => {
    const s = buildAppButtonPressScript('ChatGPT', 'Allow once');
    expect(s).toContain('tell process "ChatGPT"');
    expect(s).toContain('bt is "Allow once"');
    expect(s).toContain('bt starts with "Allow once"');
    expect(s).toContain('click target');
    // AXPress path must never raise the app
    expect(s).not.toContain('activate');
  });

  it('escapes quotes in labels', () => {
    expect(buildAppButtonPressScript('Claude', 'Say "hi"')).toContain('Say \\"hi\\"');
  });
});

describe('buildAppKeysScript', () => {
  it('raises the app, keys, and restores the previous frontmost app', () => {
    const s = buildAppKeysScript('Claude', 1);
    expect(s).toContain('tell application "Claude" to activate');
    expect(s.match(/key code 125/g)?.length).toBe(1);
    expect(s).toContain('tell application prevApp to activate');
  });
});

describe('escapeAppleScript', () => {
  it('escapes backslashes and quotes', () => {
    expect(escapeAppleScript('a\\b"c')).toBe('a\\\\b\\"c');
  });
});

describe('app-host resolution', () => {
  it('extracts the app name from a bundle path', () => {
    expect(appNameFromCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server'))
      .toBe('ChatGPT');
    expect(appNameFromCommand('/Users/me/.local/bin/claude')).toBeUndefined();
  });

  it('walks the ancestry to find the hosting app', () => {
    const rows = parseProcessTable([
      ' 100 1 1000 ?? /Applications/Claude.app/Contents/MacOS/Claude',
      ' 200 100 1000 ?? /Users/me/.local/bin/node helper.js',
      ' 300 200 1000 ?? /Users/me/.local/bin/claude',
    ].join('\n'));
    const byPid = new Map(rows.map((p) => [p.pid, p]));
    expect(resolveHostApp(300, byPid)).toBe('Claude');
  });

  it('returns undefined for a plain terminal session', () => {
    const rows = parseProcessTable([
      ' 10 1 1000 ttys001 -zsh',
      ' 20 10 1000 ttys001 /Users/me/.local/bin/claude',
    ].join('\n'));
    const byPid = new Map(rows.map((p) => [p.pid, p]));
    expect(resolveHostApp(20, byPid)).toBeUndefined();
  });
});

const SURFACE = '31608312-0A92-4470-A64B-3B000CFC395D';
const OTHER_SURFACE = '9F9FA550-5886-45CE-AAF8-5F76DC833627';

describe('parseCmuxEnv', () => {
  const command = '/opt/homebrew/bin/claude --model opus';
  const ps = (env: string) => `${command} ${env}\n`;
  const exists = () => true;

  it('reads the surface id and socket path from the environment', () => {
    const out = ps(`HOME=/Users/me CMUX_SURFACE_ID=${SURFACE} CMUX_SOCKET_PATH=/Users/me/.local/state/cmux/cmux.sock`);
    expect(parseCmuxEnv(out, `${command}\n`, exists)).toEqual({
      surfaceId: SURFACE,
      socketPath: '/Users/me/.local/state/cmux/cmux.sock',
    });
  });

  it('is undefined for a process that does not run under cmux', () => {
    expect(parseCmuxEnv(ps('HOME=/Users/me TERM=xterm-256color'), command, exists)).toBeUndefined();
  });

  it('removes all argv before reading the real environment', () => {
    const argv = `${command} CMUX_SURFACE_ID=${OTHER_SURFACE} CMUX_SOCKET_PATH=/wrong.sock`;
    const out = `${argv} CMUX_SURFACE_ID=${SURFACE}\n`;
    expect(parseCmuxEnv(out, argv, exists)).toEqual({ surfaceId: SURFACE, socketPath: undefined });
  });

  it('does not treat a surface mentioned only in argv as a cmux host', () => {
    const argv = `${command} --prompt explain CMUX_SURFACE_ID=${OTHER_SURFACE}`;
    expect(parseCmuxEnv(`${argv} HOME=/Users/me\n`, `${argv}\n`, exists)).toBeUndefined();
    expect(parseCmuxEnv(`${argv}\n`, `${argv}\n`, exists)).toBeUndefined();
  });

  it('requires a readable complete argv prefix without trimming argument whitespace', () => {
    expect(parseCmuxEnv(ps(`CMUX_SURFACE_ID=${SURFACE}`), '', exists)).toBeUndefined();
    expect(parseCmuxEnv(ps(`CMUX_SURFACE_ID=${SURFACE}`), `${command} changed`, exists)).toBeUndefined();
    expect(parseCmuxEnv(ps(`CMUX_SURFACE_ID=${SURFACE}`), `${command}\nsecond row`, exists)).toBeUndefined();
    const argv = `${command} CMUX_SURFACE_ID=${OTHER_SURFACE}  `;
    expect(parseCmuxEnv(`${argv} HOME=/Users/me\n`, `${argv}\n`, exists)).toBeUndefined();
  });

  it('rejects a surface id that is not a UUID, so it can never read as a flag', () => {
    expect(parseCmuxEnv(ps('CMUX_SURFACE_ID=--force'), command, exists)).toBeUndefined();
    expect(parseCmuxEnv(ps('CMUX_SURFACE_ID=surface:2'), command, exists)).toBeUndefined();
  });

  it('drops a socket path that is relative or missing, leaving discovery to the CLI', () => {
    expect(parseCmuxEnv(ps(`CMUX_SURFACE_ID=${SURFACE} CMUX_SOCKET_PATH=cmux.sock`), command, exists)?.socketPath)
      .toBeUndefined();
    expect(parseCmuxEnv(ps(`CMUX_SURFACE_ID=${SURFACE} CMUX_SOCKET_PATH=/gone/cmux.sock`), command, () => false)?.socketPath)
      .toBeUndefined();
  });
});

describe('cmux error reading', () => {
  it('keeps the first line without the Error: prefix', () => {
    expect(cmuxErrorMessage('Error: not_found: Surface not found for the given surface_id\n'))
      .toBe('not_found: Surface not found for the given surface_id');
  });

  // Measured on cmux 0.65.1 from a launchd job: `send` sees only the pipe
  // close, `ping` gets the actual reason.
  it('recognises both shapes of a socket refusal', () => {
    expect(isCmuxSocketRefusal('Failed to write to socket (Broken pipe, errno 32)')).toBe(true);
    expect(isCmuxSocketRefusal('ERROR: Access denied - only processes started inside cmux can connect')).toBe(true);
    expect(isCmuxSocketRefusal('not_found: Surface not found for the given surface_id')).toBe(false);
  });
});

describe('cmux rung', () => {
  const realPlatform = process.platform;
  const PID = 4242;
  let cmuxReply: (args: string[]) => ExecReply;
  let command: string;
  let environment: string;

  const cmuxArgs = () => execCalls.filter((c) => c.file === 'cmux').map((c) => c.args);

  beforeEach(() => {
    // The rung is macOS-only; pin the platform so the suite means the same
    // thing on a Linux CI runner.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    execCalls.length = 0;
    cmuxReply = () => ({ stdout: 'OK' });
    command = '/opt/homebrew/bin/claude';
    environment = `HOME=/Users/me CMUX_SURFACE_ID=${SURFACE}`;
    execRoute = (file, args) => {
      if (file === 'tmux') return { code: 'ENOENT' };
      if (file === 'ps') {
        if (args.includes('pid=,ppid=,comm=')) return { stdout: [
          `${PID} 100 /opt/homebrew/bin/claude`,
          `${PID + 1} 100 /opt/homebrew/bin/claude`,
          '100 50 /bin/zsh',
          '50 1 /Applications/iTerm.app/Contents/MacOS/iTerm2',
        ].join('\n') };
        const env = args.includes(String(PID)) ? environment : 'HOME=/Users/me';
        return { stdout: `${command}${args.includes('-E') ? ` ${env}` : ''}\n` };
      }
      if (file === 'cmux') return cmuxReply(args);
      return { stdout: 'notfound' };
    };
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('pastes a dictated line into the surface, then submits it with Enter', async () => {
    const r = await injectObservedText({ tty: 'ttys003', pid: PID }, 'Run the tests\\nand fix them');
    expect(r).toEqual({ ok: true, via: 'cmux' });
    expect(cmuxArgs()).toEqual([
      ['send', '--paste', '--surface', SURFACE, '--', 'Run the tests\\nand fix them'],
      ['send-key', '--surface', SURFACE, '--', 'Enter'],
    ]);
    // The host is known, so no AppleScript rung may run — Terminal.app's
    // would raise an Automation prompt for an app that does not own the tty.
    expect(execCalls.some((c) => c.file === 'osascript')).toBe(false);
  });

  it('never forces text over a draft: cmux refuses, and nothing is submitted', async () => {
    cmuxReply = (args) => args[0] === 'send'
      ? { code: 1, stderr: `Error: send: the agent prompt in ${SURFACE} holds text someone is typing, so nothing was sent.` }
      : { stdout: 'OK' };
    const r = await injectObservedText({ tty: 'ttys003', pid: PID }, 'hello');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('holds text someone is typing');
    expect(cmuxArgs().flat()).not.toContain('--force');
    expect(cmuxArgs().some((a) => a[0] === 'send-key')).toBe(false);
    expect(execCalls.some((c) => c.file === 'osascript')).toBe(false);
  });

  it('quotes ping when the socket refuses, and names the setting to change', async () => {
    cmuxReply = (args) => args[0] === 'ping'
      ? { code: 1, stderr: 'Error: ERROR: Access denied - only processes started inside cmux can connect' }
      : { code: 1, stderr: 'Error: Failed to write to socket (Broken pipe, errno 32)' };
    const r = await injectObservedText({ tty: 'ttys003', pid: PID }, 'hello');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cmux socket refused');
    expect(r.reason).toContain('Access denied - only processes started inside cmux can connect');
    expect(r.reason).toContain('Automation mode');
    // ping runs only on the refusal branch, after the send that failed.
    expect(cmuxArgs().map((a) => a[0])).toEqual(['send', 'ping']);
  });

  it('answers a picker with paced, forced Down presses and an Enter', async () => {
    const r = await injectObservedSelection({ tty: 'ttys003', pid: PID }, 2);
    expect(r).toEqual({ ok: true, via: 'cmux' });
    expect(cmuxArgs()).toEqual([
      ['send-key', '--force', '--surface', SURFACE, '--', 'Down'],
      ['send-key', '--force', '--surface', SURFACE, '--', 'Down'],
      ['send-key', '--force', '--surface', SURFACE, '--', 'Enter'],
    ]);
  });

  it('reports a break after keys landed instead of re-sending them elsewhere', async () => {
    let n = 0;
    cmuxReply = () => (++n === 2 ? { code: 1, stderr: 'Error: not_found: Surface not found' } : { stdout: 'OK' });
    const r = await injectObservedSelection({ tty: 'ttys003', pid: PID }, 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('broke partway');
    expect(execCalls.some((c) => c.file === 'osascript')).toBe(false);
  });

  it('leaves sessions outside cmux to the AppleScript rungs', async () => {
    const r = await injectObservedText({ tty: 'ttys003', pid: PID + 1 }, 'hello');
    expect(r.ok).toBe(false);
    expect(cmuxArgs()).toEqual([]);
    expect(execCalls.some((c) => c.file === 'osascript')).toBe(true);
  });

  it.each(['text', 'selection'] as const)('ignores argv-only CMUX_SURFACE_ID in the %s ladder', async (kind) => {
    command += ` --prompt explain CMUX_SURFACE_ID=${OTHER_SURFACE}`;
    environment = 'HOME=/Users/me';
    if (kind === 'text') await injectObservedText({ tty: 'ttys003', pid: PID }, 'hello');
    else await injectObservedSelection({ tty: 'ttys003', pid: PID }, 0);
    expect(cmuxArgs()).toEqual([]);
    expect(execCalls.some(c => c.file === 'osascript')).toBe(true);
  });

  it.each(['changed', 'unreadable'] as const)('does not select cmux when argv is %s after the environment probe', async (failure) => {
    const route = execRoute;
    let plainReads = 0;
    execRoute = (file, args) => {
      if (file === 'ps' && !args.includes('-E') && ++plainReads === 2) {
        return failure === 'unreadable' ? { code: 1 } : { stdout: `${command} changed\n` };
      }
      return route(file, args);
    };
    await injectObservedText({ tty: 'ttys003', pid: PID }, 'hello');
    expect(cmuxArgs()).toEqual([]);
  });

  it('does not look for cmux when the agent pid is unknown', async () => {
    await injectObservedText({ tty: 'ttys003' }, 'hello');
    expect(execCalls.some((c) => c.file === 'ps')).toBe(false);
  });
});


describe('terminal Automation host guard', () => {
  const realPlatform = process.platform;
  const PID = 4242;
  const iterm = '/Applications/iTerm.app/Contents/MacOS/iTerm2';
  const terminal = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
  let ancestry: ExecReply;
  let osaReply: ExecReply;
  const osaCalls = () => execCalls.filter(c => c.file === 'osascript');
  const deliver = (kind: 'text' | 'selection', pid: number | undefined = PID) => kind === 'text'
    ? injectObservedText({ tty: 'ttys003', pid }, 'hello')
    : injectObservedSelection({ tty: 'ttys003', pid }, 0);
  const chain = (executable: string) => ({ stdout: [
    `${PID} 300 /opt/homebrew/bin/claude`,
    '300 200 /bin/zsh',
    '200 100 /usr/bin/login',
    `100 1 ${executable}`,
  ].join('\n') });

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    execCalls.length = 0;
    ancestry = chain(iterm);
    osaReply = { stdout: 'ok' };
    execRoute = (file, args) => {
      if (file === 'tmux') return { code: 'ENOENT' };
      if (file === 'ps') return args.includes('pid=,ppid=,comm=')
        ? ancestry : { stdout: '/opt/homebrew/bin/claude\n' };
      if (file === 'osascript') return osaReply;
      return { code: 'ENOENT' };
    };
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  describe.each(['text', 'selection'] as const)('%s delivery', kind => {
    it.each(['Ghostty', 'WezTerm', 'kitty', 'Alacritty', 'Visual Studio Code'])('skips Automation for %s', async app => {
      ancestry = chain(`/Applications/${app}.app/Contents/MacOS/${app}`);
      // Both supported terminal apps may be running, but neither owns this session.
      ancestry.stdout += `\n800 1 ${iterm}\n900 1 ${terminal}`;
      const result = await deliver(kind);
      expect(result).toEqual({ ok: false, reason: `terminal host not supported (${app})` });
      expect(osaCalls()).toEqual([]);
    });

    it.each([[iterm, 'iterm2'], [terminal, 'terminal-app']] as const)('only controls the owning app %s', async (executable, via) => {
      ancestry = chain(executable);
      expect(await deliver(kind)).toEqual({ ok: true, via });
      expect(osaCalls().length).toBeGreaterThan(0);
      const scripts = osaCalls().map(c => c.args.at(-1)).join('\n');
      if (via === 'iterm2') expect(scripts).not.toContain('Terminal');
      else expect(scripts).not.toContain('iTerm');
    });

    it.each([iterm, terminal])('does not try another app when the owner fails: %s', async executable => {
      ancestry = chain(executable);
      osaReply = { code: 1 };
      expect((await deliver(kind)).ok).toBe(false);
      expect(osaCalls()).toHaveLength(1);
      expect(osaCalls()[0].args.at(-1)).toContain(executable === iterm ? 'iTerm2' : 'Terminal');
    });

    it('uses the nearest app when an editor was launched from iTerm2', async () => {
      ancestry = chain('/Applications/Code.app/Contents/MacOS/Electron');
      ancestry.stdout = ancestry.stdout!.replace('100 1 ', '100 50 ') + `\n50 1 ${iterm}`;
      expect((await deliver(kind)).reason).toBe('terminal host not supported (Code)');
      expect(osaCalls()).toEqual([]);
    });

    it.each([
      { code: 1 }, // includes timeout / EPERM
      { stdout: '' },
      { stdout: `${PID} 100 /opt/homebrew/bin/claude` }, // missing ancestor
      { stdout: `${PID} 100 /opt/homebrew/bin/claude\n100 ${PID} /bin/zsh` }, // cycle
      { stdout: `${PID} 1 /opt/homebrew/bin/claude` }, // reparented / SSH
      { stdout: 'malformed process snapshot' },
    ] satisfies ExecReply[])('keeps an unreadable or incomplete host unknown: %j', async reply => {
      ancestry = reply;
      const result = await deliver(kind);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('terminal host unknown');
      expect(osaCalls()).toEqual([]);
    });

    it.each([undefined, 0, -1, 1.5, NaN])('skips Automation without a valid pid: %s', async pid => {
      // Avoid the helper default for an explicitly missing pid.
      const result = kind === 'text'
        ? await injectObservedText({ tty: 'ttys003', pid }, 'hello')
        : await injectObservedSelection({ tty: 'ttys003', pid }, 0);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('no valid agent pid');
      expect(osaCalls()).toEqual([]);
    });

    it('still delivers through tmux without discovering an app', async () => {
      const route = execRoute;
      execRoute = (file, args) => file === 'tmux'
        ? { stdout: '/dev/ttys003\t%3\n' } : route(file, args);
      expect(await deliver(kind)).toEqual({ ok: true, via: 'tmux' });
      expect(execCalls.some(c => c.file === 'ps' || c.file === 'osascript')).toBe(false);
    });

    it('never uses Automation on a non-macOS host', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect((await deliver(kind)).ok).toBe(false);
      expect(execCalls.some(c => c.file === 'ps' || c.file === 'osascript')).toBe(false);
    });
  });
});
