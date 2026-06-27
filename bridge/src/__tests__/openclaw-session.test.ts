import { describe, it, expect } from 'vitest';
import { injectOpenClawSession } from '../openclaw-session.js';
import type { EnrichedSession } from '../session-aggregator.js';

const claude: EnrichedSession = {
  id: 'claude-1', port: 9121, projectName: 'Backend', agentType: 'claude-code', alive: true, state: 'idle',
};
const existingOpenClaw: EnrichedSession = {
  id: 'openclaw-gateway', port: 18789, projectName: 'OpenClaw', agentType: 'openclaw', alive: true, state: 'idle',
};

describe('injectOpenClawSession', () => {
  it('does NOT inject when the Gateway is reachable but not authenticated (regression: phantom trace)', () => {
    // The exact stuck state: index.ts used to gate on gatewayAvailable and
    // injected a phantom session whenever port 18789 answered. Authentication
    // (gatewayConnected) is now the only gate.
    const out = injectOpenClawSession([claude], { gatewayConnected: false });
    expect(out).toHaveLength(1);
    expect(out.some(s => s.agentType === 'openclaw')).toBe(false);
  });

  it('injects a minimal session when authenticated (CLI bridge shape)', () => {
    const out = injectOpenClawSession([claude], { gatewayConnected: true });
    expect(out).toHaveLength(2);
    const oc = out.find(s => s.agentType === 'openclaw')!;
    expect(oc.id).toBe('openclaw-gateway');
    expect(oc.port).toBe(18789);
    expect(oc.projectName).toBe('OpenClaw');
    // CLI bridge omits the daemon-hub extras.
    expect(oc.state).toBeUndefined();
    expect(oc.controlMode).toBeUndefined();
  });

  it('carries daemon-hub extras (state/projectName/modelName/controlMode) when provided', () => {
    const out = injectOpenClawSession([claude], {
      gatewayConnected: true,
      state: 'processing',
      projectName: 'my-repo',
      modelName: 'opus-4',
      controlMode: 'managed',
    });
    const oc = out.find(s => s.agentType === 'openclaw')!;
    expect(oc.state).toBe('processing');
    expect(oc.projectName).toBe('my-repo');
    expect(oc.modelName).toBe('opus-4');
    expect(oc.controlMode).toBe('managed');
  });

  it('is idempotent — does not duplicate an already-present openclaw session', () => {
    const out = injectOpenClawSession([claude, existingOpenClaw], { gatewayConnected: true });
    expect(out).toHaveLength(2);
    expect(out.filter(s => s.agentType === 'openclaw')).toHaveLength(1);
  });

  it('returns the original array reference when not injecting (no needless copy)', () => {
    const input = [claude];
    expect(injectOpenClawSession(input, { gatewayConnected: false })).toBe(input);
  });
});
