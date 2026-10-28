import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  type FsProbe,
  classifyClaudeProbe,
  classifyNpmFailure,
  decideRetry,
  detectSurfaces,
  ensureProfilePathLine,
  globalInstallTargets,
  isYes,
  nextStepsLines,
  npmInstallArgs,
  offlineNotice,
  pathContains,
  planBridgeInstall,
  prefixWritability,
  prependPathEntry,
  profileFileFor,
  profilePathLine,
  quoteWindowsArg,
  shouldOfferDaemonPrompt,
  surfacePlan,
  surfacePrereqLines,
  ulanziPaths,
  upsertProfileLine,
  userPrefixBinDir,
} from '../onboarding.js';

// The verbatim stderr from the Ulanzi Studio QA run (2026-10-19): system Node
// v24.16.0, global prefix /usr/local owned by root.
const QA_EACCES = `npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/@agentdeck
npm error errno -13
npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@agentdeck'
npm error     at async mkdir (node:internal/fs/promises:855:10)
npm error
npm error The operation was rejected by your operating system.
npm error It is likely you do not have the permissions to access this file as the current user
npm error A complete log of this run can be found in: /Users/qa/.npm/_logs/2026-10-19T01_00_00_000Z-debug-0.log
`;

const GYP_FAILURE = `npm error code 1
npm error path /Users/me/.agentdeck/npm/lib/node_modules/@agentdeck/bridge/node_modules/node-pty
npm error command failed
npm error command sh -c node scripts/prebuild.js || node-gyp rebuild
npm error gyp ERR! find Python
npm error gyp ERR! stack Error: Could not find any Python installation to use
`;

/** An FsProbe over a fixed set of existing paths and the writable subset. */
function fakeFs(existing: string[], writable: string[]): FsProbe {
  const exists = new Set(existing);
  const canWrite = new Set(writable);
  return {
    existsSync: (p) => exists.has(p),
    accessSync: (p) => {
      if (!canWrite.has(p)) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
    },
  };
}

describe('classifyNpmFailure', () => {
  it('reads the QA EACCES as a permission problem on the path npm named', () => {
    const f = classifyNpmFailure(QA_EACCES);
    expect(f.kind).toBe('permission');
    if (f.kind !== 'permission') return;
    expect(f.code).toBe('EACCES');
    expect(f.path).toBe('/usr/local/lib/node_modules/@agentdeck');
  });

  it('falls back to the quoted path in the Error line', () => {
    const f = classifyNpmFailure(
      "Error: EPERM: operation not permitted, rename 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@agentdeck\\bridge'",
    );
    expect(f).toMatchObject({
      kind: 'permission',
      code: 'EPERM',
      path: 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@agentdeck\\bridge',
    });
  });

  it('permission wins even when a native build is also mentioned', () => {
    expect(classifyNpmFailure(`${GYP_FAILURE}\nnpm error Error: EACCES: permission denied, open '/x'`).kind).toBe(
      'permission',
    );
  });

  it('a node-gyp / prebuild failure is the only native-build kind', () => {
    expect(classifyNpmFailure(GYP_FAILURE).kind).toBe('native-build');
    expect(classifyNpmFailure('prebuild-install warn install No prebuilt binaries found').kind).toBe('native-build');
    expect(
      classifyNpmFailure('was compiled against a different Node.js version using NODE_MODULE_VERSION 127').kind,
    ).toBe('native-build');
  });

  it('a registry problem that merely names node-pty is not a build failure', () => {
    expect(
      classifyNpmFailure('npm error code ETARGET\nnpm error notarget No matching version found for node-pty@9.9.9.')
        .kind,
    ).toBe('other');
  });

  it('anything else is reported verbatim through the stderr tail', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `npm error line ${i}`);
    const f = classifyNpmFailure(`\x1b[31m${lines.join('\n')}\x1b[0m\n\n`);
    expect(f.kind).toBe('other');
    expect(f.tail.split('\n')).toHaveLength(15);
    expect(f.tail).toContain('npm error line 29');
    expect(f.tail).not.toContain('\x1b[');
  });
});

