/**
 * Pure decision logic for `npx @agentdeck/setup`: where to install the bridge,
 * what an npm failure means, how to make a per-user install reachable, whether
 * the Claude CLI actually runs, and which deck host the next steps talk about.
 *
 * Everything here takes its filesystem/process evidence as arguments so the
 * unit tests can drive every branch with fixtures — the installer itself
 * (setup.ts) is the only place that touches the real machine. This package has
 * no workspace dependencies because it bootstraps them.
 *
 * Origin (2026-10-19, Ulanzi Studio QA): a Mac with system-installed Node
 * (global prefix /usr/local, owned by root) hit EACCES on
 * `npm install -g @agentdeck/bridge`; the installer discarded npm's error,
 * retried the same root-owned install as a node-pty source build, failed the
 * same way and died with "Command failed". A broken `claude` (its native
 * binary never installed) was reported as found, and a D200H-only user was
 * given Stream Deck next steps and told to run `agentdeck daemon install` by
 * hand while their keys sat OFFLINE.
 */

import { constants as fsConstants, readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { posix, win32 } from 'path';

type Platform = NodeJS.Platform;

function pathApi(platform: Platform) {
  return platform === 'win32' ? win32 : posix;
}

// ─── npm failure classification ──────────────────────────────────────

export type NpmFailure =
  | { kind: 'permission'; code: 'EACCES' | 'EPERM'; path: string | null; tail: string }
  | { kind: 'native-build'; tail: string }
  | { kind: 'other'; tail: string };

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The last `maxLines` non-empty lines of npm's stderr, ANSI-stripped. */
export function stderrTail(stderr: string, maxLines = 15): string {
  return stderr
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-maxLines)
    .join('\n');
}

/**
 * Markers that only a native-module build/prebuild failure produces. A bare
 * mention of `node-pty` is not enough (an `ETARGET` for it is a registry
 * problem, and a source build would not fix it).
 */
const NATIVE_BUILD_MARKERS: readonly RegExp[] = [
  /gyp ERR!/i,
  /\bnode-gyp\b/i,
  /\bprebuild(-install)?\b/i,
  /\bnode-pre-gyp\b/i,
  /NODE_MODULE_VERSION/,
  /binding\.gyp/i,
  /xcrun: error/i,
  /make: \*\*\*/,
  /node-pty[^\n]*(install|build|compile|rebuild)/i,
  /(install|build|compile|rebuild)[^\n]*node-pty/i,
];

/**
 * What an `npm install -g` failure means, from its stderr.
 *
 * Permission wins over everything: a root-owned prefix fails identically with
 * or without a source build, so retrying as one only doubles the wait and
 * buries the real error (the QA log showed the same EACCES twice). Only a
 * failure carrying a native-build marker earns the source-build retry; any
 * other failure is reported verbatim.
 */
