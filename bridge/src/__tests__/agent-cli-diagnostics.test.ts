import { describe, expect, it } from 'vitest';
import {
  collectAgentCliDiagnosticReport,
  formatAgentCliDiagnosticReport,
} from '../agent-cli-diagnostics.js';

describe('agent CLI compatibility diagnostics', () => {
  it('reports installed versions against package-owned compatibility ranges', () => {
    const outputs: Record<string, string> = {
      'claude --version': '2.1.50 (Claude Code)',
      'codex --version': 'codex-cli 0.141.0',
      'opencode --version': '1.0.200',
    };
    const report = collectAgentCliDiagnosticReport((command) => outputs[command], () => 'detected');

    expect(report.agents).toEqual([
      expect.objectContaining({ id: 'claude', installed: true, version: '2.1.50', compatible: true }),
      expect.objectContaining({ id: 'codex', installed: true, version: '0.141.0', compatible: true }),
      expect.objectContaining({ id: 'opencode', installed: true, version: '1.0.200', compatible: null }),
    ]);
  });

  it('reports a missing binary without exposing command output', () => {
    const report = collectAgentCliDiagnosticReport((command) => {
      if (command.startsWith('codex ')) throw new Error('private shell detail');
      return command.startsWith('claude ') ? '2.1.50' : '1.0.200';
    }, () => 'absent');
    const codex = report.agents.find((agent) => agent.id === 'codex');

    expect(codex).toMatchObject({ installed: false, version: null, compatible: null });
    expect(JSON.stringify(report)).not.toContain('private shell detail');
  });

  it('formats an actionable daemon-first report', () => {
    const report = collectAgentCliDiagnosticReport((command) =>
      command.startsWith('claude ') ? '2.1.50'
        : command.startsWith('codex ') ? '0.1.0'
          : '1.0.200',
      () => 'absent',
    );
    const text = formatAgentCliDiagnosticReport(report);

    expect(text).toContain('agentdeck daemon install');
    expect(text).toContain('Codex CLI: 0.1.0 — OUTSIDE supported range');
    expect(text).toContain('issues/273');
  });
});

it('does not confuse written configuration with active observation', () => {
  const report = collectAgentCliDiagnosticReport(() => '1.0.0', agent => agent === 'codex' ? 'unreadable' : 'detected');
  expect(report.agents.find(a => a.id === 'codex')?.observation.registration).toBe('unreadable');
  for (const agent of report.agents) {
    expect(agent.observation.availability).toBe('not_verified');
    expect(agent.observation.eventReception).toBe('not_checked');
  }
  expect(formatAgentCliDiagnosticReport(report)).toContain('Registration is file evidence only');
});