describe('decideRetry', () => {
  const base = { usingUserPrefix: false, sourceBuildTried: false, platform: 'darwin' as const };

  it('EACCES on the default prefix moves to the per-user prefix, never a source build', () => {
    expect(decideRetry(classifyNpmFailure(QA_EACCES), base)).toBe('user-prefix');
  });

  it('EACCES inside the per-user prefix fails instead of looping', () => {
    expect(decideRetry(classifyNpmFailure(QA_EACCES), { ...base, usingUserPrefix: true })).toBe('fail');
  });

  it('EPERM is reported, not papered over with a second install', () => {
    expect(decideRetry(classifyNpmFailure("EPERM: operation not permitted, rename 'x'"), base)).toBe('fail');
  });

  it('a native-build failure earns exactly one source build, and none on Windows', () => {
    const f = classifyNpmFailure(GYP_FAILURE);
    expect(decideRetry(f, base)).toBe('source-build');
    expect(decideRetry(f, { ...base, sourceBuildTried: true })).toBe('fail');
    expect(decideRetry(f, { ...base, platform: 'win32' })).toBe('fail');
    expect(decideRetry(f, { ...base, platform: 'linux' })).toBe('source-build');
  });

  it('an unclassified failure is never retried', () => {
    expect(decideRetry(classifyNpmFailure('npm error code ENOTFOUND'), base)).toBe('fail');
  });
});

describe('prefix writability and the install plan', () => {
  const home = '/Users/qa';

  it('the QA machine (root-owned /usr/local) installs into ~/.agentdeck/npm', () => {
    const fs = fakeFs(['/usr/local/lib/node_modules', '/usr/local/bin', '/usr/local', '/'], []);
    expect(prefixWritability('/usr/local', 'darwin', fs)).toEqual({
      verdict: 'unwritable',
      blocking: '/usr/local/lib/node_modules',
    });
    expect(planBridgeInstall({ globalPrefix: '/usr/local', platform: 'darwin', home, fs })).toEqual({
      prefix: '/Users/qa/.agentdeck/npm',
      reason: 'unwritable',
      blocking: '/usr/local/lib/node_modules',
    });
  });

  it('a user-owned prefix (Homebrew, nvm) keeps the default global install', () => {
    const fs = fakeFs(
      ['/opt/homebrew/lib/node_modules', '/opt/homebrew/bin'],
      ['/opt/homebrew/lib/node_modules', '/opt/homebrew/bin'],
    );
    expect(planBridgeInstall({ globalPrefix: '/opt/homebrew', platform: 'darwin', home, fs })).toEqual({
      prefix: null,
      reason: 'default',
      blocking: null,
    });
  });

  it('checks the nearest existing parent of a missing scope dir', () => {
    // lib/node_modules exists and is writable, @agentdeck does not exist yet.
    const fs = fakeFs(['/p/lib/node_modules', '/p/bin'], ['/p/lib/node_modules', '/p/bin']);
    expect(prefixWritability('/p', 'linux', fs).verdict).toBe('writable');
  });

  it('a writable modules dir with a root-owned bin dir is still unwritable', () => {
    const fs = fakeFs(['/p/lib/node_modules', '/p/bin'], ['/p/lib/node_modules']);
    expect(prefixWritability('/p', 'linux', fs)).toEqual({ verdict: 'unwritable', blocking: '/p/bin' });
  });

  it('an unanswerable npm prefix is no evidence: try the default, EACCES still falls back', () => {
    expect(planBridgeInstall({ globalPrefix: null, platform: 'darwin', home, fs: fakeFs([], []) })).toEqual({
      prefix: null,
      reason: 'default-unverified',
      blocking: null,
    });
  });

  it('keeps updating an earlier per-user install so the old copy cannot shadow a new one', () => {
    const fs = fakeFs(
      [
        '/Users/qa/.agentdeck/npm/lib/node_modules/@agentdeck/bridge',
        '/opt/homebrew/lib/node_modules',
        '/opt/homebrew/bin',
      ],
      ['/opt/homebrew/lib/node_modules', '/opt/homebrew/bin'],
    );
    expect(planBridgeInstall({ globalPrefix: '/opt/homebrew', platform: 'darwin', home, fs }).reason).toBe(
      'existing-user-install',
    );
  });

  it('uses the Windows npm layout (node_modules and shims directly under the prefix)', () => {
    expect(globalInstallTargets('C:\\Program Files\\nodejs', 'win32')).toEqual({
      modules: 'C:\\Program Files\\nodejs\\node_modules',
      bin: 'C:\\Program Files\\nodejs',
    });
    expect(userPrefixBinDir('C:\\Users\\a b', 'win32')).toBe('C:\\Users\\a b\\.agentdeck\\npm');
    const fs = fakeFs(['C:\\Program Files\\nodejs\\node_modules', 'C:\\Program Files\\nodejs'], []);
    expect(
      planBridgeInstall({ globalPrefix: 'C:\\Program Files\\nodejs', platform: 'win32', home: 'C:\\Users\\a b', fs })
        .prefix,
    ).toBe('C:\\Users\\a b\\.agentdeck\\npm');
  });

  it('npm arguments carry --prefix only for the per-user install, and never sudo', () => {
    expect(npmInstallArgs(null)).toEqual(['install', '-g', '@agentdeck/bridge']);
    expect(npmInstallArgs('/Users/qa/.agentdeck/npm')).toEqual([
      'install',
      '-g',
      '--prefix',
      '/Users/qa/.agentdeck/npm',
      '@agentdeck/bridge',
    ]);
    expect(quoteWindowsArg('C:\\Users\\a b\\.agentdeck\\npm')).toBe('"C:\\Users\\a b\\.agentdeck\\npm"');
    expect(quoteWindowsArg('@agentdeck/bridge')).toBe('@agentdeck/bridge');
  });
});

