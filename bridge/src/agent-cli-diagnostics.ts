import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CODEX_CONFIG_PATH, opencodePluginPath } from '@agentdeck/hooks';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { satisfiesRange } from './version-check.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as {
  compatibleClaudeCode?: string;
  compatibleCodex?: string;
};

export type DiagnosedAgent = 'claude' | 'codex' | 'opencode';

interface AgentSpec {
  id: DiagnosedAgent;
  label: string;
  versionCommand: string;
  compatibleRange?: string;
  installHint: string;
}

const AGENTS: AgentSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    versionCommand: 'claude --version',
    compatibleRange: packageJson.compatibleClaudeCode,
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    versionCommand: 'codex --version',
    compatibleRange: packageJson.compatibleCodex,
    installHint: 'npm install -g @openai/codex',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    versionCommand: 'opencode --version',
    installHint: 'brew install sst/tap/opencode  (or: npm i -g opencode-ai)',
  },
];

export interface AgentCliDiagnosticEntry {
  id: DiagnosedAgent;
  label: string;
  installed: boolean;
  version: string | null;
  compatibleRange: string | null;
  compatible: boolean | null;
  installHint?: string;
  observation: {
    registration: RegistrationEvidence;
    availability: 'not_verified';
    eventReception: 'not_checked';
  };
}

export interface AgentCliDiagnosticReport {
  kind: 'agent-cli-compatibility';
  migration: string;
  trackingIssue: string;
  agents: AgentCliDiagnosticEntry[];
}

export type RegistrationEvidence = 'detected' | 'absent' | 'unreadable';
export type RegistrationReader = (agent: DiagnosedAgent) => RegistrationEvidence;

/** Presence evidence only: trust, running-agent activation and live reception
 * cannot be inferred from written config or an installed CLI version. */
export function readAgentRegistration(agent: DiagnosedAgent): RegistrationEvidence {
  const path = agent === 'claude' ? join(homedir(), '.claude', 'settings.json')
    : agent === 'codex' ? DEFAULT_CODEX_CONFIG_PATH : opencodePluginPath();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    if (agent === 'claude') {
      const hooks = JSON.parse(text)?.hooks;
      return hooks && JSON.stringify(hooks).includes('agentdeck') ? 'detected' : 'absent';
    }
    return text.includes(agent === 'codex' ? '# >>> AgentDeck managed (do not edit) <<<' : 'AgentDeckObserver')
      ? 'detected' : 'absent';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

export type VersionCommandRunner = (command: string) => string;

function runVersionCommand(command: string): string {
  // Use the caller's PATH. A non-interactive login shell may skip interactive
  // startup files and reorder PATH, causing diagnostics to inspect a stale
  // installation instead of the executable `agentdeck` was launched beside.
  return execSync(command, {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  }).trim();
}

export function collectAgentCliDiagnosticReport(
  run: VersionCommandRunner = runVersionCommand,
  registration: RegistrationReader = readAgentRegistration,
): AgentCliDiagnosticReport {
  return {
    kind: 'agent-cli-compatibility',
    migration: 'Run `agentdeck daemon install`, then start the agent normally.',
    trackingIssue: 'https://github.com/puritysb/AgentDeck/issues/273',
    agents: AGENTS.map((agent) => {
      const compatibleRange = agent.compatibleRange?.trim() || null;
      const observation = { registration: registration(agent.id), availability: 'not_verified' as const, eventReception: 'not_checked' as const };
      try {
        const output = run(agent.versionCommand);
        const version = output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
        return {
          observation,
          id: agent.id,
          label: agent.label,
          installed: true,
          version,
          compatibleRange,
          compatible: version && compatibleRange
            ? satisfiesRange(version, compatibleRange)
            : null,
        };
      } catch {
        return {
          observation,
          id: agent.id,
          label: agent.label,
          installed: false,
          version: null,
          compatibleRange,
          compatible: null,
          installHint: agent.installHint,
        };
      }
    }),
  };
}

export function formatAgentCliDiagnosticReport(report: AgentCliDiagnosticReport): string {
  const lines = [
    'Agent CLI compatibility (daemon-first)',
    '',
    report.migration,
    '',
  ];
  lines.push('Registration is file evidence only; activation/trust and event reception are not verified.', '');
  for (const agent of report.agents) {
    lines.push(`  ${agent.label} integration: registration ${agent.observation.registration}; availability not verified; events not checked`);
    if (!agent.installed) {
      lines.push(`- ${agent.label}: not found — install: ${agent.installHint}`);
      continue;
    }
    const version = agent.version ?? 'version unknown';
    if (!agent.compatibleRange) {
      lines.push(`- ${agent.label}: ${version} — installed (no pinned compatibility range)`);
    } else if (agent.compatible === true) {
      lines.push(`- ${agent.label}: ${version} — compatible (${agent.compatibleRange})`);
    } else if (agent.compatible === false) {
      lines.push(`- ${agent.label}: ${version} — OUTSIDE supported range ${agent.compatibleRange}`);
    } else {
      lines.push(`- ${agent.label}: ${version} — could not evaluate ${agent.compatibleRange}`);
    }
  }
  lines.push('', `Managed-session compatibility: ${report.trackingIssue}`);
  return lines.join('\n');
}
