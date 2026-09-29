import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import rules from '../../shared/gateway-setup-status.json';

describe('Gateway setup status', () => {
  it('keeps Apple and Android generated decisions in sync', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-gateway-setup-status.mjs', '--check'])).not.toThrow();
  });
  it('does not request setup for transport progress or timeouts', () => {
    for (const status of ['reconnecting', 'gateway_reachable', 'connect_timeout'] as const) {
      expect(rules[status][0]).toBe('awaitingData');
    }
  });
});