describe('PATH handling', () => {
  it('prepends once and keeps every other entry', () => {
    expect(prependPathEntry('/usr/bin:/bin', '/h/.agentdeck/npm/bin', 'darwin')).toBe(
      '/h/.agentdeck/npm/bin:/usr/bin:/bin',
    );
    expect(prependPathEntry('/usr/bin:/h/.agentdeck/npm/bin/:/bin', '/h/.agentdeck/npm/bin', 'darwin')).toBe(
      '/h/.agentdeck/npm/bin:/usr/bin:/bin',
    );
    expect(prependPathEntry(undefined, '/x', 'linux')).toBe('/x');
  });

  it('compares Windows entries case-insensitively with either slash', () => {
    expect(pathContains('C:\\Windows;c:/users/a/.agentdeck/npm\\', 'C:\\Users\\A\\.agentdeck\\npm', 'win32')).toBe(
      true,
    );
    expect(pathContains('/usr/bin', '/usr/bin/', 'darwin')).toBe(true);
    expect(pathContains('/usr/bin', '/USR/BIN', 'darwin')).toBe(false);
  });
});

describe('shell profile PATH line', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('picks the login profile each shell actually reads', () => {
    const none = () => false;
    expect(profileFileFor({ platform: 'darwin', shell: '/bin/zsh', home: '/Users/a', exists: none })).toBe(
      '/Users/a/.zprofile',
    );
    expect(profileFileFor({ platform: 'darwin', shell: undefined, home: '/Users/a', exists: none })).toBe(
      '/Users/a/.zprofile',
    );
    expect(
      profileFileFor({
        platform: 'darwin',
        shell: '/bin/zsh',
        home: '/Users/a',
        zdotdir: '/Users/a/.config/zsh',
        exists: none,
      }),
    ).toBe('/Users/a/.config/zsh/.zprofile');
    expect(profileFileFor({ platform: 'darwin', shell: '/bin/bash', home: '/Users/a', exists: none })).toBe(
      '/Users/a/.bash_profile',
    );
    // Linux bash: never create ~/.bash_profile, which would stop ~/.profile from being read.
    expect(profileFileFor({ platform: 'linux', shell: '/bin/bash', home: '/home/a', exists: none })).toBe(
      '/home/a/.profile',
    );
    expect(
      profileFileFor({
        platform: 'linux',
        shell: '/bin/bash',
        home: '/home/a',
        exists: (p) => p === '/home/a/.bash_login',
      }),
    ).toBe('/home/a/.bash_login');
    expect(profileFileFor({ platform: 'linux', shell: '/usr/bin/fish', home: '/home/a', exists: none })).toBeNull();
    expect(profileFileFor({ platform: 'win32', shell: undefined, home: 'C:\\Users\\a', exists: none })).toBeNull();
  });

  it('writes a $HOME-relative, clearly marked line', () => {
    const line = profilePathLine('/Users/a/.agentdeck/npm/bin', '/Users/a');
    expect(line).toBe(
      'export PATH="$HOME/.agentdeck/npm/bin:$PATH" # added by @agentdeck/setup (agentdeck CLI, per-user npm prefix)',
    );
    expect(profilePathLine('/opt/x "y"/bin', '/Users/a')).toContain('export PATH="/opt/x \\"y\\"/bin:$PATH"');
  });

  it('is idempotent and preserves the rest of the profile', () => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-profile-'));
    const file = join(dir, '.zprofile');
    writeFileSync(file, 'eval "$(/opt/homebrew/bin/brew shellenv)"'); // no trailing newline
    const line = profilePathLine('/Users/a/.agentdeck/npm/bin', '/Users/a');
    expect(ensureProfilePathLine(file, line)).toBe('added');
    expect(ensureProfilePathLine(file, line)).toBe('present');
    expect(ensureProfilePathLine(file, line)).toBe('present');
    const content = readFileSync(file, 'utf-8');
    expect(content).toBe(`eval "$(/opt/homebrew/bin/brew shellenv)"\n${line}\n`);
    expect(content.split(line)).toHaveLength(2);
  });

  it('creates a missing profile and replaces an outdated marked line in place', () => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-profile-'));
    const file = join(dir, '.bash_profile');
    expect(ensureProfilePathLine(file, 'export PATH="/old:$PATH" # added by @agentdeck/setup')).toBe('added');
    const line = profilePathLine('/Users/a/.agentdeck/npm/bin', '/Users/a');
    expect(ensureProfilePathLine(file, line)).toBe('updated');
    expect(readFileSync(file, 'utf-8')).toBe(`${line}\n`);
  });

  it('upsertProfileLine handles empty content', () => {
    expect(upsertProfileLine(null, 'L # added by @agentdeck/setup')).toEqual({
      content: 'L # added by @agentdeck/setup\n',
      outcome: 'added',
    });
  });
});

