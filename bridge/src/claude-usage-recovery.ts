import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { logTagged } from './logger.js';

const RECOVERY_TIMEOUT_MS = 25_000;
const RETRY_MS = 30 * 60_000;
const LONG_RETRY_MS = 6 * 60 * 60_000;
const recoveryFile = join(homedir(), '.agentdeck', 'claude-usage-recovery.json');

/** Claude owns the rotating refresh token and its interprocess lock. Never copy,
 * rotate, or write those credentials ourselves. This bounded turn may consume a
 * small amount of subscription quota; it carries no workspace or user content.
 * --bare is NOT appropriate: that mode explicitly disables OAuth/keychain reads.
 * An older CLI rejecting --safe-mode fails closed rather than loading hooks.
 */
export const CLAUDE_USAGE_RECOVERY_ARGS = [
  '--safe-mode', '--print', '--tools', '', '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}',
  '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
  '--model', 'haiku', '--max-turns', '1', '--max-budget-usd', '0.01',
  '--system-prompt', 'Reply with OK.', '--output-format', 'json', 'Reply with OK.',
];

/** Keep the recovery CLI on the same credential store as usage-api.ts.
 * On macOS that reader targets the default Keychain service; a custom config
 * directory can select a DIFFERENT Keychain namespace in Claude. Fail closed
 * rather than spend quota or renew an unrelated account. On other platforms,
 * resolve relative paths before the child changes cwd to the temporary folder.
 */
export function buildClaudeUsageRecoveryEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): NodeJS.ProcessEnv | null {
  const env: NodeJS.ProcessEnv = { ...source, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (env.CLAUDE_CONFIG_DIR) {
    const configDir = resolve(env.CLAUDE_CONFIG_DIR);
    if (platform === 'darwin' && configDir !== join(home, '.claude')) return null;
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  // A daemon started from an agent must not be mistaken for its nested session.
  // API-key / provider overrides must not redirect an OAuth recovery request.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN'
      || key === 'ANTHROPIC_BASE_URL' || key === 'CLAUDE_CODE_OAUTH_TOKEN'
      || key.startsWith('CLAUDE_CODE_USE_') || key.startsWith('AGENTDECK_')) delete env[key];
  }
  return env;
}

/** `execFile` runs one executable — it does not search PATHEXT and (since the
 * Node 20.12/18.20 spawn hardening) will not run a `.cmd`/`.bat` shim without a
 * shell. A bare `'claude'` was therefore ENOENT on every Windows install, and a
 * LaunchAgent carries the installing shell's PATH, which may not contain the
 * CLI at all — both surfaced only as a recurring generic failure line. Resolve
 * the real file once so the unavailable case can SAY it is unavailable.
 * Returns `{ shim: true }` for a Windows shell shim: shell-quoting a JSON
 * argument through cmd.exe is a worse failure than declining, so recovery is
 * skipped there and says so. */
export function resolveClaudeCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { path: string; shim: boolean } | null {
  const isFile = (candidate: string): boolean => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  };
  const override = env.AGENTDECK_CLAUDE_CLI;
  if (override) return isFile(override) ? { path: override, shim: false } : null;
  const exts = platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`);
      if (isFile(candidate)) return { path: candidate, shim: /\.(cmd|bat)$/i.test(ext) };
    }
  }
  return null;
}

let reportedUnavailable = false;
function reportUnavailableOnce(reason: string): void {
  if (reportedUnavailable) return;
  reportedUnavailable = true;
  logTagged('usage', `Claude authorization recovery unavailable: ${reason}`);
}

export function runClaudeUsageRecovery(): Promise<void> {
  const env = buildClaudeUsageRecoveryEnv();
  if (!env) {
    logTagged('usage', 'Claude authorization recovery skipped: custom macOS credential namespace cannot be matched');
    return Promise.resolve();
  }
  const cli = resolveClaudeCli(env);
  if (!cli) {
    reportUnavailableOnce('the claude CLI was not found on this daemon\'s PATH (set AGENTDECK_CLAUDE_CLI to its full path)');
    return Promise.resolve();
  }
  if (cli.shim) {
    reportUnavailableOnce(`only a shell shim is installed (${cli.path}); point AGENTDECK_CLAUDE_CLI at an executable`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = execFile(cli.path, CLAUDE_USAGE_RECOVERY_ARGS, {
      cwd: tmpdir(), env, timeout: RECOVERY_TIMEOUT_MS, killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024, windowsHide: true,
    }, (error) => {
      if (error) logTagged('usage', `Claude authorization recovery CLI ended (${error.killed ? 'timeout' : error.code ?? 'failed'})`);
      resolve(); // Outcome is verified by re-reading credentials, never stdout.
    });
    child.stdin?.end();
  });
}

interface RecoveryRecord { credentialHash: string; attempts: number; nextAttemptAt: number }
interface RecoveryDependencies {
  now: () => number;
  read: () => RecoveryRecord | null;
  write: (record: RecoveryRecord) => void;
  run: () => Promise<void>;
}

/** Single daemon owner; persisted cooldown also survives daemon restart. */
export class ClaudeUsageRecovery {
  private pending: Promise<void> | null = null;
  private record: RecoveryRecord | null = null;
  constructor(private deps: RecoveryDependencies) {}

  async recover(accessToken: string): Promise<void> {
    if (this.pending) return this.pending;
    const credentialHash = createHash('sha256').update(accessToken).digest('hex');
    const previous = this.record ?? this.deps.read();
    if (previous && this.deps.now() < previous.nextAttemptAt) return;
    const attempts = previous?.credentialHash === credentialHash ? previous.attempts + 1 : 1;
    this.record = { credentialHash, attempts,
      nextAttemptAt: this.deps.now() + (attempts >= 3 ? LONG_RETRY_MS : RETRY_MS) };
    // Record BEFORE spawning: a crash/restart must not cause a recovery loop.
    try { this.deps.write(this.record); } catch { return; }
    logTagged('usage', `Claude usage authorization expired — requesting bounded CLI recovery (attempt ${attempts})`);
    this.pending = this.deps.run().catch(() => {}).finally(() => { this.pending = null; });
    return this.pending;
  }
}

export const claudeUsageRecovery = new ClaudeUsageRecovery({
  now: Date.now,
  read: () => {
    try {
      const r = JSON.parse(readFileSync(recoveryFile, 'utf8'));
      return typeof r.credentialHash === 'string' && Number.isFinite(r.attempts)
        && Number.isFinite(r.nextAttemptAt) ? r : null;
    } catch { return null; }
  },
  write: (record) => {
    mkdirSync(join(homedir(), '.agentdeck'), { recursive: true });
    // tmp+rename like every other file in this directory: a torn write reads
    // back as "no cooldown", which is the one failure that spends quota.
    const tmp = `${recoveryFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, recoveryFile);
  },
  run: runClaudeUsageRecovery,
});
