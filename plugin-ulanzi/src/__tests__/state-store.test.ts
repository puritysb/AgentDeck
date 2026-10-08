import { describe, expect, it } from 'vitest';
import { PermissionMode, State, type BridgeEvent, type SessionInfo } from '@agentdeck/shared';
import { StateStore } from '../state-store.js';

const claude: SessionInfo = {
  id: 'claude:enhance-timeline',
  port: 9121,
  projectName: 'enhance-timeline',
  agentType: 'claude-code',
  alive: true,
  state: State.PROCESSING,
};

function connectedStore(): StateStore {
  const store = new StateStore();
  store.setConnected(true);
  store.apply({ type: 'sessions_list', sessions: [claude] });
  return store;
}

describe('D200H StateStore session isolation', () => {
  it('keeps daemon transport separate from an empty disconnected aggregate state', () => {
    const store = new StateStore();
    store.setConnected(true);
    store.apply({ type: 'state_update', state: State.DISCONNECTED } as BridgeEvent);
    store.apply({ type: 'sessions_list', sessions: [] });
    expect(store.toLayoutInput()).toMatchObject({
      state: State.DISCONNECTED,
      daemonConnected: true,
      allSessions: [],
    });

    store.setConnected(false);
    expect(store.toLayoutInput()).toMatchObject({
      state: 'DISCONNECTED',
      daemonConnected: false,
      allSessions: [],
    });
  });

  it('does not use the global OpenClaw model while Claude focus is pending', () => {
    const store = connectedStore();
    store.apply({
      type: 'state_update',
      state: State.PROCESSING,
      permissionMode: PermissionMode.DEFAULT,
      sessionId: 'openclaw-gateway',
      focusedSessionId: 'openclaw-gateway',
      agentType: 'openclaw',
      modelName: 'GLM-5.2 (1M)',
    });

    store.prepareFocus(claude.id);
    const detail = store.toLayoutInput(claude.id);
    expect(detail.sessionId).toBe(claude.id);
    expect(detail.modelName).toBeUndefined();
    expect(detail.options).toEqual([]);
  });

  it('ignores unscoped and foreign prompt options for the selected session', () => {
    const store = connectedStore();
    const unscoped = store.apply({
      type: 'prompt_options',
      promptType: 'multi_select',
      options: [{ index: 0, label: 'Run unrelated task' }],
    } as BridgeEvent);
    store.apply({
      type: 'prompt_options',
      sessionId: 'openclaw-gateway',
      focusedSessionId: 'openclaw-gateway',
      promptType: 'multi_select',
      options: [{ index: 0, label: 'Switch to GLM' }],
    } as BridgeEvent);

    expect(unscoped).toBe(false);
    expect(store.toLayoutInput(claude.id).options).toEqual([]);
  });

  it('applies prompt options only to their correlated session', () => {
    const store = connectedStore();
    store.apply({
      type: 'prompt_options',
      sessionId: claude.id,
      focusedSessionId: claude.id,
      promptType: 'yes_no',
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
    } as BridgeEvent);

    expect(store.toLayoutInput(claude.id)).toMatchObject({
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
    });
  });
});

// An observed session has no live state channel: its state/question/options
// only ever arrive on its sessions_list row. Opening one sends `focus_session`,
// and the daemon answers with its GLOBAL state snapshot stamped with that
// session's focusedSessionId — which used to be stored as the session's own and
// shadow the roster row, blanking a live question into "answer in terminal".
describe('D200H StateStore — observed rows are not shadowed by the focus reply', () => {
  const observed: SessionInfo = {
    id: 'observed:claude:abc-123',
    port: 0,
    projectName: 'AgentDeck',
    agentType: 'claude-code',
    alive: true,
    controlMode: 'observed',
    state: State.AWAITING_OPTION,
    question: 'Pick a language',
    options: [{ index: 0, label: 'TypeScript' }, { index: 1, label: 'Swift' }],
    liveAnswerable: true,
  };

  function storeWithObserved(): StateStore {
    const store = new StateStore();
    store.setConnected(true);
    store.apply({ type: 'sessions_list', sessions: [observed] });
    return store;
  }

  const focusReply = {
    type: 'state_update',
    state: State.IDLE,
    permissionMode: PermissionMode.DEFAULT,
    sessionId: 'daemon-hook',
    focusedSessionId: observed.id,
  } as BridgeEvent;

  it('keeps the live question and options when the focus reply lands', () => {
    const store = storeWithObserved();
    store.prepareFocus(observed.id);
    store.apply(focusReply);

    expect(store.toLayoutInput(observed.id)).toMatchObject({
      state: State.AWAITING_OPTION,
      question: 'Pick a language',
      options: [{ index: 0, label: 'TypeScript' }, { index: 1, label: 'Swift' }],
    });
  });

  it('lets the roster row win even over a snapshot stored before the row arrived', () => {
    const store = new StateStore();
    store.setConnected(true);
    // Snapshot first: `controlMode` is unknown at this point, so it is stored.
    store.apply(focusReply);
    store.apply({ type: 'sessions_list', sessions: [observed] });

    expect(store.toLayoutInput(observed.id)).toMatchObject({
      state: State.AWAITING_OPTION,
      question: 'Pick a language',
    });
  });

  it('still lets a managed session\'s live state override its roster row', () => {
    const store = new StateStore();
    store.setConnected(true);
    store.apply({ type: 'sessions_list', sessions: [claude] });
    store.apply({
      type: 'state_update',
      state: State.AWAITING_OPTION,
      permissionMode: PermissionMode.DEFAULT,
      sessionId: claude.id,
      focusedSessionId: claude.id,
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }],
    } as BridgeEvent);

    expect(store.toLayoutInput(claude.id)).toMatchObject({
      state: State.AWAITING_OPTION,
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }],
    });
  });
});

it('clears Dot integration on legacy snapshots and reconnect instead of retaining another daemon', () => {
  const store = connectedStore();
  const dot = { configured: true, hosting: false, reportState: null, reportedAt: null, expiresAt: null };
  store.apply({ type: 'sessions_list', sessions: [claude], dot });
  expect(store.toLayoutInput().dot).toEqual(dot);
  store.apply({ type: 'sessions_list', sessions: [claude] });
  expect(store.toLayoutInput().dot).toBeNull();
  store.apply({ type: 'sessions_list', sessions: [claude], dot });
  store.setConnected(false); store.setConnected(true);
  expect(store.toLayoutInput().dot).toBeNull();
});