describe('classifyClaudeProbe', () => {
  it('missing when not on PATH or ENOENT', () => {
    expect(classifyClaudeProbe(false, null)).toEqual({ state: 'missing' });
    expect(
      classifyClaudeProbe(true, {
        status: null,
        error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
      }),
    ).toEqual({
      state: 'missing',
    });
  });

  it('ok on a zero exit, with the version parsed', () => {
    expect(classifyClaudeProbe(true, { status: 0, stdout: '2.1.296 (Claude Code)\n' })).toEqual({
      state: 'ok',
      version: '2.1.296',
    });
    expect(classifyClaudeProbe(true, { status: 0, stdout: '' })).toEqual({ state: 'ok', version: null });
  });

  it('broken when the launcher exists but its native binary does not (the QA case)', () => {
    const probe = classifyClaudeProbe(true, {
      status: 1,
      stdout: '',
      stderr:
        '\nError: claude native binary not installed. The package postinstall did not run.\n    at Object.<anonymous> (/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js:3:9)\n',
    });
    expect(probe).toEqual({
      state: 'broken',
      detail: 'Error: claude native binary not installed. The package postinstall did not run.',
    });
  });

  it('broken on a timeout, and a silent failure still says how it failed', () => {
    expect(
      classifyClaudeProbe(true, {
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }),
      }).state,
    ).toBe('broken');
    expect(classifyClaudeProbe(true, { status: 3, stdout: '', stderr: '' })).toEqual({
      state: 'broken',
      detail: '`claude --version` exited with code 3',
    });
  });

  it('caps a long error line', () => {
    const probe = classifyClaudeProbe(true, { status: 1, stderr: 'x'.repeat(500) });
    expect(probe.state === 'broken' && probe.detail.length).toBe(200);
  });
});

