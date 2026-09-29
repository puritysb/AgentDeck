// Behaviour gate for the OpenClaw plugin-approval SSOT.
//
// Every fixture below is the shape OpenClaw's own gateway bundle produces
// (`buildRequestedApprovalEvent(record, 'plugin')` →
// `{approvalKind: 'plugin', id, request, createdAtMs, expiresAtMs}`,
// `resolveCanonicalPluginApprovalRequestAllowedDecisions` for the decision
// set), read out of the installed `openclaw` package's own `.d.ts` files
// (`approval-types-CQ_BKP9V.d.ts`, `approvals-CiGTrkJW.d.ts`) rather than
// invented from what the parser happens to read.
import { describe, it, expect } from 'vitest';
import {
  isApprovalGoneError,
  parsePluginApprovalRequest,
  parsePluginApprovalRemoved,
  pluginDecisionForOptionIndex,
  pluginDecisionForRespondValue,
  pluginApprovalAllows,
  PLUGIN_APPROVAL_DECISIONS,
  PLUGIN_APPROVAL_DEFAULT_SEVERITY,
} from '../openclaw-plugin-approval.js';

/** The real event shape: everything renderable is nested under `request`. */
const gatewayEvent = {
  approvalKind: 'plugin' as const,
  id: 'plugin:aa2318a0-dfdb-40e2-8238-c09e7905f95e',
  createdAtMs: 1_786_940_704_797,
  expiresAtMs: 1_786_940_824_797,
  request: {
    pluginId: 'telegram',
    title: 'Send message to #ops',
    description: 'Post a status update to the #ops channel.',
    severity: 'warning' as const,
    toolName: 'channel.send',
    allowedDecisions: ['allow-once', 'allow-always', 'deny'],
    agentId: 'main',
    sessionKey: 'agent:main:main',
  },
};

describe('parsePluginApprovalRequest', () => {
  it('reads the title as the headline, not a generic fallback', () => {
    const prompt = parsePluginApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.question).toBe('Send message to #ops');
    expect(prompt.question).not.toContain('title not reported');
  });

  it('carries the description as the lead supporting line', () => {
    const prompt = parsePluginApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.detail!.split('\n')[0]).toBe('Post a status update to the #ops channel.');
    expect(prompt.detail).toContain('tool: channel.send');
    expect(prompt.detail).toContain('plugin: telegram');
  });

  it('defaults severity to "warning" when the Gateway omitted it — matching buildPluginApprovalRequestMessage', () => {
    const prompt = parsePluginApprovalRequest(
      { id: 'plugin:x', request: { title: 't', description: 'd' } }, 0)!;
    expect(prompt.severity).toBe('warning');
    expect(prompt.severity).toBe(PLUGIN_APPROVAL_DEFAULT_SEVERITY);
  });

  it('honors an explicit severity', () => {
    const prompt = parsePluginApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, severity: 'critical' },
    }, 0)!;
    expect(prompt.severity).toBe('critical');
  });

  it('offers exactly the decisions the request allows', () => {
    const prompt = parsePluginApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual([
      'allow-once', 'allow-always', 'deny',
    ]);
  });

  it('narrows to an explicit allowedDecisions list — no unavailableDecisions subtraction exists on this surface', () => {
    const prompt = parsePluginApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, allowedDecisions: ['allow-once', 'deny'] },
    }, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual(['allow-once', 'deny']);
  });

  it('always keeps a deny — a prompt you can only accept is not a prompt', () => {
    const prompt = parsePluginApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, allowedDecisions: ['allow-once'] },
    }, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual(['allow-once', 'deny']);
  });

  it('never offers the plain "allow" the Gateway rejects, even if the Gateway sent it', () => {
    // Same defect exec shipped: `isApprovalDecision('allow')` is false and the
    // Gateway checks it BEFORE the id lookup, so a filtered-through 'allow'
    // would resolve to INVALID_REQUEST and strand the approval pending.
    const prompt = parsePluginApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, allowedDecisions: ['allow', 'deny'] },
    }, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual(['deny']);
    expect(PLUGIN_APPROVAL_DECISIONS as readonly string[]).not.toContain('allow');
  });

  it('falls back to the full default set when allowedDecisions is empty/absent', () => {
    const prompt = parsePluginApprovalRequest(
      { id: 'plugin:x', request: { title: 't', description: 'd' } }, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual([...PLUGIN_APPROVAL_DECISIONS]);
  });

  it('still produces an answerable prompt when no title/description was reported', () => {
    const prompt = parsePluginApprovalRequest({ id: 'plugin:x', request: {} }, 0)!;
    expect(prompt.title).toBe('');
    expect(prompt.question).toContain('title not reported');
    expect(prompt.detail).toBeUndefined();
    expect(prompt.options.length).toBeGreaterThan(0);
  });

  it('falls back to flat fields if a Gateway ever inlines them', () => {
    const prompt = parsePluginApprovalRequest({ id: 'plugin:x', title: 'Flat title', description: 'd' }, 0)!;
    expect(prompt.question).toBe('Flat title');
  });

  it('returns null only when there is no usable id', () => {
    expect(parsePluginApprovalRequest({ request: { title: 't', description: 'd' } }, 0)).toBeNull();
    expect(parsePluginApprovalRequest({ id: '  ' }, 0)).toBeNull();
    expect(parsePluginApprovalRequest(null, 0)).toBeNull();
  });

  it('carries the expiry so a stale prompt can be swept', () => {
    const prompt = parsePluginApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.expiresAtMs).toBe(1_786_940_824_797);
  });

  it('carries which session asked', () => {
    const prompt = parsePluginApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.sessionKey).toBe('agent:main:main');
  });

  it('summarizes scope as a display-only supporting line', () => {
    const prompt = parsePluginApprovalRequest({
      ...gatewayEvent,
      request: {
        ...gatewayEvent.request,
        scope: { kind: 'message-send', target: '#ops', recipientCount: 12 },
      },
    }, 0)!;
    expect(prompt.detail).toContain('scope: message-send (#ops)');
  });
});

