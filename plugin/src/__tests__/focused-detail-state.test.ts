import { describe, expect, it } from 'vitest';
import {
  PermissionMode,
  State,
  type PromptOptionsEvent,
  type SessionInfo,
  type StateUpdateEvent,
} from '@agentdeck/shared';
import { FocusedDetailState } from '../focused-detail-state.js';

const claude: SessionInfo = {
  id: 'claude:enhance-timeline',
  port: 9121,
  projectName: 'enhance-timeline',
  agentType: 'claude-code',
  alive: true,
  state: State.PROCESSING,
};

function state(overrides: Partial<StateUpdateEvent>): StateUpdateEvent {
  return {
    type: 'state_update',
    state: State.PROCESSING,
    permissionMode: PermissionMode.DEFAULT,
    ...overrides,
  };
}

describe('FocusedDetailState', () => {
  it('does not carry an OpenClaw GLM model into a focused Claude session', () => {
    const store = new FocusedDetailState();
    store.prime(claude);

    expect(store.applyState(state({
      sessionId: 'openclaw-gateway',
      focusedSessionId: 'openclaw-gateway',
      agentType: 'openclaw',
      modelName: 'GLM-5.2 (1M)',
    }), claude)).toBeNull();

    const detail = store.applyState(state({
      sessionId: claude.id,
      focusedSessionId: claude.id,
      agentType: 'claude-code',
      currentTool: 'Edit',
    }), claude);

    expect(detail).toMatchObject({ sessionId: claude.id, tool: 'Edit' });
    expect(detail?.modelName).toBeUndefined();
  });

  it('drops late options from another session and unscoped legacy options', () => {
    const store = new FocusedDetailState();
    store.prime(claude);
    const foreign: PromptOptionsEvent = {
      type: 'prompt_options',
      sessionId: 'openclaw-gateway',
      focusedSessionId: 'openclaw-gateway',
      promptType: 'multi_select',
      options: [{ index: 0, label: 'Switch to GLM' }],
    };
    const unscoped: PromptOptionsEvent = {
      type: 'prompt_options',
      promptType: 'multi_select',
      options: [{ index: 0, label: 'Run unrelated task' }],
    };

    expect(store.applyOptions(foreign, claude)).toBeNull();
    expect(store.applyOptions(unscoped, claude)).toBeNull();
    expect(store.snapshot?.options).toEqual([]);
  });

  it('accepts options correlated to the selected session', () => {
    const store = new FocusedDetailState();
    store.prime(claude);
    const options: PromptOptionsEvent = {
      type: 'prompt_options',
      sessionId: claude.id,
      focusedSessionId: claude.id,
      promptType: 'yes_no',
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
    };

    expect(store.applyOptions(options, claude)).toMatchObject({
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }, { index: 1, label: 'No' }],
    });
  });

  // An observed session has no live state channel — its prompt only ever
  // arrives on its sessions_list row. Opening one sends `focus_session`, and
  // the daemon replies with its GLOBAL snapshot stamped with that session's
  // focusedSessionId: it passes the attribution check, so applied as a
  // replacement it blanked the live question and its options off the deck.
  it('keeps an observed session\'s live prompt when the focus reply lands', () => {
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
    const store = new FocusedDetailState();
    store.prime(observed);

    const focusReply = state({ state: State.IDLE, focusedSessionId: observed.id });
    expect(store.applyState(focusReply, observed)).toMatchObject({
      state: State.AWAITING_OPTION,
      question: 'Pick a language',
      options: [{ index: 0, label: 'TypeScript' }, { index: 1, label: 'Swift' }],
    });
  });

  it('still lets a managed session\'s live state replace its detail snapshot', () => {
    const store = new FocusedDetailState();
    store.prime(claude);
    expect(store.applyState(
      state({
        state: State.AWAITING_OPTION,
        sessionId: claude.id,
        question: 'Allow Edit?',
        options: [{ index: 0, label: 'Yes' }],
      }),
      claude,
    )).toMatchObject({
      state: State.AWAITING_OPTION,
      question: 'Allow Edit?',
      options: [{ index: 0, label: 'Yes' }],
    });
  });
});