describe('deck host surfaces', () => {
  const macHome = '/Users/a';
  const winEnv = {
    APPDATA: 'C:\\Users\\a\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  };
  const detect = (
    platform: NodeJS.Platform,
    present: string[],
    forced: 'ulanzi' | 'streamdeck' | null = null,
    env = {},
  ) =>
    detectSurfaces({
      platform,
      env,
      home: platform === 'win32' ? 'C:\\Users\\a' : macHome,
      exists: (p) => present.includes(p),
      forced,
    });

  it('detects Ulanzi Studio on macOS from the app bundle or its data dir', () => {
    expect(detect('darwin', ['/Applications/Ulanzi Studio.app']).ulanzi).toBe(true);
    expect(detect('darwin', ['/Users/a/Library/Application Support/Ulanzi/UlanziDeck']).ulanzi).toBe(true);
    expect(detect('darwin', ['/Applications/Elgato Stream Deck.app'])).toEqual({
      streamDeck: true,
      ulanzi: false,
      forced: null,
    });
  });

  it('probes the (unverified) Windows Ulanzi locations', () => {
    expect(ulanziPaths('win32', winEnv, 'C:\\Users\\a')).toContain(
      'C:\\Users\\a\\AppData\\Roaming\\Ulanzi\\UlanziDeck',
    );
    expect(detect('win32', ['C:\\Program Files\\Ulanzi Studio'], null, winEnv).ulanzi).toBe(true);
    expect(detectSurfaces({ platform: 'linux', env: {}, home: '/home/a', exists: () => true, forced: null })).toEqual({
      streamDeck: false,
      ulanzi: false,
      forced: null,
    });
  });

  it('a Ulanzi-only machine never hears about a missing Stream Deck', () => {
    const probe = detect('win32', ['C:\\Users\\a\\AppData\\Roaming\\Ulanzi\\UlanziDeck'], null, winEnv);
    const lines = surfacePrereqLines(probe, 'win32');
    expect(lines).toEqual([{ level: 'ok', text: 'Ulanzi Studio installed' }]);
    expect(surfacePlan(probe, 'win32')).toBe('ulanzi');
  });

  it('neither host found lists both briefly instead of warning about one', () => {
    const lines = surfacePrereqLines(detect('darwin', []), 'darwin');
    expect(lines[0].level).toBe('warn');
    expect(lines.map((l) => l.text).join('\n')).toMatch(/Stream Deck.*Ulanzi Studio/s);
    expect(lines.map((l) => l.text).join('\n')).not.toContain('Stream Deck keys will be unavailable');
    expect(surfacePlan(detect('darwin', []), 'darwin')).toBe('unknown');
  });

  it('--surface overrides detection', () => {
    const forcedUlanzi = detect('win32', [], 'ulanzi', winEnv);
    expect(surfacePlan(forcedUlanzi, 'win32')).toBe('ulanzi');
    expect(surfacePrereqLines(forcedUlanzi, 'win32')[0]).toMatchObject({ level: 'warn' });
    expect(
      surfacePrereqLines(forcedUlanzi, 'win32')
        .map((l) => l.text)
        .join('\n'),
    ).not.toContain('Stream Deck');
    const sdPlusForcedUlanzi = detect('darwin', ['/Applications/Elgato Stream Deck.app'], 'ulanzi');
    expect(surfacePlan(sdPlusForcedUlanzi, 'darwin')).toBe('ulanzi');
  });

  it('both hosts, or Linux with none', () => {
    expect(
      surfacePlan(
        detect('darwin', ['/Applications/Elgato Stream Deck.app', '/Applications/Ulanzi Studio.app']),
        'darwin',
      ),
    ).toBe('both');
    expect(surfacePlan({ streamDeck: false, ulanzi: false, forced: null }, 'linux')).toBe('none');
    expect(surfacePrereqLines({ streamDeck: false, ulanzi: false, forced: null }, 'linux')).toEqual([]);
  });
});

describe('next steps text', () => {
  const text = (args: Parameters<typeof nextStepsLines>[0]) => nextStepsLines(args).join('\n');

  it('Ulanzi: daemon first with the OFFLINE consequence, then the Ulanzi Marketplace — no Stream Deck', () => {
    const t = text({ plan: 'ulanzi', platform: 'darwin', daemonInstalled: false, agentdeckCmd: 'agentdeck' });
    expect(t).toContain("1. Run 'agentdeck daemon install'");
    expect(t).toContain('macOS LaunchAgent) — until it runs, AgentDeck keys show OFFLINE');
    expect(t).toContain('Ulanzi Studio Marketplace');
    expect(t).toContain('https://ugc.ulanzistudio.com/contentView/1239890184745660416');
    expect(t).toContain('D200H / D200X');
    expect(t).not.toContain('Stream Deck');
  });

  it('Stream Deck keeps the existing steps', () => {
    const t = text({ plan: 'streamdeck', platform: 'win32', daemonInstalled: false, agentdeckCmd: 'agentdeck' });
    expect(t).toContain('Restart Stream Deck app');
    expect(t).toContain('Add AgentDeck actions to your Stream Deck profile');
    expect(t).toContain('Windows Scheduled Task');
    expect(t).not.toContain('Ulanzi');
  });

  it('unknown host lists both plugin links briefly', () => {
    const t = text({ plan: 'unknown', platform: 'darwin', daemonInstalled: false, agentdeckCmd: 'agentdeck' });
    expect(t).toContain('marketplace.elgato.com');
    expect(t).toContain('ugc.ulanzistudio.com');
  });

  it('Linux keeps the systemd/linger hint and no deck host', () => {
    const t = text({ plan: 'none', platform: 'linux', daemonInstalled: false, agentdeckCmd: 'agentdeck' });
    expect(t).toContain('systemd --user unit');
    expect(t).toContain('loginctl enable-linger');
    expect(t).not.toMatch(/Stream Deck|Ulanzi/);
  });

  it('a per-user install names the absolute CLI path the next terminal can run', () => {
    const t = text({
      plan: 'ulanzi',
      platform: 'darwin',
      daemonInstalled: false,
      agentdeckCmd: '/Users/a/.agentdeck/npm/bin/agentdeck',
    });
    expect(t).toContain("Run '/Users/a/.agentdeck/npm/bin/agentdeck daemon install'");
    expect(offlineNotice('/Users/a/.agentdeck/npm/bin/agentdeck').join('\n')).toContain(
      'OFFLINE until you run:  /Users/a/.agentdeck/npm/bin/agentdeck daemon install',
    );
  });

  it('with the daemon installed there is no daemon step', () => {
    const t = text({ plan: 'ulanzi', platform: 'darwin', daemonInstalled: true, agentdeckCmd: 'agentdeck' });
    expect(t).not.toContain('daemon install');
    expect(t).toContain('1. In Ulanzi Studio');
  });

  it('numbers steps sequentially and indents continuation lines', () => {
    const lines = nextStepsLines({
      plan: 'ulanzi',
      platform: 'darwin',
      daemonInstalled: false,
      agentdeckCmd: 'agentdeck',
    });
    const numbered = lines.filter((l) => /^\s+\d+\. /.test(l)).map((l) => Number(/(\d+)\./.exec(l)?.[1]));
    expect(numbered).toEqual([1, 2, 3, 4]);
  });
});

describe('daemon prompt gating', () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
  it('asks only at an interactive terminal without --yes and outside CI', () => {
    expect(shouldOfferDaemonPrompt({ autoInstallDaemon: false, ...tty })).toBe(true);
    expect(shouldOfferDaemonPrompt({ autoInstallDaemon: true, ...tty })).toBe(false);
    expect(shouldOfferDaemonPrompt({ autoInstallDaemon: false, ...tty, stdinIsTTY: undefined })).toBe(false);
    expect(shouldOfferDaemonPrompt({ autoInstallDaemon: false, ...tty, stdoutIsTTY: false })).toBe(false);
    expect(shouldOfferDaemonPrompt({ autoInstallDaemon: false, ...tty, env: { CI: 'true' } })).toBe(false);
    expect(shouldOfferDaemonPrompt({ autoInstallDaemon: false, ...tty, env: { CI: '0' } })).toBe(true);
  });

  it('defaults to No', () => {
    expect(['y', 'Y', 'yes', ' YES '].map(isYes)).toEqual([true, true, true, true]);
    expect(['', 'n', 'no', 'yeah', undefined, null].map(isYes)).toEqual([false, false, false, false, false, false]);
  });
});
