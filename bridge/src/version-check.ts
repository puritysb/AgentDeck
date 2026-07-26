/**
 * Claude Code version compatibility check + AgentDeck self-update.
 *
 * Never blocks startup — all failures result in warnings + proceed.
 */

import { execSync } from './proc.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// ─── Types ───────────────────────────────────────────────────────────

interface CompatState {
  lastClaudeCodeVersion: string | null;
  lastAgentDeckVersion: string | null;
  lastCheckTime: string | null;
}

interface VersionCheckResult {
  proceed: boolean; // always true
  warnings: string[];
  updated: boolean;
  restartNeeded: boolean;
}

interface RegistryInfo {
  version: string;
  compatibleClaudeCode?: string;
}

// ─── Constants ───────────────────────────────────────────────────────

const COMPAT_PATH = join(homedir(), '.agentdeck', 'compatibility.json');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 3000;

// ─── Helpers ─────────────────────────────────────────────────────────

export function getClaudeCodeVersion(cachedOutput?: string): string | null {
  try {
    const raw = cachedOutput ?? execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    const m = raw.match(/^(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function getAgentDeckVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function loadCompatState(): CompatState {
  try {
    if (existsSync(COMPAT_PATH)) {
      return JSON.parse(readFileSync(COMPAT_PATH, 'utf-8'));
    }
  } catch { /* corrupt file */ }
  return { lastClaudeCodeVersion: null, lastAgentDeckVersion: null, lastCheckTime: null };
}

function saveCompatState(state: CompatState): void {
  try {
    const dir = join(homedir(), '.agentdeck');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(COMPAT_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch { /* non-critical */ }
}

/**
 * Minimal semver range checker supporting:
 *  - ">=X.Y.Z"
 *  - ">=X.Y.Z <A.B.C"
 *  - "<X.Y.Z"
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parts = (v: string): number[] => v.split('.').map(Number);

  function compare(a: string, b: string): number {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
  }

  const constraints = range.trim().split(/\s+(?=[<>=])/);
  for (const c of constraints) {
    const m = c.match(/^(>=?|<=?)\s*([\d.]+)$/);
    if (!m) continue;
    const [, op, target] = m;
    const cmp = compare(version, target);
    switch (op) {
      case '>=': if (cmp < 0) return false; break;
      case '>':  if (cmp <= 0) return false; break;
      case '<=': if (cmp > 0) return false; break;
      case '<':  if (cmp >= 0) return false; break;
    }
  }
  return true;
}

// ─── Registry Fetch ──────────────────────────────────────────────────

async function fetchFromNpm(): Promise<RegistryInfo | null> {
  try {
    const raw = execSync(
      'npm view @agentdeck/bridge version compatibleClaudeCode --json 2>/dev/null',
      { encoding: 'utf-8', timeout: FETCH_TIMEOUT_MS },
    );
    const data = JSON.parse(raw);
    if (typeof data === 'string') {
      // npm view returns plain string when only version field exists
      return { version: data };
    }
    return {
      version: data.version,
      compatibleClaudeCode: data.compatibleClaudeCode,
    };
  } catch {
    return null;
  }
}

async function fetchRegistryInfo(): Promise<RegistryInfo | null> {
  return fetchFromNpm();
}

// ─── Self Update ─────────────────────────────────────────────────────

function performSelfUpdate(): { success: boolean; error?: string } {
  try {
    execSync('npm install -g @agentdeck/bridge@latest', {
      stdio: 'pipe',
      timeout: 60_000,
    });
    return { success: true };
  } catch (e: any) {
    const msg = e.stderr?.toString().trim() || e.message;
    return { success: false, error: msg };
  }
}

// ─── Main Orchestrator ──────────────────────────────────────────────

export async function checkVersionCompatibility(opts: {
  skipCheck?: boolean;
  claudeCodeVersion?: string;
}): Promise<VersionCheckResult> {
  const result: VersionCheckResult = {
    proceed: true,
    warnings: [],
    updated: false,
    restartNeeded: false,
  };

  if (opts.skipCheck) return result;

  const claudeVer = opts.claudeCodeVersion ?? getClaudeCodeVersion();
  if (!claudeVer) {
    result.warnings.push('Could not determine Claude Code version');
    return result;
  }

  const agentDeckVer = getAgentDeckVersion();
  const state = loadCompatState();

  // Same versions + checked within the hour → skip
  const now = Date.now();
  if (
    state.lastClaudeCodeVersion === claudeVer &&
    state.lastAgentDeckVersion === agentDeckVer &&
    state.lastCheckTime &&
    now - new Date(state.lastCheckTime).getTime() < CHECK_INTERVAL_MS
  ) {
    return result;
  }

  // Version changed or check interval elapsed — query registry
  const registry = await fetchRegistryInfo();

  if (!registry) {
    result.warnings.push('Could not check AgentDeck compatibility (offline?)');
    // Still save state so we don't re-check immediately on next start
    state.lastClaudeCodeVersion = claudeVer;
    state.lastAgentDeckVersion = agentDeckVer;
    state.lastCheckTime = new Date().toISOString();
    saveCompatState(state);
    return result;
  }

  const compatRange = registry.compatibleClaudeCode;

  if (!compatRange) {
    // Registry package doesn't have compatibleClaudeCode yet — skip silently
    state.lastClaudeCodeVersion = claudeVer;
    state.lastAgentDeckVersion = agentDeckVer;
    state.lastCheckTime = new Date().toISOString();
    saveCompatState(state);
    return result;
  }

  if (satisfiesRange(claudeVer, compatRange)) {
    // Compatible
    state.lastClaudeCodeVersion = claudeVer;
    state.lastAgentDeckVersion = agentDeckVer;
    state.lastCheckTime = new Date().toISOString();
    saveCompatState(state);
    return result;
  }

  // Incompatible — attempt self-update if newer version available
  if (registry.version !== agentDeckVer) {
    result.warnings.push(
      `Claude Code ${claudeVer} may be incompatible with AgentDeck ${agentDeckVer}. Updating to ${registry.version}...`,
    );
    const update = performSelfUpdate();
    if (update.success) {
      result.updated = true;
      result.restartNeeded = true;
    } else {
      result.warnings.push(
        `Auto-update failed: ${update.error}. Run manually: npm install -g @agentdeck/bridge@latest`,
      );
    }
  } else {
    result.warnings.push(
      `Claude Code ${claudeVer} may not yet be supported by AgentDeck ${agentDeckVer}. ` +
      `Compatible range: ${compatRange}. A compatibility update is not yet available.`,
    );
  }

  state.lastClaudeCodeVersion = claudeVer;
  state.lastAgentDeckVersion = agentDeckVer;
  state.lastCheckTime = new Date().toISOString();
  saveCompatState(state);
  return result;
}