describe('answering', () => {
  const prompt = parsePluginApprovalRequest(gatewayEvent, 0)!;

  it('maps an option index to the decision that option carries', () => {
    expect(pluginDecisionForOptionIndex(prompt, 0)).toBe('allow-once');
    expect(pluginDecisionForOptionIndex(prompt, 1)).toBe('allow-always');
    expect(pluginDecisionForOptionIndex(prompt, 2)).toBe('deny');
  });

  it('refuses an out-of-range index instead of guessing', () => {
    expect(pluginDecisionForOptionIndex(prompt, 9)).toBeNull();
    expect(pluginDecisionForOptionIndex(prompt, -1)).toBeNull();
  });

  it('accepts shortcuts, decision names, and the y/n/a spellings', () => {
    expect(pluginDecisionForRespondValue(prompt, 'y')).toBe('allow-once');
    expect(pluginDecisionForRespondValue(prompt, 'a')).toBe('allow-always');
    expect(pluginDecisionForRespondValue(prompt, 'n')).toBe('deny');
    expect(pluginDecisionForRespondValue(prompt, 'allow-always')).toBe('allow-always');
    expect(pluginDecisionForRespondValue(prompt, 'Deny')).toBe('deny');
  });

  it('never turns an unrecognized press into an approval', () => {
    expect(pluginDecisionForRespondValue(prompt, 'maybe')).toBeNull();
    expect(pluginDecisionForRespondValue(prompt, '')).toBeNull();
  });

  it('refuses "always" when the request forbids allow-always', () => {
    const narrow = parsePluginApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, allowedDecisions: ['allow-once', 'deny'] },
    }, 0)!;
    expect(pluginDecisionForRespondValue(narrow, 'always')).toBeNull();
    expect(pluginDecisionForRespondValue(narrow, 'y')).toBe('allow-once');
  });

  it('classifies which decisions let the plugin action proceed', () => {
    expect(pluginApprovalAllows('allow-once')).toBe(true);
    expect(pluginApprovalAllows('allow-always')).toBe(true);
    expect(pluginApprovalAllows('deny')).toBe(false);
    expect(pluginApprovalAllows('allow')).toBe(false);
  });
});

describe('parsePluginApprovalRemoved', () => {
  it('reads the id out of the {id} payload the embedded broker emits', () => {
    expect(parsePluginApprovalRemoved({ id: 'plugin:abc' })).toBe('plugin:abc');
  });

  it('makes no claim about a payload it cannot read', () => {
    expect(parsePluginApprovalRemoved(null)).toBeNull();
    expect(parsePluginApprovalRemoved(undefined)).toBeNull();
    expect(parsePluginApprovalRemoved({})).toBeNull();
    expect(parsePluginApprovalRemoved({ id: '  ' })).toBeNull();
    expect(parsePluginApprovalRemoved({ id: 42 })).toBeNull();
  });
});

// The plugin surface reuses exec's error classifier — the Gateway's own
// `isApprovalStaleError` is shared code (`approval-shared-1gFEjucV.mjs`)
// across `exec.approval.resolve` and `plugin.approval.resolve`, so a second
// regex pair here would only be a second place for it to drift.
describe('isApprovalGoneError — shared with the exec module', () => {
  it('is the same predicate exec uses', () => {
    expect(isApprovalGoneError('unknown or expired approval id')).toBe(true);
    expect(isApprovalGoneError(new Error('Gateway disconnected'))).toBe(false);
    expect(isApprovalGoneError(null)).toBe(false);
  });
});
