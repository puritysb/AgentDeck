#!/usr/bin/env node

import { execSync, spawn, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, accessSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import {
  type ClaudeProbe,
  type Surface,
  type SurfaceProbe,
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
  parseSurface,
  pathContains,
  planBridgeInstall,
  prependPathEntry,
  profileFileFor,
  profilePathLine,
  quoteWindowsArg,
  shouldOfferDaemonPrompt,
  surfacePlan,
  surfacePrereqLines,
  userPrefixDir,
} from './onboarding.js';

// ─── Colors ──────────────────────────────────────────────────────────

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const NC = '\x1b[0m';

function info(msg: string) {
  console.log(`${BLUE}[INFO]${NC} ${msg}`);
}
function ok(msg: string) {
  console.log(`${GREEN}[OK]${NC} ${msg}`);
}
function warn(msg: string) {
  console.log(`${YELLOW}[WARN]${NC} ${msg}`);
}
function fail(msg: string) {
  console.log(`${RED}[FAIL]${NC} ${msg}`);
}

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const SUPPORTED_NODE_MAJORS = [22, 24, 26] as const;

// ─── Options ─────────────────────────────────────────────────────────

export interface SetupOptions {
  /** Run `agentdeck daemon install` as part of setup instead of printing it as step N. */
  autoInstallDaemon: boolean;
  /** Install the daemon with a loopback-only posture (no LAN discovery, no scans). */
  enterprise: boolean;
  /** Install the Claude status-line relay even when no status line is configured
   *  (one that exists is wrapped by default). A configured status line hides
   *  Claude Code's footer hints, so this is never implied. */
  statusline: boolean;
  /** `--surface=ulanzi|streamdeck`: the deck host the next steps describe,
   *  overriding app detection (the Ulanzi plugin's OFFLINE screen can say
   *  which host it runs in). null = detect. */
  surface: Surface | null;
}

/**
 * Parse the flags `npx @agentdeck/setup` accepts.
 *
 * `--enterprise` implies `--yes`: an admin asking for the locked-down posture is
 * asking for a finished install, and a posture that is printed as a suggested
 * next step is not a posture. Unknown flags — and an unknown `--surface` value —
 * are ignored rather than fatal: `npx` users mistype, and refusing to install
 * over a typo is worse than ignoring it.
 */
export function parseSetupArgs(argv: readonly string[]): SetupOptions {
  const enterprise = argv.includes('--enterprise');
  let surface: Surface | null = null;
  argv.forEach((arg, i) => {
    if (arg.startsWith('--surface=')) surface = parseSurface(arg.slice('--surface='.length)) ?? surface;
    else if (arg === '--surface') surface = parseSurface(argv[i + 1]) ?? surface;
  });
  return {
    enterprise,
    autoInstallDaemon: enterprise || argv.includes('--yes') || argv.includes('-y'),
    statusline: argv.includes('--statusline'),
    surface,
  };
}

export function isSupportedNodeMajor(major: number): boolean {
  return (SUPPORTED_NODE_MAJORS as readonly number[]).includes(major);
}

function which(cmd: string): string | null {
  try {
    // `where` on Windows can print multiple lines (one per match); take the first.
    const probe = IS_WIN ? `where ${cmd}` : `which ${cmd}`;
    const out = execSync(probe, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// ─── 1. Banner ───────────────────────────────────────────────────────

function banner() {
  console.log('');
  console.log('=========================================');
  console.log('  AgentDeck Setup');
  console.log('=========================================');
  console.log('');
}

// ─── 2. Prerequisites ────────────────────────────────────────────────

interface Prerequisites {
  pass: boolean;
  claude: ClaudeProbe;
  surfaces: SurfaceProbe;
}

/**
 * Run `claude --version` with a timeout and its output captured. A launcher on
 * PATH is not a working CLI (the npm package's shim survives a postinstall that
 * never fetched the native binary), and the raw error belongs in one WARN line,
 * not on the terminal.
 */
function probeClaude(): ClaudeProbe {
  const found = Boolean(which('claude'));
  if (!found) return classifyClaudeProbe(false, null);
  const r = spawnSync('claude', ['--version'], {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: IS_WIN, // claude.cmd (npm) needs a shell on Windows
    windowsHide: true,
  });
  return classifyClaudeProbe(true, {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    error: (r.error as (Error & { code?: string }) | undefined) ?? null,
  });
}

function checkPrerequisites(opts: SetupOptions): Prerequisites {
  let pass = true;

  // Only maintained, prebuild-verified even Node lines. Node 20 reached EOL in
  // April 2026; accepting every integer >=22 also accidentally promised the
  // short-lived odd releases whose native-module prebuilds are removed first.
  const major = parseInt(process.version.replace('v', '').split('.')[0], 10);
  if (isSupportedNodeMajor(major)) {
    ok(`Node.js ${process.version}`);
  } else {
    fail(`Node.js ${process.version} — supported versions are 22, 24, and 26 (Node 20 reached EOL in April 2026)`);
    pass = false;
  }

  // Build tooling — NOT a hard requirement. installBridge tries node-pty's
  // prebuilt binary first and only falls back to a source build, which is the
  // sole thing that needs a compiler. Demanding CLT up front made every user
  // install Xcode tooling for a fallback most of them never hit.
  // Windows always uses the prebuilt binary.
  if (IS_LINUX) {
    // On Linux the source-build fallback needs a C/C++ toolchain + make;
    // python3 is required by node-gyp and by the hook shell.
    const hasCompiler = which('cc') || which('gcc');
    if (hasCompiler && which('make') && which('python3')) {
      ok('Build toolchain (cc/make/python3) installed');
    } else {
      warn('Build toolchain missing — only needed if the prebuilt node-pty binary does not work.');
      console.log(`     Debian/Ubuntu: ${YELLOW}sudo apt install build-essential python3${NC}`);
      console.log(`     Fedora:        ${YELLOW}sudo dnf install gcc-c++ make python3${NC}`);
      console.log(`     Arch:          ${YELLOW}sudo pacman -S base-devel python${NC}`);
    }
  } else if (!IS_WIN) {
    if (which('xcode-select') && checkXcodeCliTools()) {
      ok('Xcode Command Line Tools installed');
    } else {
      warn('Xcode Command Line Tools not installed — only needed if the prebuilt node-pty binary does not work.');
      console.log(
        `     If the install below fails, run: ${YELLOW}xcode-select --install${NC} and re-run this command.`,
      );
    }
  }

  const claude = probeClaude();
  const hasClaude = claude.state !== 'missing';
  const hasCodex = Boolean(which('codex'));

  // Agent CLIs are optional, like the Stream Deck app below: the daemon and
  // device surfaces install and run without one, and sessions appear as soon
  // as an agent shows up later. Hard-failing here blocked `npx @agentdeck/setup`
  // on machines that only had the Claude/ChatGPT desktop apps (Ulanzi review,
  // 2026-08).
  if (claude.state === 'ok') {
    ok(`Claude Code CLI ${claude.version ?? 'found'}`);
  } else if (claude.state === 'broken') {
    // Hooks are still installed below: they are inert until claude runs, and
    // a reinstall should not need a second setup run.
    warn('Claude Code CLI is installed but not runnable — reinstall Claude Code.');
    console.log(`     claude --version: ${claude.detail}`);
    console.log('     Reinstall: https://code.claude.com/docs/en/setup (hooks are installed anyway)');
  } else {
    warn('Claude Code CLI not found — Claude sessions will be unavailable');
    console.log('     Install with: npm install -g @anthropic-ai/claude-code');
  }

  if (hasCodex) {
    ok('Codex CLI found');
  } else {
    warn('Codex CLI not found — Codex sessions will be unavailable');
  }

  if (!hasClaude && !hasCodex) {
    warn('No coding-agent CLI found — setup continues; sessions appear once an agent is installed.');
    console.log('     Claude Code: npm install -g @anthropic-ai/claude-code   Codex: npm install -g @openai/codex');
  }

  // Deck host apps are surfaces, not requirements: the daemon runs headless and
  // drives the Ulanzi D200H/D200X (through Ulanzi Studio), the macOS app, the
  // TUI dashboard and ESP32 boards without the Elgato app. Only a host the user
  // actually uses is reported; a missing one they do not use is not a warning
  // (a D200H-only Windows user was told Stream Deck keys would be unavailable).
  const surfaces = detectSurfaces({
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: existsSync,
    forced: opts.surface,
  });
  for (const line of surfacePrereqLines(surfaces, process.platform)) {
    if (line.level === 'ok') ok(line.text);
    else if (line.level === 'warn') warn(line.text);
    else console.log(line.text);
  }

  if (!pass) {
    console.log('');
    fail('Required dependencies missing. Please install them and re-run.');
  }

  return { pass, claude, surfaces };
}

/// Returns true when `xcode-select -p` reports a valid developer directory.
/// On macOS without CLT installed the command exits non-zero and prints
/// a system dialog prompting the user to install; we treat both as "missing".
function checkXcodeCliTools(): boolean {
  try {
    const path = execSync('xcode-select -p', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // `xcode-select -p` returns the dev dir path even if the user cancelled
    // the install prompt — verify the path actually exists on disk.
    return path.length > 0 && existsSync(path);
  } catch {
    return false;
  }
}

// ─── 3. Stream Deck CLI ──────────────────────────────────────────────

// ─── 4. Install Bridge (agentdeck CLI) ──────────────────────────────

interface BridgeInstall {
  /** The per-user prefix the bridge went into, or null for npm's default global prefix. */
  userPrefix: string | null;
  /** How to spell the CLI in the user's NEXT terminal (absolute when their shell has not picked the prefix up yet). */
  agentdeckCmd: string;
}

/** `npm prefix -g`, or null when npm cannot answer (that is no evidence either way). */
function npmGlobalPrefix(): string | null {
  try {
    const out = execSync('npm prefix -g', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Run npm with stdout on the terminal and stderr both shown and captured, so a
 * failure can be classified instead of collapsing into "Command failed".
 */
function runNpm(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = IS_WIN
      ? spawn(['npm', ...args.map(quoteWindowsArg)].join(' '), {
          shell: true,
          env,
          stdio: ['inherit', 'inherit', 'pipe'],
          windowsHide: true,
        })
      : spawn('npm', args, { env, stdio: ['inherit', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    child.on('error', (err) => resolve({ code: null, stderr: `${stderr}\n${err.message}` }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/** The toolchain a node-pty source build needs; exits with instructions when it is missing. */
function requireSourceBuildToolchain() {
  if (IS_LINUX) {
    const hasCompiler = which('cc') || which('gcc');
    if (!(hasCompiler && which('make') && which('python3'))) {
      fail('A source build needs a C/C++ toolchain (cc/make/python3).');
      console.log(`       Debian/Ubuntu: ${YELLOW}sudo apt install build-essential python3${NC}`);
      console.log('       Then re-run `npx @agentdeck/setup`.');
      process.exit(1);
    }
  } else if (!(which('xcode-select') && checkXcodeCliTools())) {
    fail('A source build needs Xcode Command Line Tools.');
    console.log(`       Install with: ${YELLOW}xcode-select --install${NC}`);
    console.log('       Then re-run `npx @agentdeck/setup`.');
    process.exit(1);
  }
}

/**
 * Make a per-user-prefix CLI reachable: now (this process's PATH, which every
 * later step — `agentdeck diag native`, `agentdeck daemon install` — resolves
 * through) and in future terminals (one marked line in the login-shell profile).
 * The autostart units do not depend on PATH: they bake the absolute node and
 * cli.js paths (`getDaemonNodeTarget` in bridge/src).
 *
 * Windows' persistent user PATH is NOT edited: `setx` truncates at 1024
 * characters, and a read-modify-write through `reg`/.NET risks flattening
 * `%VAR%` references or the value type on a machine we cannot verify against.
 * The default Windows prefix (%APPDATA%\npm) is user-writable, so this branch
 * is rare there; it prints exact instructions instead.
 */
function makeUserPrefixReachable(binDir: string): string {
  const original = process.env.PATH;
  process.env.PATH = prependPathEntry(original, binDir, process.platform);
  const absoluteCmd = join(binDir, 'agentdeck');
  if (pathContains(original, binDir, process.platform)) return 'agentdeck';

  if (IS_WIN) {
    warn(`Add ${binDir} to your user PATH so new terminals find 'agentdeck':`);
    console.log('     Settings → System → About → Advanced system settings → Environment Variables →');
    console.log(`     User variables → Path → Edit → New → ${binDir}`);
    console.log('     Daemon autostart does not need this — the Scheduled Task uses absolute paths.');
    return `"${absoluteCmd}"`;
  }

  const home = homedir();
  const line = profilePathLine(binDir, home);
  const exportOnly = line.split(' # ')[0];
  const profile = profileFileFor({
    platform: process.platform,
    shell: process.env.SHELL,
    home,
    zdotdir: process.env.ZDOTDIR,
    exists: existsSync,
  });
  if (!profile) {
    warn(`Your shell (${process.env.SHELL ?? 'unknown'}) is not one setup edits — add this to its startup file:`);
    console.log(`     ${exportOnly}`);
    return absoluteCmd;
  }
  try {
    const outcome = ensureProfilePathLine(profile, line);
    if (outcome === 'present') ok(`${profile} already puts ${binDir} on PATH`);
    else ok(`${outcome === 'added' ? 'Added' : 'Updated'} one PATH line in ${profile} (marked "# added by @agentdeck/setup")`);
    info(`Open a new terminal (or run: source ${profile}) to use 'agentdeck' there.`);
  } catch (err) {
    warn(`Could not update ${profile}: ${(err as Error).message}`);
    console.log(`     Add this line yourself: ${exportOnly}`);
  }
  return absoluteCmd;
}

async function installBridge(): Promise<BridgeInstall> {
  info('Installing AgentDeck bridge (@agentdeck/bridge)...');

  // Where to install. A root-owned global prefix (system Node from the
  // nodejs.org installer: /usr/local) is the common case on a fresh Mac, and
  // the answer is a per-user prefix — never sudo, which would leave root-owned
  // files the daemon later cannot update.
  const home = homedir();
  const userPrefix = userPrefixDir(home, process.platform);
  const globalPrefix = npmGlobalPrefix();
  const plan = planBridgeInstall({
    globalPrefix,
    platform: process.platform,
    home,
    fs: { existsSync, accessSync },
  });
  let prefix = plan.prefix;
  if (plan.reason === 'unwritable') {
    warn(`npm's global prefix (${globalPrefix}) is not writable by this user (${plan.blocking}).`);
    info(`Installing into a per-user prefix instead, no sudo needed: ${prefix}`);
  } else if (plan.reason === 'existing-user-install') {
    info(`Updating the existing per-user install in ${prefix}`);
  }

  // Prebuilt first. This used to force `npm_config_build_from_source=true` on
  // macOS because of a node-pty prebuilt ABI mismatch (#3), which made a
  // working compiler mandatory for every user. Try the prebuilt binary, and
  // only pay the source-build cost — and its Xcode CLT requirement — if the
  // prebuilt one actually fails TO BUILD (classifyNpmFailure). A permission
  // error is never retried as a source build: it fails identically. Windows
  // has always used the prebuilt binary: a source build there needs Visual
  // Studio Build Tools.
  let sourceBuild = false;
  for (;;) {
    const env = sourceBuild ? { ...process.env, npm_config_build_from_source: 'true' } : process.env;
    const result = await runNpm(npmInstallArgs(prefix), env);
    if (result.code === 0) break;

    const failure = classifyNpmFailure(result.stderr);
    const next = decideRetry(failure, {
      usingUserPrefix: prefix === userPrefix,
      sourceBuildTried: sourceBuild,
      platform: process.platform,
    });
    if (next === 'user-prefix') {
      prefix = userPrefix;
      const where = failure.kind === 'permission' && failure.path ? failure.path : 'the global prefix';
      console.log('');
      warn(`npm could not write to ${where} (EACCES).`);
      info(`Retrying in a per-user prefix, no sudo needed: ${prefix}`);
      continue;
    }
    if (next === 'source-build') {
      console.log('');
      warn('The prebuilt native module failed — retrying with a source build of node-pty.');
      requireSourceBuildToolchain();
      sourceBuild = true;
      continue;
    }

    console.log('');
    if (failure.kind === 'permission') {
      fail(`npm install failed: ${failure.code} — permission denied${failure.path ? ` on ${failure.path}` : ''}.`);
      if (failure.code === 'EPERM' && IS_WIN) {
        console.log('       A file is probably in use. Stop the daemon (agentdeck daemon stop), close other');
        console.log('       terminals running agentdeck, then re-run `npx @agentdeck/setup`.');
      } else {
        console.log('       Check who owns that path, or point npm at a user-owned prefix, then re-run.');
      }
      console.log('       Do not re-run setup with sudo.');
    } else {
      fail('npm install -g @agentdeck/bridge failed. npm reported:');
      for (const l of failure.tail.split('\n')) console.log(`       ${l}`);
    }
    process.exit(1);
  }

  let agentdeckCmd = 'agentdeck';
  if (prefix) {
    ok(`Installed into per-user prefix ${prefix}`);
    agentdeckCmd = makeUserPrefixReachable(globalInstallTargets(prefix, process.platform).bin);
  }

  if (which('agentdeck')) {
    ok('agentdeck CLI installed');
  } else {
    fail('agentdeck CLI not found after install — check npm global path');
    process.exit(1);
  }
  return { userPrefix: prefix, agentdeckCmd };
}

/**
 * Exercise the native database with the same `agentdeck` launcher that the
 * daemon installer will use. `better-sqlite3` is optional at the npm layer so
 * a failed install otherwise exits zero and leaves all APME data collection
 * disabled. This remains a warning rather than making the whole daemon
 * unavailable: session/device control has a deliberate no-APME fallback.
 */
function checkBridgeNativeRuntime() {
  try {
    const raw = execSync('agentdeck diag native --json', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(raw) as {
      ok?: boolean;
      runtime?: { node?: string; modulesAbi?: string; executable?: string };
      betterSqlite3?: { status?: string; version?: string; error?: string; recovery?: string };
    };
    if (report.ok && report.betterSqlite3?.status === 'ready') {
      ok(
        `APME native database ready (better-sqlite3 ${report.betterSqlite3.version ?? 'unknown'}, Node ABI ${report.runtime?.modulesAbi ?? 'unknown'})`,
      );
      return;
    }
    warn('AgentDeck installed, but APME run/turn/task evaluation is unavailable.');
    if (report.runtime?.executable)
      console.log(
        `     Runtime: ${report.runtime.node ?? 'unknown'} ABI ${report.runtime.modulesAbi ?? 'unknown'} — ${report.runtime.executable}`,
      );
    if (report.betterSqlite3?.error) console.log(`     Reason: ${report.betterSqlite3.error}`);
    console.log(`     ${report.betterSqlite3?.recovery ?? 'Run `agentdeck diag native` for recovery details.'}`);
  } catch (err) {
    const stdout = (err as { stdout?: Buffer | string }).stdout?.toString().trim();
    if (stdout) {
      try {
        const report = JSON.parse(stdout) as {
          runtime?: { node?: string; modulesAbi?: string; executable?: string };
          betterSqlite3?: { error?: string; recovery?: string };
        };
        warn('AgentDeck installed, but APME run/turn/task evaluation is unavailable.');
        if (report.runtime?.executable)
          console.log(
            `     Runtime: ${report.runtime.node ?? 'unknown'} ABI ${report.runtime.modulesAbi ?? 'unknown'} — ${report.runtime.executable}`,
          );
        if (report.betterSqlite3?.error) console.log(`     Reason: ${report.betterSqlite3.error}`);
        console.log(`     ${report.betterSqlite3?.recovery ?? 'Run `agentdeck diag native` for recovery details.'}`);
        return;
      } catch {
        /* fall through to the command-level diagnostic */
      }
    }
    warn('Could not verify the APME native database. Run `agentdeck diag native` before relying on evaluation data.');
  }
}

// ─── 5. Install Hooks (inlined from @agentdeck/hooks) ────────────────

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'Notification',
  // Display-only, fire-and-forget — see @agentdeck/hooks HOOK_EVENTS.
  'PermissionRequest',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'TaskCompleted',
  'TeammateIdle',
] as const;

/**
 * Kept byte-identical with `@agentdeck/hooks` `buildHookCommand` and the
 * Swift `HookInstaller.buildHookEntry` snippet. Any change here MUST be
 * mirrored in those two places, otherwise users installing via different
 * paths end up with inconsistent daemon discovery. See `hooks/src/install.ts`
 * for the canonical commentary.
 */
function buildHookCommand(eventName: string): string {
  const preamble = [
    `PORT="\${AGENTDECK_PORT:-}"`,
    `case "$PORT" in ''|*[!0-9]*) PORT="" ;; *) [ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ] 2>/dev/null || PORT="" ;; esac`,
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -I -c "import json,sys,signal;signal.signal(signal.SIGALRM,lambda *_:sys.exit(0));signal.setitimer(signal.ITIMER_REAL,0.2);d=json.load(open(sys.argv[1]));p=d.get('httpPort') or d.get('port');print(p if type(p) is int and 1 <= p <= 65535 else '')" "$F" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --connect-timeout 0.2 --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `  done`,
    `fi`,
    `[ -n "$PORT" ] || exit 0`,
  ];
  // PreToolUse long-poll (device approval) — see canonical commentary in hooks/src/install.ts.
  if (eventName === 'PreToolUse') {
    return preamble
      .concat([
        `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/PreToolUse" -H 'Content-Type: application/json' -H "X-AgentDeck-Pid: $PPID" --max-time 60 -d @- 2>/dev/null)`,
        `printf '%s' "\${RESP:-}"`,
      ])
      .join('\n');
  }
  // Stop is request-response too (turn-end directive queue) — short --max-time
  // since it runs on every turn end. See hooks/src/install.ts.
  if (eventName === 'Stop') {
    return preamble
      .concat([
        `RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/hooks/Stop" -H 'Content-Type: application/json' -H "X-AgentDeck-Pid: $PPID" --max-time 10 -d @- 2>/dev/null)`,
        `printf '%s' "\${RESP:-}"`,
      ])
      .join('\n');
  }
  // Fire-and-forget telemetry — bounded timeouts are mandatory so a restarting
  // daemon can't hold the socket past Claude's ~1.5s SessionEnd abort budget.
  // See hooks/src/install.ts.
  return preamble
    .concat([
      `curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/hooks/${eventName}" -H 'Content-Type: application/json' -H "X-AgentDeck-Pid: $PPID" -d @- >/dev/null 2>&1 || true`,
    ])
    .join('\n');
}

/**
 * The Windows hook body — kept byte-identical with `@agentdeck/hooks`
 * `WINDOWS_HOOK_SCRIPT`. This package deliberately has no workspace deps
 * because it bootstraps them, hence the copy.
 *
 * It MUST stay a script file, not an inlined `-Command`: Claude Code runs hook
 * commands through a POSIX shell on Windows (Git Bash, `sh -c`), which expands
 * every `$name` before `powershell.exe` parses the line, leaving syntactic
 * garbage that fails on every hook of every turn.
 */
const WINDOWS_HOOK_SCRIPT = `# AgentDeck -> Claude Code hook bridge. Generated by @agentdeck/hooks; edits are overwritten.
# Invoked as: powershell -NoProfile -ExecutionPolicy Bypass -File "<this file>" -HookEvent <EventName>
#
# Must be a script file, NOT an inline -Command: Claude Code runs hook commands
# through Git Bash (sh -c) on Windows, which expands \$var references away before
# PowerShell sees them.
param([Parameter(Mandatory = \$true)][ValidatePattern('^[A-Za-z_]+\$')][string]\$HookEvent)

\$ErrorActionPreference = 'SilentlyContinue'

# PreToolUse and Stop are request-response, as in the POSIX hook: the daemon's
# answer (a device Allow/Deny, a soft-STOP deny, a queued deck directive) is
# written to stdout for Claude Code, bounded like the POSIX curl --max-time
# (60 s / 10 s). Every other event is fire-and-forget: bounded like --max-time
# 0.8, nothing printed.
\$timeoutMs = 800
\$respond = \$false
if (\$HookEvent -ceq 'PreToolUse') { \$timeoutMs = 60000; \$respond = \$true }
elseif (\$HookEvent -ceq 'Stop') { \$timeoutMs = 10000; \$respond = \$true }

# A valid explicit port is trusted as on POSIX. Otherwise discover one healthy
# registry candidate; no candidate means no observation request.
\$ports = @()
\$candidate = 0
if ([int]::TryParse([string]\$env:AGENTDECK_PORT, [ref]\$candidate) -and \$candidate -ge 1 -and \$candidate -le 65535) {
  \$ports = @(\$candidate)
} else {
  \$f = Join-Path \$env:USERPROFILE '.agentdeck\\daemon.json'
  if (Test-Path \$f) {
    try {
      \$d = Get-Content -Raw \$f | ConvertFrom-Json
      \$raw = if (\$d.httpPort) { \$d.httpPort } else { \$d.port }
      \$candidate = 0
      if ([int]::TryParse([string]\$raw, [ref]\$candidate) -and \$candidate -ge 1 -and \$candidate -le 65535) {
        \$probe = [System.Net.WebRequest]::Create('http://127.0.0.1:' + \$candidate + '/health')
        \$probe.Proxy = \$null
        \$probe.Timeout = 300; \$probe.ReadWriteTimeout = 300
        \$response = \$probe.GetResponse(); \$response.Close()
        \$ports = @(\$candidate)
      }
    } catch {}
  }
}
if (\$ports.Count -eq 0) { exit 0 }

# Read stdin as UTF-8: [Console]::In decodes piped stdin with the console OEM
# codepage (e.g. CP949), garbling non-ASCII payload text.
\$body = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)).ReadToEnd()
# Post UTF-8 bytes with an explicit charset; the daemon reads them as sent.
\$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]\$body)

# A loopback POST needs no proxy: system proxy auto-detection (WPAD) and the
# Expect: 100-continue wait can each add seconds before the request is sent.
try { [System.Net.WebRequest]::DefaultWebProxy = \$null } catch {}
try { [System.Net.ServicePointManager]::Expect100Continue = \$false } catch {}

foreach (\$port in \$ports) {
  try {
    \$req = [System.Net.HttpWebRequest]::Create('http://127.0.0.1:' + \$port + '/hooks/' + \$HookEvent)
    \$req.Method = 'POST'
    \$req.Proxy = \$null
    \$req.ContentType = 'application/json; charset=utf-8'
    \$req.Timeout = \$timeoutMs
    \$req.ReadWriteTimeout = \$timeoutMs
    \$req.ContentLength = \$bytes.Length
    \$stream = \$req.GetRequestStream()
    \$stream.Write(\$bytes, 0, \$bytes.Length)
    \$stream.Close()
    \$resp = \$req.GetResponse()
    if (\$respond) {
      # Pass the daemon's UTF-8 bytes through unchanged: a console encoding
      # would turn a non-ASCII directive or reason into '?'.
      \$buffer = New-Object System.IO.MemoryStream
      \$resp.GetResponseStream().CopyTo(\$buffer)
      \$out = \$buffer.ToArray()
      if (\$out.Length -gt 0) {
        \$stdout = [Console]::OpenStandardOutput()
        \$stdout.Write(\$out, 0, \$out.Length)
        \$stdout.Flush()
      }
    }
    \$resp.Close()
    break
  } catch {
    # Never retry a payload against another receiver.
    break
  }
}

# Never block or fail the tool call.
exit 0
`;

/** Where the Windows hook script is installed — mirrors `windowsHookScriptPath`. */
function windowsHookScriptPath(): string {
  return join(homedir(), '.agentdeck', 'agentdeck-hook.ps1');
}

/** Write the script, creating `~/.agentdeck` if needed. Idempotent. */
function ensureWindowsHookScript(): string {
  const path = windowsHookScriptPath();
  mkdirSync(join(homedir(), '.agentdeck'), { recursive: true });
  if (!existsSync(path) || readFileSync(path, 'utf-8') !== WINDOWS_HOOK_SCRIPT) {
    writeFileSync(path, WINDOWS_HOOK_SCRIPT);
  }
  return path;
}

/** Windows variant — kept in sync with `@agentdeck/hooks` `buildHookCommandWin`. */
function buildHookCommandWin(eventName: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${windowsHookScriptPath()}" -HookEvent ${eventName}`;
}

/**
 * Does this command belong to AgentDeck? Mirrors `@agentdeck/hooks`
 * `isAgentDeckHookCommand`. The `-File` Windows form carries neither
 * `AGENTDECK_PORT` nor `localhost:9120`, so a two-marker test leaves it behind
 * on reinstall and the settings file grows one live hook per install.
 */
function isAgentDeckHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return command.includes('AGENTDECK_PORT')
    || command.includes('localhost:9120')
    || command.includes('agentdeck-hook.ps1');
}

function isAgentDeckHookEntry(entry: any): boolean {
  if (isAgentDeckHookCommand(entry?.command)) return true;
  return Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => isAgentDeckHookCommand(h?.command));
}

function buildHookEntry(eventName: string) {
  const needsToolMatcher = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(eventName);
  const command = IS_WIN ? buildHookCommandWin(eventName) : buildHookCommand(eventName);
  return {
    matcher: needsToolMatcher ? '*' : '',
    hooks: [
      {
        type: 'command',
        command,
      },
    ],
  };
}

// ─── Claude status-line relay (inlined copy of @agentdeck/hooks) ─────────────
// Byte-identical with `hooks/src/install.ts` `buildStatuslineRelayCommand` and
// Swift `HookInstaller.buildStatuslineRelayCommand` — change all three together.
// The canonical commentary lives in hooks/src/install.ts.

const STATUSLINE_RELAY_MARKER = '/claude/statusline';
const STATUSLINE_RELAY_HEADER = '# AgentDeck status-line relay v1 — forwards Claude Code rate_limits to the local daemon; the status line you had runs below, unchanged.';
const STATUSLINE_WRAP_OPEN = `printf '%s' "$I" | {`;

function buildStatuslineRelayCommand(original?: string | null): string {
  const lines = [
    STATUSLINE_RELAY_HEADER,
    `I=$(cat)`,
    `PORT=""`,
    `for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `  [ -f "$F" ] || continue`,
    `  P=$(python3 -I -c "import json,sys,signal;signal.signal(signal.SIGALRM,lambda *_:sys.exit(0));signal.setitimer(signal.ITIMER_REAL,0.2);d=json.load(open(sys.argv[1]));p=d.get('httpPort') or d.get('port');print(p if type(p) is int and 1 <= p <= 65535 else '')" "$F" 2>/dev/null)`,
    `  [ -n "$P" ] && curl -sf --connect-timeout 0.2 --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `done`,
    `if [ -n "$PORT" ]; then`,
    `printf '%s' "$I" | curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/claude/statusline" -H 'Content-Type: application/json' -H "X-AgentDeck-Pid: $PPID" -d @- >/dev/null 2>&1 || true`,
    `fi`,
  ];
  const own = original?.trim();
  if (own) lines.push(STATUSLINE_WRAP_OPEN, own, `}`);
  return lines.join('\n');
}

/** Windows relay body — byte-identical with `@agentdeck/hooks` WINDOWS_STATUSLINE_SCRIPT. */
const WINDOWS_STATUSLINE_SCRIPT = `# AgentDeck -> Claude Code status-line relay. Generated by @agentdeck/hooks; edits are overwritten.
# Invoked as: powershell -NoProfile -ExecutionPolicy Bypass -File "<this file>" [-OriginalB64 <base64 of your own status-line command>]
#
# Must be a script file, NOT an inline -Command, for the reason agentdeck-hook.ps1
# documents: when installed, Git Bash (sh -c) expands \$var references before
# PowerShell sees them. Your own command travels as
# base64 for the same reason.
param([ValidatePattern('^[A-Za-z0-9+/=]*\$')][string]\$OriginalB64 = '')

\$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding(\$false) } catch {}

# Read stdin as UTF-8: [Console]::In decodes piped stdin with the console OEM
# codepage (e.g. CP949), garbling non-ASCII payload text.
\$body = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)).ReadToEnd()

\$port = 0
\$f = Join-Path \$env:USERPROFILE '.agentdeck\\daemon.json'
if (Test-Path \$f) {
  try {
    \$d = Get-Content -Raw \$f | ConvertFrom-Json
    \$raw = if (\$d.httpPort) { \$d.httpPort } else { \$d.port }
    \$candidate = 0
    if ([int]::TryParse([string]\$raw, [ref]\$candidate) -and \$candidate -ge 1 -and \$candidate -le 65535) {
      try {
        \$probe = [System.Net.WebRequest]::Create('http://127.0.0.1:' + \$candidate + '/health')
        \$probe.Proxy = \$null
        \$probe.Timeout = 300; \$probe.ReadWriteTimeout = 300
        \$response = \$probe.GetResponse(); \$response.Close()
        \$port = \$candidate
      } catch {}
    }
  } catch {}
}
# Post UTF-8 bytes; the daemon keeps only rate_limits (shared/src/claude-statusline.ts).
\$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]\$body)
if (\$port -gt 0) {
  try {
    Invoke-RestMethod -Uri ('http://127.0.0.1:' + \$port + '/claude/statusline') -Method Post -Body \$bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 2 -ErrorAction Stop | Out-Null
  } catch {}
}

# Your own status line, when one was wrapped: the same document on its stdin,
# its output is what Claude Code shows. Match Claude Code's Windows shell choice:
# Git Bash when available, otherwise the PowerShell running this relay.
if (\$OriginalB64) {
  \$script = \$null
  try {
    \$original = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\$OriginalB64))
    \$sh = \$env:CLAUDE_CODE_GIT_BASH_PATH
    if (-not \$sh -or -not (Test-Path \$sh)) { \$sh = (Get-Command bash -ErrorAction SilentlyContinue).Source }
    \$psi = New-Object System.Diagnostics.ProcessStartInfo
    if (\$sh) {
      \$script = [System.IO.Path]::GetTempFileName()
      [System.IO.File]::WriteAllText(\$script, \$original, (New-Object System.Text.UTF8Encoding(\$false)))
      \$psi.FileName = \$sh
      \$psi.Arguments = '"' + \$script.Replace('\\', '/') + '"'
    } else {
      \$psi.FileName = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
      # PowerShell captures its stdin reader before running a command that uses
      # the input variable. Parse the user's command after selecting UTF-8 and
      # feed that pipeline explicitly; leave raw stdin untouched otherwise.
      \$command = @'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding(\$false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding(\$false)
\$OutputEncoding = [Console]::OutputEncoding
\$userCommand = [ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__AGENTDECK_ORIGINAL__')))
\$usesInput = \$userCommand.Ast.Find({
  param(\$node)
  \$node -is [System.Management.Automation.Language.VariableExpressionAst] -and
    \$node.VariablePath.IsVariable -and
    \$node.VariablePath.UserPath -match '^(?:variable:)?(?:(?:global|local|script|private):)?input\$'
}, \$false)
if (\$usesInput) {
  & { while ((\$line = [Console]::In.ReadLine()) -ne \$null) { \$line } } | & \$userCommand
} else {
  & \$userCommand
}
'@
      \$command = \$command.Replace('__AGENTDECK_ORIGINAL__', \$OriginalB64)
      \$psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes(\$command))
    }
    \$psi.UseShellExecute = \$false
    \$psi.CreateNoWindow = \$true
    \$psi.RedirectStandardInput = \$true
    \$psi.RedirectStandardOutput = \$true
    \$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    \$p = [System.Diagnostics.Process]::Start(\$psi)
    \$stdin = New-Object System.IO.StreamWriter(\$p.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding(\$false)))
    \$stdin.Write(\$body)
    \$stdin.Close()
    \$out = \$p.StandardOutput.ReadToEnd()
    \$p.WaitForExit()
    [Console]::Out.Write(\$out)
  } catch {} finally {
    if (\$script) { Remove-Item \$script -Force }
  }
}

# Never block or fail the status line.
exit 0
`;

function windowsStatuslineScriptPath(): string {
  return join(homedir(), '.agentdeck', 'agentdeck-statusline.ps1');
}

/** Write the Windows relay script, creating `~/.agentdeck` if needed. Idempotent. */
function ensureWindowsStatuslineScript(): string {
  const path = windowsStatuslineScriptPath();
  mkdirSync(join(homedir(), '.agentdeck'), { recursive: true });
  if (!existsSync(path) || readFileSync(path, 'utf-8') !== WINDOWS_STATUSLINE_SCRIPT) {
    writeFileSync(path, WINDOWS_STATUSLINE_SCRIPT);
  }
  return path;
}

/** Windows variant — kept in sync with `@agentdeck/hooks` `buildStatuslineRelayCommandWin`. */
function buildStatuslineRelayCommandWin(original?: string | null): string {
  const base = `powershell -NoProfile -ExecutionPolicy Bypass -File "${windowsStatuslineScriptPath()}"`;
  const own = original?.trim();
  return own ? `${base} -OriginalB64 ${Buffer.from(own, 'utf-8').toString('base64')}` : base;
}

function unwrapStatuslineCommand(command: unknown): string | null {
  if (typeof command !== 'string') return null;
  if (command.includes('agentdeck-statusline.ps1')) {
    const encoded = /-OriginalB64 ([A-Za-z0-9+/=]+)/.exec(command);
    return encoded ? Buffer.from(encoded[1], 'base64').toString('utf-8') : '';
  }
  if (!command.includes(STATUSLINE_RELAY_MARKER)) return null;
  const open = `\n${STATUSLINE_WRAP_OPEN}\n`;
  const at = command.indexOf(open);
  if (at < 0) return '';
  const body = command.slice(at + open.length);
  return body.endsWith('\n}') ? body.slice(0, -2) : body;
}

/**
 * Wrap the status line the user already has (or refresh ours); install a
 * relay-only status line only on `--statusline` / `AGENTDECK_STATUSLINE=1`.
 * Returns a one-line outcome for the log.
 */
function applyStatuslineRelay(settings: any, optIn: boolean): string {
  const env = (process.env.AGENTDECK_STATUSLINE ?? '').trim().toLowerCase();
  if (env === '0' || env === 'off' || env === 'false') {
    // `off` takes an installed relay out again and never adds one.
    const own = unwrapStatuslineCommand(settings.statusLine?.command);
    if (own == null) return 'Claude status-line relay not installed: disabled (AGENTDECK_STATUSLINE=0)';
    if (own) settings.statusLine = { ...settings.statusLine, command: own };
    else delete settings.statusLine;
    return 'Claude status-line relay removed — your own status line is restored';
  }
  const enable = optIn || env === '1' || env === 'on' || env === 'true';
  const current = settings.statusLine;
  if (current != null && (typeof current !== 'object' || Array.isArray(current))) {
    return 'Claude status-line relay not installed: statusLine is not an object; left untouched';
  }
  const command = current?.command;
  const ours = typeof command === 'string'
    && (command.includes(STATUSLINE_RELAY_MARKER) || command.includes('agentdeck-statusline.ps1'));
  if (current && !ours && typeof command !== 'string') {
    return 'Claude status-line relay not installed: statusLine carries no command; left untouched';
  }
  const original = ours ? unwrapStatuslineCommand(command) ?? '' : (typeof command === 'string' ? command : '');
  if (!original.trim() && !ours && !enable) {
    return 'Claude status-line relay not installed: no status line configured — opt in with --statusline (a configured status line hides Claude Code\'s footer hints)';
  }
  settings.statusLine = {
    ...(current ?? {}),
    type: 'command',
    command: IS_WIN ? buildStatuslineRelayCommandWin(original) : buildStatuslineRelayCommand(original),
  };
  if (IS_WIN) ensureWindowsStatuslineScript();
  return original.trim() ? 'Claude status-line relay wrapped around your status line' : 'Claude status-line relay installed (relay only)';
}

/**
 * Strip AgentDeck hooks out of the unwatched `~/.claude/settings.local.json`
 * left behind by installs that predate the settings.json move. Inlined copy of
 * `@agentdeck/hooks` `sweepLegacyHooks` — this package deliberately has no
 * workspace deps because it bootstraps them.
 */
function sweepLegacyHooks(claudeDir: string) {
  const legacyPath = join(claudeDir, 'settings.local.json');
  if (!existsSync(legacyPath)) return;

  try {
    const raw = readFileSync(legacyPath, 'utf-8');
    if (!raw.includes('AGENTDECK_PORT') && !raw.includes('localhost:9120')
      && !raw.includes('agentdeck-hook.ps1')) return;

    const settings: any = JSON.parse(raw);
    if (!settings.hooks) return;

    const isOurs = (h: any) => isAgentDeckHookEntry(h);

    for (const event of HOOK_EVENTS) {
      if (!Array.isArray(settings.hooks[event])) continue;
      settings.hooks[event] = settings.hooks[event].filter((h: any) => !isOurs(h));
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    writeFileSync(legacyPath, JSON.stringify(settings, null, 2) + '\n');
    ok('Removed stale hooks from ~/.claude/settings.local.json (never read by Claude Code)');
  } catch {
    // Best effort — a malformed legacy file must not block a fresh install
  }
}

function installHooks(opts: SetupOptions, claude: ClaudeProbe) {
  // A broken claude still gets hooks: they are inert until it runs again, and
  // reinstalling Claude Code should not need a second setup run.
  if (claude.state === 'missing') {
    warn('Skipping Claude Code hooks because `claude` is not installed');
    return;
  }

  info('Installing Claude Code hooks...');

  const claudeDir = join(homedir(), '.claude');
  // Watched by Claude Code at user scope. `settings.local.json` — the file this
  // installer used to target — is resolved against the git root / cwd, so at
  // user scope it is never read. Mirrors `@agentdeck/hooks` `claudeSettingsPaths`
  // and Swift `HookInstaller.claudeSettingsFilename`.
  const settingsPath = join(claudeDir, 'settings.json');

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  sweepLegacyHooks(claudeDir);

  if (IS_WIN) {
    ok(`Hook script written to ${ensureWindowsHookScript()}`);
  }

  let settings: any = {};
  if (existsSync(settingsPath)) {
    const content = readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Refresh only our handlers; a matcher group can also hold user commands.
    settings.hooks[event] = settings.hooks[event].flatMap((h: any) => {
      if (!isAgentDeckHookEntry(h)) return [h];
      if (!Array.isArray(h.hooks)) return [];
      const kept = h.hooks.filter((handler: any) => !isAgentDeckHookEntry(handler));
      return kept.length ? [{ ...h, hooks: kept }] : [];
    });

    settings.hooks[event].push(buildHookEntry(event));
  }

  const statuslineOutcome = applyStatuslineRelay(settings, opts.statusline);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  ok(`Hooks installed to ${settingsPath}`);
  info(statuslineOutcome);
}

function installKiroHooks() {
  if (!which('kiro-cli')) {
    warn('Skipping Kiro v3 hooks because `kiro-cli` is not installed');
    return;
  }
  const kiroRoot = join(homedir(), '.kiro');
  const hooksDir = join(kiroRoot, 'hooks');
  const hookPath = join(hooksDir, 'agentdeck-lifecycle.json');
  if (!existsSync(kiroRoot)) {
    warn('Skipping Kiro v3 hooks because ~/.kiro has not been initialized');
    return;
  }
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (!existing.includes('/hooks/kiro_') && !existing.includes('AgentDeck ')) {
      warn(`Skipping Kiro hooks because ${hookPath} is occupied by another file`);
      return;
    }
  }
  const events = [
    ['SessionStart', 'kiro_session_start'],
    ['UserPromptSubmit', 'kiro_user_prompt_submit'],
    ['PreToolUse', 'kiro_tool_start'],
    ['PostToolUse', 'kiro_tool_end'],
    ['Stop', 'kiro_stop'],
  ] as const;
  const config = {
    version: 'v1',
    hooks: events.map(([trigger, daemonEvent]) => ({
      name: `AgentDeck ${trigger}`,
      trigger,
      action: {
        type: 'command',
        command: IS_WIN ? buildHookCommandWin(daemonEvent) : buildHookCommand(daemonEvent),
      },
      timeout: 2,
    })),
  };
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, `${JSON.stringify(config, null, 2)}\n`);
  ok(`Kiro v3 lifecycle hooks installed to ${hookPath}`);
}

// ─── 6. Data directory ───────────────────────────────────────────────

function ensureDataDir() {
  const dir = join(homedir(), '.agentdeck');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    ok('Created ~/.agentdeck/');
  }
}

// ─── 6b. Seed compatibility state ────────────────────────────────────

function seedCompatibility(claude: ClaudeProbe, userPrefix: string | null) {
  const compatPath = join(homedir(), '.agentdeck', 'compatibility.json');
  if (existsSync(compatPath)) return;
  // Reuse the prerequisite probe: re-running `claude --version` here spewed a
  // broken CLI's raw error onto the terminal a second time.
  if (claude.state !== 'ok') return;
  try {
    const claudeVer = claude.version;
    let bridgeVer: string | null = null;
    try {
      const prefixArg = userPrefix ? ` --prefix ${JSON.stringify(userPrefix)}` : '';
      const list = JSON.parse(
        execSync(`npm list -g${prefixArg} @agentdeck/bridge --json`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }),
      );
      bridgeVer = list?.dependencies?.['@agentdeck/bridge']?.version ?? null;
    } catch {
      /* not installed globally yet */
    }
    if (claudeVer) {
      writeFileSync(
        compatPath,
        JSON.stringify(
          {
            lastClaudeCodeVersion: claudeVer,
            lastAgentDeckVersion: bridgeVer,
            lastCheckTime: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      ok('Compatibility state initialized');
    }
  } catch {
    /* non-critical */
  }
}

// ─── 7. Optional dependencies ────────────────────────────────────────

function checkOptionalDeps() {
  console.log('');
  console.log('----- Optional Dependencies -----');

  if (IS_WIN || IS_LINUX) {
    // Voice needs Apple's on-device speech recognizer, so it is macOS-only.
    // Say so instead of printing `brew` instructions the user can't use.
    warn('Voice input is macOS-only (Apple on-device speech) — skipped.');
    return;
  }

  // Transcription needs nothing installed: it runs through the bundled Swift
  // helper against Apple's on-device recognizer. Only host-mic capture still
  // wants sox — and device-sourced audio (ESP32 knob) doesn't even need that.
  ok('Voice transcription: Apple on-device speech (nothing to install)');

  if (which('sox') || which('rec')) {
    ok('sox installed (host microphone capture)');
  } else {
    warn('sox not found — host-mic voice capture unavailable');
    console.log('     Install with: brew install sox   (not needed for device-sourced audio)');
  }
}

// ─── 8. Success ──────────────────────────────────────────────────────

/**
 * Run `agentdeck daemon install` here rather than telling the user to.
 *
 * This is the step that made "install with npx alone" not quite true. Failure
 * is reported and then tolerated: the bridge and hooks are already installed at
 * this point, so exiting non-zero would make a working install look broken.
 */
function installDaemonAutostart(opts: SetupOptions, agentdeckCmd: string): boolean {
  console.log('');
  console.log('----- Daemon autostart -----');
  const args = opts.enterprise ? ' --enterprise' : '';
  if (opts.enterprise) {
    info('Enterprise posture: the daemon will bind 127.0.0.1 only — no mDNS advertisement,');
    info('no UDP discovery beacon, no LAN device sweep, no BLE scans, no ADB reverse.');
  }
  try {
    // Resolved through this process's PATH, which installBridge() prepended
    // with a per-user prefix when it used one. The unit it writes bakes
    // absolute node + cli.js paths, so autostart never depends on PATH.
    execSync(`agentdeck daemon install${args}`, { stdio: 'inherit' });
    ok('Daemon autostart installed');
    return true;
  } catch {
    warn(`'${agentdeckCmd} daemon install${args}' failed — see the output above, then run it again.`);
    return false;
  }
}

/** Ask once, default No. Any read failure (closed stdin, Ctrl+D) is a No. */
function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    rl.on('close', () => finish(false));
    rl.question(question, (answer) => finish(isYes(answer)));
  });
}

/**
 * Daemon autostart stays opt-in by default (`--yes` installs it), but a user at
 * a terminal is asked instead of being handed a command to copy: the deck keys
 * are OFFLINE until it runs, and the D200H tester had to discover that by hand.
 */
async function maybeInstallDaemon(opts: SetupOptions, agentdeckCmd: string): Promise<boolean> {
  if (opts.autoInstallDaemon) return installDaemonAutostart(opts, agentdeckCmd);
  const offer = shouldOfferDaemonPrompt({
    autoInstallDaemon: opts.autoInstallDaemon,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    env: process.env,
  });
  if (!offer) return false;
  console.log('');
  console.log('The AgentDeck daemon is what your deck keys connect to; until it runs they show OFFLINE.');
  const yes = await askYesNo('Install it now and start it on every login? [y/N] ');
  return yes ? installDaemonAutostart(opts, agentdeckCmd) : false;
}

function success(opts: SetupOptions, daemonInstalled: boolean, surfaces: SurfaceProbe, agentdeckCmd: string) {
  const plan = surfacePlan(surfaces, process.platform);
  console.log('');
  console.log('=========================================');
  console.log('  Setup Complete!');
  console.log('=========================================');
  console.log('');
  if (daemonInstalled) {
    console.log('  The daemon is installed and starts on login.');
    console.log('');
    for (const line of nextStepsLines({ plan, platform: process.platform, daemonInstalled, agentdeckCmd })) console.log(line);
    if (!opts.enterprise) {
      console.log('');
      console.log('  On a shared/corporate network, re-run with --enterprise for a loopback-only daemon:');
      console.log('    npx @agentdeck/setup --enterprise');
    }
    console.log('');
    console.log('  Usage:');
    console.log('    agentdeck dashboard        Open the terminal dashboard');
    console.log('    agentdeck status           Check status');
    console.log('    agentdeck stop             Stop bridge');
    console.log('');
    return;
  }
  for (const line of nextStepsLines({ plan, platform: process.platform, daemonInstalled, agentdeckCmd })) console.log(line);
  console.log('');
  console.log('  Usage:');
  console.log('    agentdeck daemon install   Start monitoring on login');
  console.log('    agentdeck dashboard        Open the terminal dashboard');
  console.log('    claude / codex / opencode  Run agents normally; hooks/events discover them');
  console.log('    agentdeck status   Check status');
  console.log('    agentdeck stop     Stop bridge');
  console.log('');
  // Last, so it is the line the user reads: nothing on the deck works yet.
  for (const line of offlineNotice(agentdeckCmd)) warn(line.trim());
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseSetupArgs(process.argv.slice(2));
  banner();

  const prereq = checkPrerequisites(opts);
  if (!prereq.pass) {
    process.exit(1);
  }

  console.log('');
  const bridge = await installBridge();
  checkBridgeNativeRuntime();
  console.log('');
  installHooks(opts, prereq.claude);
  installKiroHooks();
  ensureDataDir();
  seedCompatibility(prereq.claude, bridge.userPrefix);
  checkOptionalDeps();
  const daemonInstalled = await maybeInstallDaemon(opts, bridge.agentdeckCmd);
  success(opts, daemonInstalled, prereq.surfaces, bridge.agentdeckCmd);
}

// Runs on import — this module IS the installer's entry point. The guard is
// inverted on purpose: the default is "run", so no bin-shim/symlink resolution
// quirk can turn `npx @agentdeck/setup` into a silent no-op. Only the unit test
// that imports parseSetupArgs sets the variable.
if (!process.env.AGENTDECK_SETUP_NO_AUTORUN) {
  main().catch((err) => {
    fail(`Unexpected error: ${err.message}`);
    process.exit(1);
  });
}
