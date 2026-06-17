import { execSync } from 'child_process';
import type { AgentType } from './types.js';

interface DepCheck {
  name: string;
  command: string;
  required: boolean;
  installHint: string;
}

/** Agent-specific binary requirements */
const AGENT_DEPS: Partial<Record<AgentType, DepCheck>> = {
  'claude-code': {
    name: 'claude',
    command: 'claude --version',
    required: true,
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  'codex-cli': {
    name: 'codex',
    command: 'codex --version',
    required: true,
    installHint: 'npm install -g @openai/codex',
  },
  'opencode': {
    name: 'opencode',
    command: 'opencode --version',
    required: true,
    installHint: 'brew install sst/tap/opencode  (or: npm i -g opencode-ai)',
  },
};

/** Shared optional dependencies */
const SHARED_DEPS: DepCheck[] = [
  {
    name: 'sox (rec)',
    command: 'which rec',
    required: false,
    installHint: 'brew install sox',
  },
  {
    name: 'whisper-cli',
    command: 'which whisper-cli',
    required: false,
    installHint: 'brew install whisper-cpp && whisper-cli --download-model large-v3-turbo',
  },
  {
    name: 'whisper-server',
    command: 'which whisper-server',
    required: false,
    installHint: 'brew install whisper-cpp (includes whisper-server)',
  },
];

export function checkDependencies(agentType?: AgentType): { ok: boolean; warnings: string[]; agentVersion?: string } {
  const warnings: string[] = [];
  let ok = true;
  let agentVersion: string | undefined;

  // POSIX: invoke via login shell so profile-added PATHs (pnpm, nvm, etc.) are
  // visible. Windows: PATH is system-managed (no shell profile), so a direct
  // execSync is correct — the POSIX wrapper would try `/bin/zsh` which doesn't
  // exist and every check would fail with "system cannot find the path".
  const isWin = process.platform === 'win32';
  const loginShell = process.env.SHELL || '/bin/zsh';
  const shellExec = (cmd: string, opts?: Parameters<typeof execSync>[1]) =>
    isWin
      ? execSync(cmd, opts)
      : execSync(`${loginShell} -l -c '${cmd}'`, opts);

  // Check agent-specific binary
  const agentDep = agentType ? AGENT_DEPS[agentType] : AGENT_DEPS['claude-code'];
  if (agentDep) {
    try {
      const output = shellExec(agentDep.command, { encoding: 'utf-8', timeout: 5000 }).toString().trim();
      agentVersion = output.match(/^([\d.]+)/)?.[1] ?? undefined;
    } catch {
      process.stderr.write(`[agentdeck] ERROR: ${agentDep.name} not found. Install: ${agentDep.installHint}\n`);
      ok = false;
    }
  }

  // Check shared optional deps. All current entries use `which` + brew install
  // hints — they're macOS voice features. Skip on Windows so we don't emit
  // bogus warnings.
  if (!isWin) {
    for (const dep of SHARED_DEPS) {
      try {
        shellExec(dep.command, { stdio: 'ignore' });
      } catch {
        warnings.push(`${dep.name} not found — ${dep.installHint}`);
      }
    }
  }

  return { ok, warnings, agentVersion };
}