export function classifyNpmFailure(stderr: string): NpmFailure {
  const clean = stderr.replace(ANSI, '');
  const tail = stderrTail(clean);
  const code = /\bEACCES\b/.test(clean) ? 'EACCES' : /\bEPERM\b/.test(clean) ? 'EPERM' : null;
  if (code) {
    const path =
      /npm (?:ERR!|error) path (.+)/.exec(clean)?.[1]?.trim() ??
      /(?:EACCES|EPERM)[^'\n]*'([^'\n]+)'/.exec(clean)?.[1]?.trim() ??
      null;
    return { kind: 'permission', code, path, tail };
  }
  if (NATIVE_BUILD_MARKERS.some((re) => re.test(clean))) return { kind: 'native-build', tail };
  return { kind: 'other', tail };
}

export type RetryDecision = 'user-prefix' | 'source-build' | 'fail';

/**
 * The next move after a failed install. EACCES on the default prefix moves to
 * the per-user prefix (never sudo). EPERM is reported instead: on Windows it is
 * typically a file held open by a running daemon or antivirus, which another
 * prefix would only paper over with a second, shadowing install. A source build
 * is tried once, and never on Windows (it needs Visual Studio Build Tools).
 */
export function decideRetry(
  failure: NpmFailure,
  state: { usingUserPrefix: boolean; sourceBuildTried: boolean; platform: Platform },
): RetryDecision {
  if (failure.kind === 'permission') {
    return failure.code === 'EACCES' && !state.usingUserPrefix ? 'user-prefix' : 'fail';
  }
  if (failure.kind === 'native-build' && state.platform !== 'win32' && !state.sourceBuildTried) {
    return 'source-build';
  }
  return 'fail';
}

// ─── npm prefix writability ──────────────────────────────────────────

export interface FsProbe {
  existsSync(path: string): boolean;
  accessSync(path: string, mode?: number): void;
}

/** Where `npm install -g --prefix <prefix>` puts packages and their bin shims. */
export function globalInstallTargets(prefix: string, platform: Platform): { modules: string; bin: string } {
  const p = pathApi(platform);
  return platform === 'win32'
    ? { modules: p.join(prefix, 'node_modules'), bin: prefix }
    : { modules: p.join(prefix, 'lib', 'node_modules'), bin: p.join(prefix, 'bin') };
}

/** The closest ancestor of `path` (inclusive) that exists, or null. */
export function nearestExistingDir(path: string, platform: Platform, fs: FsProbe): string | null {
  const p = pathApi(platform);
  let current = path;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = p.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Three answers: a path whose nearest existing ancestor we cannot find is `unknown`, not writable. */
export type Writability = 'writable' | 'unwritable' | 'unknown';

export function pathWritability(
  path: string,
  platform: Platform,
  fs: FsProbe,
): { verdict: Writability; dir: string | null } {
  const dir = nearestExistingDir(path, platform, fs);
  if (!dir) return { verdict: 'unknown', dir: null };
  try {
    fs.accessSync(dir, fsConstants.W_OK);
    return { verdict: 'writable', dir };
  } catch {
    return { verdict: 'unwritable', dir };
  }
}

/**
 * Can this user write where `npm install -g` will put the bridge? Checks the
 * scope directory (`…/node_modules/@agentdeck`, or its nearest existing parent —
 * the QA failure was `mkdir /usr/local/lib/node_modules/@agentdeck`) and the bin
 * directory the CLI shim lands in.
 */
export function prefixWritability(
  prefix: string,
  platform: Platform,
  fs: FsProbe,
): { verdict: Writability; blocking: string | null } {
  const p = pathApi(platform);
  const { modules, bin } = globalInstallTargets(prefix, platform);
  let unknown = false;
  for (const target of [p.join(modules, '@agentdeck'), bin]) {
    const r = pathWritability(target, platform, fs);
    if (r.verdict === 'unwritable') return { verdict: 'unwritable', blocking: r.dir };
    if (r.verdict === 'unknown') unknown = true;
  }
  return { verdict: unknown ? 'unknown' : 'writable', blocking: null };
}

/** The per-user npm prefix setup falls back to. Never needs sudo/admin. */
export function userPrefixDir(home: string, platform: Platform): string {
  return pathApi(platform).join(home, '.agentdeck', 'npm');
}

export function userPrefixBinDir(home: string, platform: Platform): string {
  return globalInstallTargets(userPrefixDir(home, platform), platform).bin;
}

export interface BridgeInstallPlan {
  /** null = npm's default global prefix. */
  prefix: string | null;
  reason: 'default' | 'default-unverified' | 'unwritable' | 'existing-user-install';
  /** The directory that is not writable, when reason is `unwritable`. */
  blocking: string | null;
}

/**
 * Decide the install prefix before running npm.
 *
 * An earlier fallback install keeps being updated in place even if the default
 * prefix has since become writable: the profile PATH line puts the per-user bin
 * first, so installing the new version elsewhere would leave the old one
 * shadowing it. An unreadable `npm prefix -g` or an `unknown` writability is no
 * evidence either way — the default is tried and an EACCES still falls back.
 */
export function planBridgeInstall(args: {
  globalPrefix: string | null;
  platform: Platform;
  home: string;
  fs: FsProbe;
}): BridgeInstallPlan {
  const { globalPrefix, platform, home, fs } = args;
  const p = pathApi(platform);
  const user = userPrefixDir(home, platform);
  const sameAsUser = globalPrefix != null && p.resolve(globalPrefix) === p.resolve(user);
  const existingUserInstall = fs.existsSync(
    p.join(globalInstallTargets(user, platform).modules, '@agentdeck', 'bridge'),
  );
  if (existingUserInstall && !sameAsUser) return { prefix: user, reason: 'existing-user-install', blocking: null };
  if (globalPrefix == null) return { prefix: null, reason: 'default-unverified', blocking: null };
  const w = prefixWritability(globalPrefix, platform, fs);
  if (w.verdict === 'unwritable' && !sameAsUser) return { prefix: user, reason: 'unwritable', blocking: w.blocking };
  return { prefix: null, reason: w.verdict === 'writable' ? 'default' : 'default-unverified', blocking: null };
}

export function npmInstallArgs(prefix: string | null): string[] {
  return ['install', '-g', ...(prefix ? ['--prefix', prefix] : []), '@agentdeck/bridge'];
}

/** cmd.exe quoting for one argument (npm is `npm.cmd`, which needs a shell on Windows). */
export function quoteWindowsArg(arg: string): string {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

// ─── PATH ────────────────────────────────────────────────────────────

function samePathEntry(a: string, b: string, platform: Platform): boolean {
  const norm = (s: string) => {
    let t = s.trim().replace(/[\\/]+$/, '');
    if (platform === 'win32') t = t.replace(/\//g, '\\').toLowerCase();
    return t;
  };
  return norm(a) === norm(b) && norm(a) !== '';
}

export function pathContains(pathValue: string | undefined, dir: string, platform: Platform): boolean {
  const sep = platform === 'win32' ? ';' : ':';
  return (pathValue ?? '').split(sep).some((entry) => samePathEntry(entry, dir, platform));
}

/** `dir` first, every other entry kept once in its original order. */
export function prependPathEntry(pathValue: string | undefined, dir: string, platform: Platform): string {
  const sep = platform === 'win32' ? ';' : ':';
  const rest = (pathValue ?? '').split(sep).filter((e) => e !== '' && !samePathEntry(e, dir, platform));
  return [dir, ...rest].join(sep);
}

// ─── Shell profile line ──────────────────────────────────────────────

export const PROFILE_MARKER = '# added by @agentdeck/setup';

/**
 * The login-shell profile that should carry the PATH line, or null when the
 * shell is not one we can safely write for (fish, unknown) or on Windows.
 *
 * bash reads only the FIRST of ~/.bash_profile, ~/.bash_login, ~/.profile, so
 * the line goes into whichever already exists. Creating ~/.bash_profile on a
 * Linux machine that relies on ~/.profile would silently stop ~/.profile from
 * being read — hence ~/.profile as the Linux default and ~/.bash_profile only
 * on macOS, where it is the conventional file.
 */
export function profileFileFor(args: {
  platform: Platform;
  shell: string | undefined;
  home: string;
  zdotdir?: string;
  exists: (path: string) => boolean;
}): string | null {
  const { platform, home, exists } = args;
  if (platform === 'win32') return null;
  const p = posix;
  const shell = p.basename(args.shell?.trim() || (platform === 'darwin' ? 'zsh' : ''));
  if (shell === 'zsh') return p.join(args.zdotdir?.trim() || home, '.zprofile');
  if (shell === 'bash') {
    const candidates = ['.bash_profile', '.bash_login', '.profile'].map((f) => p.join(home, f));
    return candidates.find((c) => exists(c)) ?? p.join(home, platform === 'darwin' ? '.bash_profile' : '.profile');
  }
  if (shell === 'sh' || shell === 'dash' || shell === 'ksh') return p.join(home, '.profile');
  return null;
}

function shellDoubleQuote(s: string): string {
  return s.replace(/(["\\$`])/g, '\\$1');
}

/** One self-describing line; `$HOME`-relative when the bin dir is under home. */
export function profilePathLine(binDir: string, home: string): string {
  const prefix = home.endsWith('/') ? home : `${home}/`;
  const value = binDir.startsWith(prefix)
    ? `$HOME/${shellDoubleQuote(binDir.slice(prefix.length))}`
    : shellDoubleQuote(binDir);
  return `export PATH="${value}:$PATH" ${PROFILE_MARKER} (agentdeck CLI, per-user npm prefix)`;
}

/**
 * Add or refresh the marked line. Idempotent: running setup twice never adds a
 * second line, and a line from an older layout is replaced in place.
 */
export function upsertProfileLine(
  content: string | null,
  line: string,
): { content: string; outcome: 'added' | 'present' | 'updated' } {
  const existing = content ?? '';
  const lines = existing.split('\n');
  const at = lines.findIndex((l) => l.includes(PROFILE_MARKER));
  if (at >= 0) {
    if (lines[at] === line) return { content: existing, outcome: 'present' };
    lines[at] = line;
    return { content: lines.join('\n'), outcome: 'updated' };
  }
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  return { content: `${existing}${sep}${line}\n`, outcome: 'added' };
}

export interface ProfileFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
}

const realProfileFs: ProfileFs = { existsSync, readFileSync, writeFileSync, appendFileSync };

/**
 * Write the line into `file`. An add is an append — the user's profile is
 * never rewritten (and so can never be truncated) unless our own marked line
 * has to change.
 */
export function ensureProfilePathLine(
  file: string,
  line: string,
  fs: ProfileFs = realProfileFs,
): 'added' | 'present' | 'updated' {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  const next = upsertProfileLine(current, line);
  if (next.outcome === 'present') return 'present';
  if (next.outcome === 'added') {
    fs.appendFileSync(file, next.content.slice((current ?? '').length));
  } else {
    fs.writeFileSync(file, next.content);
  }
  return next.outcome;
}

// ─── Claude CLI probe ────────────────────────────────────────────────

export interface SpawnOutcome {
  status: number | null;
  signal?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: (Error & { code?: string }) | null;
}

export type ClaudeProbe =
  | { state: 'missing' }
  | { state: 'ok'; version: string | null }
  | { state: 'broken'; detail: string };

/**
 * `which claude` finding a file is not `claude` working: the npm package's
 * launcher exists even when its native binary was never installed
 * ("postinstall did not run"). Only a zero exit from `claude --version` is OK.
 */
export function classifyClaudeProbe(found: boolean, result: SpawnOutcome | null): ClaudeProbe {
  if (!found || !result) return { state: 'missing' };
  if (result.error?.code === 'ENOENT') return { state: 'missing' };
  if (result.error?.code === 'ETIMEDOUT' || (result.status == null && result.signal)) {
    return { state: 'broken', detail: '`claude --version` did not answer within 5 s' };
  }
  if (result.status === 0) {
    const version = /(\d+\.\d+\.\d+)/.exec(result.stdout ?? '')?.[1] ?? null;
    return { state: 'ok', version };
  }
  const firstLine = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const detail = firstLine
    ? firstLine.length > 200
      ? `${firstLine.slice(0, 197)}...`
      : firstLine
    : (result.error?.message ?? `\`claude --version\` exited with code ${result.status}`);
  return { state: 'broken', detail };
}

// ─── Deck host surfaces ──────────────────────────────────────────────

export type Surface = 'streamdeck' | 'ulanzi';

export function parseSurface(value: string | undefined): Surface | null {
  const v = value?.trim().toLowerCase();
  if (v === 'ulanzi' || v === 'd200h' || v === 'd200x') return 'ulanzi';
  if (v === 'streamdeck' || v === 'stream-deck' || v === 'elgato') return 'streamdeck';
  return null;
}

type Env = Record<string, string | undefined>;

export function streamDeckPaths(platform: Platform, env: Env, home: string): string[] {
  if (platform === 'win32') {
    const p = win32;
    return [
      p.join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
      p.join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
      p.join(
        env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'),
        'Programs',
        'Elgato',
        'StreamDeck',
        'StreamDeck.exe',
      ),
    ];
  }
  if (platform === 'darwin') return ['/Applications/Elgato Stream Deck.app', '/Applications/Stream Deck.app'];
  return [];
}

/**
 * Ulanzi Studio evidence. macOS paths are verified (the app bundle and the
 * data directory whose `Plugins/` the plugin is installed into, see
 * scripts/package-ulanzi-plugin.sh). The Windows paths are UNVERIFIED guesses —
 * no Windows Ulanzi Studio install has been inspected: the roaming data
 * directory mirrors the macOS `Application Support/Ulanzi/UlanziDeck` layout,
 * the rest are the usual installer locations. A miss only means both hosts are
 * listed in the next steps, never a wrong instruction.
 */
export function ulanziPaths(platform: Platform, env: Env, home: string): string[] {
  if (platform === 'win32') {
    const p = win32;
    const appData = env.APPDATA ?? p.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local');
    const pf = env.PROGRAMFILES ?? 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    return [
      p.join(appData, 'Ulanzi', 'UlanziDeck'), // unverified
      p.join(pf, 'Ulanzi Studio'), // unverified
      p.join(pf, 'UlanziStudio'), // unverified
      p.join(pf86, 'Ulanzi Studio'), // unverified
      p.join(local, 'Programs', 'Ulanzi Studio'), // unverified
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Ulanzi Studio.app',
      posix.join(home, 'Library', 'Application Support', 'Ulanzi', 'UlanziDeck'),
    ];
  }
  return [];
}

export interface SurfaceProbe {
  streamDeck: boolean;
  ulanzi: boolean;
  forced: Surface | null;
}

export function detectSurfaces(args: {
  platform: Platform;
  env: Env;
  home: string;
  exists: (path: string) => boolean;
  forced: Surface | null;
}): SurfaceProbe {
  const { platform, env, home, exists, forced } = args;
  return {
    streamDeck: streamDeckPaths(platform, env, home).some(exists),
    ulanzi: ulanziPaths(platform, env, home).some(exists),
    forced,
  };
}

/** Which deck host(s) the next steps describe. */
export type SurfacePlan = 'streamdeck' | 'ulanzi' | 'both' | 'unknown' | 'none';

export function surfacePlan(probe: SurfaceProbe, platform: Platform): SurfacePlan {
  if (probe.forced) return probe.forced;
  if (platform !== 'darwin' && platform !== 'win32') return 'none';
  if (probe.streamDeck && probe.ulanzi) return 'both';
  if (probe.streamDeck) return 'streamdeck';
  if (probe.ulanzi) return 'ulanzi';
  return 'unknown';
}

export const ULANZI_MARKETPLACE_URL = 'https://ugc.ulanzistudio.com/contentView/1141';
export const ULANZI_DOWNLOAD_URL = 'https://www.ulanzi.com/pages/downloads';
export const ELGATO_MARKETPLACE_URL =
  'https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464';
export const ELGATO_DOWNLOAD_URL = 'https://www.elgato.com/downloads';

export interface Line {
  level: 'ok' | 'warn' | 'plain';
  text: string;
}

/**
 * Prerequisite lines for the deck hosts. A host the user does not use is never
 * a warning: a D200H owner on Windows was told "Stream Deck keys will be
 * unavailable" for an app they do not need.
 */
export function surfacePrereqLines(probe: SurfaceProbe, platform: Platform): Line[] {
  if (platform !== 'darwin' && platform !== 'win32') return [];
  const out: Line[] = [];
  if (probe.streamDeck) out.push({ level: 'ok', text: 'Stream Deck app installed' });
  if (probe.ulanzi) out.push({ level: 'ok', text: 'Ulanzi Studio installed' });
  if (probe.forced === 'streamdeck' && !probe.streamDeck) {
    out.push({ level: 'warn', text: 'Stream Deck app not found (--surface=streamdeck).' });
    out.push({ level: 'plain', text: `     Stream Deck app: ${ELGATO_DOWNLOAD_URL}` });
  } else if (probe.forced === 'ulanzi' && !probe.ulanzi) {
    out.push({
      level: 'warn',
      text: `Ulanzi Studio not found${platform === 'win32' ? ' in the usual locations' : ''} (--surface=ulanzi) — continuing.`,
    });
    out.push({ level: 'plain', text: `     Ulanzi Studio: ${ULANZI_DOWNLOAD_URL}` });
  } else if (!probe.streamDeck && !probe.ulanzi && !probe.forced) {
    out.push({
      level: 'warn',
      text: 'No deck host app found (Stream Deck or Ulanzi Studio) — the daemon works without one.',
    });
    out.push({
      level: 'plain',
      text: `     Stream Deck: ${ELGATO_DOWNLOAD_URL}   Ulanzi Studio (D200H/D200X): ${ULANZI_DOWNLOAD_URL}`,
    });
  }
  return out;
}

/**
 * The closing "what now" block. `daemonInstalled` decides whether the first
 * step is the daemon; when it is not installed the block says plainly that the
 * keys stay OFFLINE until it is, because that is what the user will see.
 * `agentdeckCmd` is the spelling that works in the user's NEXT terminal (an
 * absolute path when the CLI went into a per-user prefix the shell has not
 * picked up yet).
 */
export function nextStepsLines(args: {
  plan: SurfacePlan;
  platform: Platform;
  daemonInstalled: boolean;
  agentdeckCmd: string;
}): string[] {
  const { plan, platform, daemonInstalled, agentdeckCmd } = args;
  const out: string[] = [];
  const unit =
    platform === 'win32'
      ? 'Windows Scheduled Task'
      : platform === 'linux'
        ? 'systemd --user unit'
        : 'macOS LaunchAgent';
  const steps: string[] = [];
  if (!daemonInstalled) {
    steps.push(`Run '${agentdeckCmd} daemon install' to start the daemon now and on every login`);
    steps.push(
      platform === 'linux'
        ? `   (${unit}; run 'loginctl enable-linger $USER' for headless boot)`
        : `   (${unit}) — until it runs, AgentDeck keys show OFFLINE`,
    );
  }
  const ulanzi = [
    `In Ulanzi Studio, install AgentDeck from the Ulanzi Studio Marketplace (skip if already installed):`,
    `   ${ULANZI_MARKETPLACE_URL}`,
    'Drag the AgentDeck action onto your D200H / D200X keys',
  ];
  const streamDeck = ['Restart Stream Deck app', 'Add AgentDeck actions to your Stream Deck profile'];
  if (plan === 'ulanzi') steps.push(...ulanzi);
  else if (plan === 'streamdeck') steps.push(...streamDeck);
  else if (plan === 'both') steps.push(...streamDeck, ...ulanzi);
  else if (plan === 'unknown') {
    steps.push('Install the AgentDeck plugin in your deck host app:');
    steps.push(`   Stream Deck:   ${ELGATO_MARKETPLACE_URL}`);
    steps.push(`   Ulanzi Studio: ${ULANZI_MARKETPLACE_URL}`);
  }
  steps.push("Run 'claude', 'codex', or 'opencode' normally — hooks/events discover sessions");

  let n = 0;
  out.push(daemonInstalled ? '  Next:' : '  Next steps:');
  for (const s of steps) {
    if (s.startsWith('   ')) out.push(`  ${s}`);
    else out.push(`  ${++n}. ${s}`);
  }
  return out;
}

/** The plain-language closing warning when the daemon is not installed. */
export function offlineNotice(agentdeckCmd: string): string[] {
  return [
    '  The daemon is NOT installed yet — deck keys (Stream Deck, Ulanzi) and other AgentDeck devices',
    `  stay OFFLINE until you run:  ${agentdeckCmd} daemon install`,
  ];
}

export function shouldOfferDaemonPrompt(args: {
  autoInstallDaemon: boolean;
  stdinIsTTY: boolean | undefined;
  stdoutIsTTY: boolean | undefined;
  env: Env;
}): boolean {
  if (args.autoInstallDaemon) return false;
  if (!args.stdinIsTTY || !args.stdoutIsTTY) return false;
  const ci = (args.env.CI ?? '').trim().toLowerCase();
  return ci === '' || ci === '0' || ci === 'false';
}

/** y/N: only an explicit yes installs. */
export function isYes(answer: string | null | undefined): boolean {
  return /^\s*y(es)?\s*$/i.test(answer ?? '');
}
