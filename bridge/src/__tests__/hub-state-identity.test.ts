import { describe, expect, it } from 'vitest';
import type { AgentCapabilities } from '@agentdeck/shared';
import {
  HubStateDriverTracker,
  OPENCLAW_GATEWAY_SESSION_ID,
  resolveHubFrameIdentity,
  shapeHubFrame,
} from '../hub-state-identity.js';

const CAPS: AgentCapabilities = {
  type: 'openclaw',
  displayName: 'OpenClaw',
  hasTerminal: false,
  hasModeSwitching: false,
  hasDiffReview: false,
  hasOptionLists: true,
  hasNavigablePrompts: false,
  hasSuggestedPrompts: false,
  hasApiUsage: false,
  hasModelCatalog: true,
};

describe('resolveHubFrameIdentity', () => {
  it('a Claude hook driving the machine yields an aggregate frame with that session, never OpenClaw', () => {
    // The live 2026-09-11 shape: Gateway alive and idle, an observed Claude
    // session mid-turn. The old label was `openclaw` + `projectName: OpenClaw`.
    const id = resolveHubFrameIdentity(
      { kind: 'hook', sessionId: 'a9d9dfd6', agentType: 'claude-code', projectName: 'AgentDeck' },
      true,
      CAPS,
    );
    expect(id).toEqual({
      agentType: 'daemon',
      sessionId: 'a9d9dfd6',
      projectName: 'AgentDeck',
      gatewayOwned: false,
    });
    expect(id.agentCapabilities).toBeUndefined();
  });

  it('a hook without a session id still drops the OpenClaw label', () => {
    const id = resolveHubFrameIdentity({ kind: 'hook', agentType: 'claude-code' }, true, CAPS);
    expect(id.agentType).toBe('daemon');
    expect(id.sessionId).toBeUndefined();
    expect(id.projectName).toBeUndefined();
  });

  it('the Gateway driving the machine names its own row and takes its own snapshot', () => {
    expect(resolveHubFrameIdentity({ kind: 'gateway' }, true, CAPS)).toEqual({
      agentType: 'openclaw',
      agentCapabilities: CAPS,
      sessionId: OPENCLAW_GATEWAY_SESSION_ID,
      projectName: 'OpenClaw',
      gatewayOwned: true,
    });
  });

  it('no driver yet: OpenClaw while the Gateway is alive (unattributed), daemon otherwise', () => {
    const alive = resolveHubFrameIdentity(null, true, CAPS);
    expect(alive.agentType).toBe('openclaw');
    expect(alive.gatewayOwned).toBe(true);
    expect(alive.sessionId).toBeUndefined();
    expect(resolveHubFrameIdentity(null, false, CAPS)).toEqual({ agentType: 'daemon', gatewayOwned: false });
  });

  it('a hook driver outranks a live Gateway; a Gateway driver with the Gateway gone is plain daemon', () => {
    expect(resolveHubFrameIdentity({ kind: 'hook', agentType: 'claude-code', sessionId: 's' }, true, CAPS).agentType)
      .toBe('daemon');
    // Defensive: the tracker clears this on disconnect, but the resolver must
    // not label a dead Gateway `openclaw` even if handed a stale driver.
    expect(resolveHubFrameIdentity({ kind: 'gateway' }, false, CAPS).agentType).toBe('daemon');
  });
});

describe('HubStateDriverTracker', () => {
  it('remembers the latest driver and clears it on that session\'s end only', () => {
    const t = new HubStateDriverTracker();
    expect(t.current()).toBeNull();
    t.noteHook({ sessionId: 'a', agentType: 'claude-code', projectName: 'P' });
    t.noteHook({ sessionId: 'b', agentType: 'claude-code', projectName: 'Q' });
    expect(t.current()).toEqual({ kind: 'hook', sessionId: 'b', agentType: 'claude-code', projectName: 'Q' });
    t.noteSessionEnd('a');
    expect(t.current()?.kind).toBe('hook');
    t.noteSessionEnd('b');
    expect(t.current()).toBeNull();
  });

  it('gateway activity replaces a hook driver and is cleared when the Gateway goes away', () => {
    const t = new HubStateDriverTracker();
    t.noteHook({ sessionId: 'a', agentType: 'claude-code' });
    t.noteGateway();
    expect(t.current()).toEqual({ kind: 'gateway' });
    t.noteSessionEnd('a');
    expect(t.current()).toEqual({ kind: 'gateway' });
    t.noteGatewayGone();
    expect(t.current()).toBeNull();
    // Gateway loss does not erase a hook driver.
    t.noteHook({ sessionId: 'c', agentType: 'claude-code' });
    t.noteGatewayGone();
    expect(t.current()?.kind).toBe('hook');
  });

  it('an anonymous hook driver (no session id) is cleared by an anonymous end', () => {
    const t = new HubStateDriverTracker();
    t.noteHook({ agentType: 'claude-code' });
    t.noteSessionEnd('some-session');
    expect(t.current()?.kind).toBe('hook');
    t.noteSessionEnd(undefined);
    expect(t.current()).toBeNull();
  });

  it('normalises empty ids and projects to absent', () => {
    const t = new HubStateDriverTracker();
    t.noteHook({ sessionId: '', agentType: 'claude-code', projectName: '' });
    expect(t.current()).toEqual({ kind: 'hook', sessionId: undefined, agentType: 'claude-code', projectName: undefined });
  });
});

