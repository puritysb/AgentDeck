import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
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

export function runClaudeUsageRecovery(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  // A daemon started from an agent must not be mistaken for its nested session.
  // API-key / provider overrides must not redirect an OAuth recovery request.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN'
      || key === 'ANTHROPIC_BASE_URL' || key === 'CLAUDE_CODE_OAUTH_TOKEN'
      || key.startsWith('CLAUDE_CODE_USE_') || key.startsWith('AGENTDECK_')) delete env[key];
  }
  return new Promise((resolve) => {
    const child = execFile('claude', CLAUDE_USAGE_RECOVERY_ARGS, {
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
    writeFileSync(recoveryFile, JSON.stringify(record), { mode: 0o600 });
  },
  run: runClaudeUsageRecovery,
});
