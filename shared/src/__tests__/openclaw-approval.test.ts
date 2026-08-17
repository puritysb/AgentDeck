// Behaviour gate for the OpenClaw exec-approval SSOT.
//
// Every fixture below is the shape OpenClaw's own gateway bundle produces
// (`buildRequestedApprovalEvent` → `{ id, request, createdAtMs, expiresAtMs }`,
// `resolveExecApprovalRequestAllowedDecisions` for the decision set). Fixtures
// invented from what the code happens to read are how this surface shipped
// broken in the first place — a test written against `payload.command` would
// have passed for the entire time no user could see a command.
import { describe, it, expect } from 'vitest';
import {
  parseExecApprovalRequest,
  decisionForOptionIndex,
  decisionForRespondValue,
  execApprovalAllows,
  EXEC_APPROVAL_DECISIONS,
} from '../openclaw-approval.js';

/** The real event shape: everything renderable is nested under `request`. */
const gatewayEvent = {
  id: 'aa2318a0-dfdb-40e2-8238-c09e7905f95e',
  createdAtMs: 1_786_940_704_797,
  expiresAtMs: 1_786_940_764_797,
  request: {
    command: 'rg --files-with-matches TODO src',
    cwd: '/Users/dev/project',
    ask: 'on-miss',
    security: 'full',
    warningText: 'Reads every file under src.',
    allowedDecisions: ['allow-once', 'allow-always', 'deny'],
    sessionKey: 'agent:main:eval-a03',
  },
};

describe('parseExecApprovalRequest', () => {
  it('reads the command out of the nested request', () => {
    const prompt = parseExecApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.command).toBe('rg --files-with-matches TODO src');
    // The headline IS the command — this is the whole point of the fix. The
    // previous code produced the literal "Approve tool execution?" here.
    expect(prompt.question).toBe('rg --files-with-matches TODO src');
    expect(prompt.question).not.toContain('Approve tool execution');
  });

  it('never renders `ask` as if it were the question', () => {
    // `ask` is the POLICY ("on-miss" / "always"). It used to be concatenated
    // onto the command as though it were a human-readable prompt.
    const prompt = parseExecApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.question).not.toContain('on-miss');
    expect(prompt.detail ?? '').not.toContain('on-miss');
  });

  it('carries cwd and warning as supporting detail', () => {
    const prompt = parseExecApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.cwd).toBe('/Users/dev/project');
    expect(prompt.detail).toContain('cwd: /Users/dev/project');
    expect(prompt.detail).toContain('Reads every file under src.');
  });

  it('offers exactly the decisions the request allows', () => {
    const prompt = parseExecApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual([
      'allow-once', 'allow-always', 'deny',
    ]);
    expect(prompt.options.map((o) => o.index)).toEqual([0, 1, 2]);
  });

  it('drops allow-always when the policy withholds it', () => {
    // `ask: "always"` narrows the set — offering allow-always anyway comes back
    // as "allow-always is unavailable because the effective policy requires
    // approval every time".
    const prompt = parseExecApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, allowedDecisions: ['allow-once', 'deny'] },
    }, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual(['allow-once', 'deny']);
  });

  it('honors unavailableDecisions on top of the allowed set', () => {
    const prompt = parseExecApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, unavailableDecisions: ['allow-always'] },
    }, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual(['allow-once', 'deny']);
  });

  it('always keeps a deny — a prompt you can only accept is not a prompt', () => {
    const prompt = parseExecApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, allowedDecisions: [], unavailableDecisions: [...EXEC_APPROVAL_DECISIONS] },
    }, 0)!;
    expect(prompt.options.map((o) => o.decision)).toEqual(['deny']);
  });

  it('still produces an answerable prompt when no command was reported', () => {
    // Degraded, not broken: the user must keep the ability to deny something
    // the Gateway declined to describe.
    const prompt = parseExecApprovalRequest({ id: 'x', request: {} }, 0)!;
    expect(prompt.command).toBe('');
    expect(prompt.question).toContain('command not reported');
    expect(prompt.options.length).toBeGreaterThan(0);
  });

  it('falls back to flat fields if a Gateway ever inlines them', () => {
    const prompt = parseExecApprovalRequest({ id: 'x', command: 'ls -la' }, 0)!;
    expect(prompt.question).toBe('ls -la');
  });

  it('falls back to argv when only that is present', () => {
    const prompt = parseExecApprovalRequest(
      { id: 'x', request: { commandArgv: ['git', 'status'] } }, 0)!;
    expect(prompt.question).toBe('git status');
  });

  it('returns null only when there is no usable id', () => {
    expect(parseExecApprovalRequest({ request: { command: 'ls' } }, 0)).toBeNull();
    expect(parseExecApprovalRequest({ id: '  ' }, 0)).toBeNull();
    expect(parseExecApprovalRequest(null, 0)).toBeNull();
  });

  it('carries the expiry so a stale prompt can be swept', () => {
    const prompt = parseExecApprovalRequest(gatewayEvent, 0)!;
    expect(prompt.expiresAtMs).toBe(1_786_940_764_797);
  });
});

describe('answering', () => {
  const prompt = parseExecApprovalRequest(gatewayEvent, 0)!;

  it('maps an option index to the decision that option carries', () => {
    expect(decisionForOptionIndex(prompt, 0)).toBe('allow-once');
    expect(decisionForOptionIndex(prompt, 1)).toBe('allow-always');
    expect(decisionForOptionIndex(prompt, 2)).toBe('deny');
  });

  it('refuses an out-of-range index instead of guessing', () => {
    expect(decisionForOptionIndex(prompt, 9)).toBeNull();
    expect(decisionForOptionIndex(prompt, -1)).toBeNull();
  });

  it('accepts shortcuts, decision names, and the y/n/a spellings', () => {
    expect(decisionForRespondValue(prompt, 'y')).toBe('allow-once');
    expect(decisionForRespondValue(prompt, 'a')).toBe('allow-always');
    expect(decisionForRespondValue(prompt, 'n')).toBe('deny');
    expect(decisionForRespondValue(prompt, 'allow')).toBe('allow-once');
    expect(decisionForRespondValue(prompt, 'allow-always')).toBe('allow-always');
    expect(decisionForRespondValue(prompt, 'Deny')).toBe('deny');
  });

  it('never turns an unrecognized press into an approval', () => {
    expect(decisionForRespondValue(prompt, 'maybe')).toBeNull();
    expect(decisionForRespondValue(prompt, '')).toBeNull();
  });

  it('refuses "always" when the request forbids allow-always', () => {
    // Downgrading it to a one-shot allow would silently answer a different
    // question than the user asked.
    const narrow = parseExecApprovalRequest({
      ...gatewayEvent,
      request: { ...gatewayEvent.request, allowedDecisions: ['allow-once', 'deny'] },
    }, 0)!;
    expect(decisionForRespondValue(narrow, 'always')).toBeNull();
    expect(decisionForRespondValue(narrow, 'y')).toBe('allow-once');
  });

  it('classifies which decisions let the command run', () => {
    expect(execApprovalAllows('allow-once')).toBe(true);
    expect(execApprovalAllows('allow-always')).toBe(true);
    expect(execApprovalAllows('deny')).toBe(false);
    // The label bug: comparing the real decision to 'allow' marked every
    // approval as denied.
    expect(execApprovalAllows('allow')).toBe(false);
  });
});