describe('shapeHubFrame', () => {
  // A frame as core.buildStateEvent produces it mid-Claude-turn: the global
  // machine is processing a Claude session's Bash call, and its projectName
  // was last written by the Gateway's project_info parser event.
  const midTurn = () => ({
    type: 'state_update',
    state: 'processing',
    projectName: 'OpenClaw',
    modelName: 'claude-fable-5-1',
    currentTool: 'Bash',
    toolInput: 'cd /Users/puritysb/github/AgentDeck',
    toolProgress: 'Using Bash',
    options: [{ label: 'x' }],
    question: 'q',
    promptType: 'yes_no',
    cursorIndex: 0,
    modelCatalog: [{ key: 'zai/glm-5.3' }],
  });

  it('Gateway (re)connect during a Claude turn announces the Gateway\'s own idle state, not the machine\'s turn', () => {
    // The HIGH finding: the connect broadcast used to ship the machine's
    // `processing` + Claude's Bash under the `openclaw` label on every reconnect.
    const out = shapeHubFrame(midTurn(), resolveHubFrameIdentity({ kind: 'gateway' }, true, CAPS), { state: 'idle', modelName: 'GLM-5.3 (1M)' });
    expect(out.state).toBe('idle');
    expect(out.modelName).toBe('GLM-5.3 (1M)');
    expect(out.sessionId).toBe(OPENCLAW_GATEWAY_SESSION_ID);
    expect(out.projectName).toBe('OpenClaw');
    for (const k of ['currentTool', 'toolInput', 'toolProgress', 'options', 'question', 'promptType', 'cursorIndex']) {
      expect(out).not.toHaveProperty(k);
    }
    // Metadata that rides every frame is untouched.
    expect(out.modelCatalog).toEqual([{ key: 'zai/glm-5.3' }]);
  });

  it('a Gateway that is itself waiting keeps its prompt fields', () => {
    const out = shapeHubFrame(midTurn(), resolveHubFrameIdentity({ kind: 'gateway' }, true, CAPS), { state: 'awaiting_permission' });
    expect(out.state).toBe('awaiting_permission');
    expect(out.options).toEqual([{ label: 'x' }]);
    expect(out.question).toBe('q');
    expect(out).not.toHaveProperty('modelName');
  });

  it('a hook-driven frame keeps the machine\'s turn but wears the hook session\'s identity', () => {
    const out = shapeHubFrame(
      midTurn(),
      resolveHubFrameIdentity({ kind: 'hook', sessionId: 'a9d9dfd6', agentType: 'claude-code', projectName: 'AgentDeck' }, true, CAPS),
      { state: 'idle' },
    );
    expect(out.state).toBe('processing');
    expect(out.currentTool).toBe('Bash');
    expect(out.toolInput).toBe('cd /Users/puritysb/github/AgentDeck');
    expect(out.sessionId).toBe('a9d9dfd6');
    expect(out.projectName).toBe('AgentDeck');
    expect(out.modelName).toBe('claude-fable-5-1');
  });

  it('a hook-driven frame without a project drops the Gateway\'s leftover label rather than carrying it', () => {
    const out = shapeHubFrame(midTurn(), resolveHubFrameIdentity({ kind: 'hook', agentType: 'claude-code' }, true, CAPS), { state: 'idle' });
    expect(out).not.toHaveProperty('projectName');
    expect(out).not.toHaveProperty('sessionId');
  });

  it('does not mutate its input', () => {
    const input = midTurn();
    shapeHubFrame(input, resolveHubFrameIdentity({ kind: 'gateway' }, true, CAPS), { state: 'idle' });
    expect(input.state).toBe('processing');
    expect(input.currentTool).toBe('Bash');
  });
});
