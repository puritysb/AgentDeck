import { describe, expect, it } from 'vitest';
import { State, type SessionInfo } from '@agentdeck/shared';
import { SessionSlotManager, isPlusFamily, type DeckLayout } from '../session-slot-manager.js';

const SD_PLUS_LAYOUT: DeckLayout = {
  columns: 4,
  rows: 2,
  keyCount: 8,
  family: 'streamdeckplus',
};

// Classic Stream Deck (15 keys, no encoder) — carries usage on the last 2 keys.
const SD_CLASSIC_LAYOUT: DeckLayout = {
  columns: 5,
  rows: 3,
  keyCount: 15,
  family: 'streamdeck',
};

// Stream Deck + XL (36 keys, 6 dials) — Plus family: usage rides the dials, so no
// keypad key is reserved and all 36 keys are session-fillable.
const SD_PLUS_XL_LAYOUT: DeckLayout = {
  columns: 9,
  rows: 4,
  keyCount: 36,
  family: 'streamdeckplusxl',
};

// Stream Deck XL (32 keys, no encoder) — carries usage on its last keypad keys.
const SD_XL_LAYOUT: DeckLayout = {
  columns: 8,
  rows: 4,
  keyCount: 32,
  family: 'streamdeckxl',
};

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'session-1',
    port: 9121,
    projectName: 'AgentDeck',
    agentType: 'claude-code',
    alive: true,
    state: State.IDLE,
    modelName: 'opus-4',
    effortLevel: 'high',
    ...overrides,
  };
}

describe('SessionSlotManager detail layout', () => {
  it('re-points detail focus onto the codex fold representative when the focused thread is absorbed', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({ id: 'codex:old', agentType: 'codex-cli', state: State.IDLE, startedAt: '2026-04-11T10:00:00Z' }),
    ]);
    manager.enterDetailView('codex:old');
    expect(manager.focusedSessionId).toBe('codex:old');

    manager.updateSessions([
      makeSession({ id: 'codex:old', agentType: 'codex-cli', state: State.IDLE, startedAt: '2026-04-11T10:00:00Z' }),
      makeSession({ id: 'codex:new', agentType: 'codex-cli', state: State.PROCESSING, startedAt: '2026-04-11T10:02:00Z' }),
    ]);

    expect(manager.view).toBe('detail');
    expect(manager.focusedSessionId).toBe('codex:new');
    expect(manager.getFocusedSession()?.foldedSessionIds).toContain('codex:old');
  });

  it('exits detail view when the focused session is gone with no fold successor', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({ id: 'claude:1', agentType: 'claude-code', state: State.IDLE }),
    ]);
    manager.enterDetailView('claude:1');

    manager.updateSessions([]);

    expect(manager.view).toBe('list');
    expect(manager.focusedSessionId).toBeNull();
  });

  it('folds codex companion threads by project before slot assignment', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({
        id: 'codex:old',
        agentType: 'codex-cli',
        state: State.IDLE,
        startedAt: '2026-04-11T10:00:00Z',
      }),
      makeSession({
        id: 'codex:new',
        agentType: 'codex-cli',
        state: State.PROCESSING,
        currentTool: 'exec',
        startedAt: '2026-04-11T10:02:00Z',
      }),
      makeSession({
        id: 'claude:1',
        agentType: 'claude-code',
        state: State.IDLE,
        startedAt: '2026-04-11T10:01:00Z',
      }),
    ]);

    expect(manager.sessions.map(s => s.id)).toEqual(['claude:1', 'codex:new']);
    expect(manager.sessions[1]).toMatchObject({
      groupSize: 2,
      foldedSessionIds: ['codex:old', 'codex:new'],
      currentTool: 'exec',
      state: State.PROCESSING,
    });
  });

  it('renders connected no-session list as status cards instead of text-only empty buttons', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([]);

    expect(manager.getSlotConfig(0, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'HUB READY',
      subtitle: 'CONNECTED',
      icon: 'hub',
    });
    expect(manager.getSlotConfig(1, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'NO SESSION',
      subtitle: 'WAITING',
      icon: 'no-session',
    });
    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'AgentDeck',
      subtitle: 'IDLE',
      icon: 'agentdeck',
    });
  });

  it('puts processing tool info before OpenClaw presets', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({
        id: 'openclaw',
        agentType: 'openclaw',
        state: State.PROCESSING,
        modelName: 'gpt-5',
      }),
    ]);
    manager.enterDetailView('openclaw');
    manager.updateDetailState(State.PROCESSING, [], 'logs.tail', 'tail latest logs', undefined, 'gpt-5');

    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'logs.tail',
      subtitle: 'tail latest logs',
      icon: 'tool',
    });
    expect(manager.getSlotConfig(3, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'STATUS' },
    });
    expect(manager.getSlotConfig(4, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'MODEL' },
    });
    expect(manager.getSlotConfig(5, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'GATEWAY' },
    });
  });

  it('keeps a processing status tile even before tool metadata arrives', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      makeSession({
        id: 'openclaw',
        agentType: 'openclaw',
        state: State.PROCESSING,
      }),
    ]);
    manager.enterDetailView('openclaw');
    manager.updateDetailState(State.PROCESSING, []);

    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'status',
      label: 'ROUTING',
      subtitle: 'running',
      icon: 'tool',
    });
    expect(manager.getSlotConfig(3, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'STATUS' },
    });
  });

  it('aliases the model name on detail MODEL surfaces (status card + OpenClaw preset)', () => {
    // Claude Code IDLE: MODEL status card subtitle uses the alias, not the raw
    // upstream id. On the 8-key SD+ the VOICE key claims the last content slot,
    // so the MODEL card appears on layouts with more room (classic 15-key).
    const cc = new SessionSlotManager();
    cc.updateSessions([makeSession({ modelName: 'claude-sonnet-4-6', effortLevel: undefined })]);
    cc.enterDetailView('session-1');
    cc.updateDetailState(State.IDLE, [], undefined, undefined, undefined, 'claude-sonnet-4-6');
    const ccModelCard = Array.from({ length: SD_CLASSIC_LAYOUT.keyCount }, (_, i) => i)
      .map(i => cc.getSlotConfig(i, SD_CLASSIC_LAYOUT))
      .find(c => c.type === 'status' && c.label === 'MODEL');
    expect(ccModelCard).toMatchObject({ type: 'status', label: 'MODEL', subtitle: 'sonnet 4.6' });

    // OpenClaw IDLE: model preset subtitle is aliased too.
    const oc = new SessionSlotManager();
    oc.updateSessions([makeSession({ id: 'oc', agentType: 'openclaw', modelName: 'claude-opus-4-7' })]);
    oc.enterDetailView('oc');
    oc.updateDetailState(State.IDLE, [], undefined, undefined, undefined, 'claude-opus-4-7');
    const ocModelPreset = [0, 1, 2, 3, 4, 5, 6, 7]
      .map(i => oc.getSlotConfig(i, SD_PLUS_LAYOUT))
      .find(c => c.type === 'preset' && c.preset?.label === 'MODEL');
    expect(ocModelPreset?.preset?.subtitle).toBe('opus 4.7');
  });

  it('renders the MODEL tile exactly once in Claude PROCESSING detail (no duplicate)', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.PROCESSING, modelName: 'claude-opus-4-8' })]);
    manager.enterDetailView('session-1');
    manager.updateDetailState(State.PROCESSING, [], 'Edit', 'cli.ts', undefined, 'claude-opus-4-8', 'acceptEdits');

    const labels = [0, 1, 2, 3, 4, 5, 6, 7]
      .map(i => manager.getSlotConfig(i, SD_PLUS_LAYOUT))
      .filter(c => c.type === 'status' && c.label === 'MODEL');
    expect(labels).toHaveLength(1);
  });

  it('does not duplicate MODEL on OpenClaw idle (preset + status card)', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ id: 'oc', agentType: 'openclaw', modelName: 'gpt-5' })]);
    manager.enterDetailView('oc');
    manager.updateDetailState(State.IDLE, [], undefined, undefined, undefined, 'gpt-5');

    const modelSurfaces = [0, 1, 2, 3, 4, 5, 6, 7]
      .map(i => manager.getSlotConfig(i, SD_PLUS_LAYOUT))
      .filter(c => (c.type === 'status' && c.label === 'MODEL') || (c.type === 'preset' && c.preset?.label === 'MODEL'));
    expect(modelSurfaces).toHaveLength(1);
    expect(modelSurfaces[0].type).toBe('preset');
  });

  it('does not render a READY/idle tile while a Claude session is PROCESSING', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.PROCESSING, modelName: 'claude-opus-4-8' })]);
    manager.enterDetailView('session-1');
    manager.updateDetailState(State.PROCESSING, [], 'Edit', 'cli.ts', undefined, 'claude-opus-4-8', 'acceptEdits');

    const idleTiles = [0, 1, 2, 3, 4, 5, 6, 7]
      .map(i => manager.getSlotConfig(i, SD_PLUS_LAYOUT))
      .filter(c => c.type === 'status' && (c.label === 'READY' || c.subtitle === 'idle'));
    expect(idleTiles).toHaveLength(0);
  });

  it('keeps observed Claude PROCESSING free of queued task buttons', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({
      id: 'observed:claude:1',
      controlMode: 'observed',
      port: 0,
      state: State.PROCESSING,
      currentTool: 'Edit',
    })]);
    manager.enterDetailView('observed:claude:1');

    const configs = Array.from({ length: SD_PLUS_LAYOUT.keyCount }, (_, i) =>
      manager.getSlotConfig(i, SD_PLUS_LAYOUT));
    expect(configs.filter((config) => config.type === 'preset')).toHaveLength(0);
    expect(configs.filter((config) => config.type === 'stop')).toHaveLength(1);
  });

  it('observed AskUserQuestion: options are inert without liveAnswerable, pressable with it', () => {
    const options = [
      { index: 0, label: '7 days' },
      { index: 1, label: '14 days' },
    ];
    const build = (liveAnswerable?: boolean) => {
      const manager = new SessionSlotManager();
      manager.updateSessions([makeSession({
        id: 'observed:claude:ask',
        controlMode: 'observed',
        port: 0,
        state: State.AWAITING_OPTION,
        question: 'Which cleanup window?',
        options,
        ...(liveAnswerable == null ? {} : { liveAnswerable }),
      })]);
      manager.enterDetailView('observed:claude:ask');
      return Array.from({ length: SD_PLUS_LAYOUT.keyCount }, (_, i) =>
        manager.getSlotConfig(i, SD_PLUS_LAYOUT));
    };

    // No reachable terminal host: mirror the prompt, never a dead button.
    const inert = build(undefined);
    expect(inert.filter((c) => c.type === 'option')).toHaveLength(0);
    expect(inert.filter((c) => c.type === 'status' && c.label === '7 days')).toHaveLength(1);
    // Explicit false must behave exactly like absent — the App Store daemon
    // sends it in that polarity on purpose.
    expect(build(false).filter((c) => c.type === 'option')).toHaveLength(0);

    // The CLI daemon found a host: the same labels become real presses.
    const live = build(true);
    const pressable = live.filter((c) => c.type === 'option');
    expect(pressable).toHaveLength(2);
    expect(pressable.map((c) => c.optionIndex)).toEqual([0, 1]);
    expect(pressable[0].option?.label).toBe('7 days');
  });

  it('renders no MODEL tile for observed Codex PROCESSING on every Stream Deck layout', () => {
    for (const layout of [SD_PLUS_LAYOUT, SD_CLASSIC_LAYOUT]) {
      const manager = new SessionSlotManager();
      manager.updateSessions([makeSession({
        id: 'observed:codex:1',
        agentType: 'codex-cli',
        controlMode: 'observed',
        port: 0,
        state: State.PROCESSING,
        modelName: 'gpt-5.6-sol high',
      })]);
      manager.enterDetailView('observed:codex:1');

      const configs = Array.from({ length: layout.keyCount }, (_, i) =>
        manager.getSlotConfig(i, layout));
      const modelSlots = configs.filter(
        config => config.type === 'status' && config.label === 'MODEL',
      );

      expect(modelSlots).toHaveLength(0);
      expect(configs.filter((config) => config.type === 'status' && config.label === 'WORKING')).toHaveLength(1);
      expect(configs.filter((config) => config.type === 'preset')).toHaveLength(0);
      expect(configs.filter((config) => config.type === 'empty')).toHaveLength(layout.keyCount - 3);
    }
  });

  it('never renders MODEL as a key for any observed session state', () => {
    const scenarios: Partial<SessionInfo>[] = [
      { id: 'observed:claude:idle', agentType: 'claude-code', state: State.IDLE },
      { id: 'observed:opencode:idle', agentType: 'opencode', state: State.IDLE },
      { id: 'observed:claude:notice', agentType: 'claude-code', state: State.AWAITING_PERMISSION },
      {
        id: 'observed:claude:gate',
        agentType: 'claude-code',
        state: State.AWAITING_PERMISSION,
        requestId: 'request-1',
      },
    ];

    for (const layout of [SD_PLUS_LAYOUT, SD_CLASSIC_LAYOUT]) {
      for (const scenario of scenarios) {
        const manager = new SessionSlotManager();
        manager.updateSessions([makeSession({
          controlMode: 'observed',
          port: 0,
          modelName: 'must-not-render',
          ...scenario,
        })]);
        manager.enterDetailView(scenario.id!);

        const configs = Array.from({ length: layout.keyCount }, (_, i) =>
          manager.getSlotConfig(i, layout));
        expect(configs.some(config => config.type === 'status' && config.label === 'MODEL')).toBe(false);
      }
    }
  });

  it('does not render a STANDBY/idle tile while an OpenClaw session is PROCESSING', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ id: 'oc', agentType: 'openclaw', state: State.PROCESSING, modelName: 'gpt-5' })]);
    manager.enterDetailView('oc');
    manager.updateDetailState(State.PROCESSING, [], 'route', undefined, undefined, 'gpt-5');

    const idleTiles = [0, 1, 2, 3, 4, 5, 6, 7]
      .map(i => manager.getSlotConfig(i, SD_PLUS_LAYOUT))
      .filter(c => c.type === 'status' && (c.label === 'STANDBY' || c.subtitle === 'idle'));
    expect(idleTiles).toHaveLength(0);
  });

  it('uses actual parser options and reserves MORE only when awaiting overflow exists', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.AWAITING_OPTION })]);
    manager.enterDetailView('session-1');
    manager.updateDetailState(State.AWAITING_OPTION, [
      { index: 0, label: 'Yes' },
      { index: 1, label: 'No' },
      { index: 2, label: 'Always allow' },
      { index: 3, label: 'Deny' },
      { index: 4, label: 'Explain' },
    ]);

    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({ type: 'option', optionIndex: 0 });
    expect(manager.getSlotConfig(5, SD_PLUS_LAYOUT)).toMatchObject({ type: 'option', optionIndex: 3 });
    expect(manager.getSlotConfig(6, SD_PLUS_LAYOUT)).toMatchObject({ type: 'next-page', label: '1/2' });
    expect(manager.getSlotConfig(7, SD_PLUS_LAYOUT)).toMatchObject({ type: 'esc', label: 'active' });
  });

  // A single AskUserQuestion call can hold several questions and swaps between
  // them without ever leaving the awaiting state — so the page clamp (which only
  // ever shrinks the page to fit) would carry a stale page into a new question.
  it('resets option paging when the question changes, not just when awaiting ends', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.AWAITING_OPTION })]);
    manager.enterDetailView('session-1');
    const fiveOptions = [
      { index: 0, label: 'Yes' }, { index: 1, label: 'No' }, { index: 2, label: 'Always allow' },
      { index: 3, label: 'Deny' }, { index: 4, label: 'Explain' },
    ];
    manager.updateDetailState(State.AWAITING_OPTION, fiveOptions, undefined, undefined, 'Pick a language');
    expect(manager.handleSlotPress(6, SD_PLUS_LAYOUT)).toMatchObject({ action: 'next-page' });
    manager.nextPage(SD_PLUS_LAYOUT); // the plugin applies it
    expect(manager.getSlotConfig(6, SD_PLUS_LAYOUT)).toMatchObject({ label: '2/2' });

    // Next question, same awaiting state and same option count.
    manager.updateDetailState(State.AWAITING_OPTION, fiveOptions, undefined, undefined, 'Pick a target');
    expect(manager.getSlotConfig(6, SD_PLUS_LAYOUT)).toMatchObject({ label: '1/2' });
    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({ type: 'option', optionIndex: 0 });
    // And the echo a press carries names the question actually on screen.
    expect(manager.detailQuestion).toBe('Pick a target');
  });

  // Whether an observed session's options are pressable is the daemon's call:
  // it may be able to type into that session's terminal, or be holding its
  // AskUserQuestion hook open. Reading controlMode alone made both cases inert.
  it('makes observed options pressable exactly when the daemon says they are answerable', () => {
    const options = [{ index: 0, label: 'TypeScript' }, { index: 1, label: 'Swift' }];
    const observed = (liveAnswerable?: boolean) => makeSession({
      id: 'observed:claude:abc',
      state: State.AWAITING_OPTION,
      controlMode: 'observed',
      question: 'Pick a language',
      options,
      ...(liveAnswerable === undefined ? {} : { liveAnswerable }),
    });

    const answerable = new SessionSlotManager();
    answerable.updateSessions([observed(true)]);
    answerable.enterDetailView('observed:claude:abc');
    expect(answerable.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({ type: 'option', optionIndex: 0 });
    expect(answerable.getSlotConfig(3, SD_PLUS_LAYOUT)).toMatchObject({ type: 'option', optionIndex: 1 });

    // Absent flag ⇒ inert mirror of the terminal, never a button going nowhere.
    for (const session of [observed(false), observed(undefined)]) {
      const inert = new SessionSlotManager();
      inert.updateSessions([session]);
      inert.enterDetailView('observed:claude:abc');
      expect(inert.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({
        type: 'status', subtitle: 'answer in terminal',
      });
    }
  });
});

// Phase 2: SD+ relocates AWAITING option/permission selection AND the suggested-
// prompt quick-send onto the keypad (encoders now show usage permanently).
describe('SD+ keypad relocation (Phase 2)', () => {
  it('AWAITING permission renders selectable option buttons + ESC on the SD+ keypad', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.AWAITING_PERMISSION })]);
    manager.enterDetailView('session-1');
    manager.updateDetailState(State.AWAITING_PERMISSION, [
      { index: 0, label: 'Yes', shortcut: 'y' },
      { index: 1, label: "Yes, and don't ask again", shortcut: 'a' },
      { index: 2, label: 'No', shortcut: 'n' },
    ]);

    // Options are pressable keypad buttons that dispatch select-option.
    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({ type: 'option', optionIndex: 0 });
    expect(manager.handleSlotPress(2, SD_PLUS_LAYOUT)).toMatchObject({ action: 'select-option', optionIndex: 0 });
    expect(manager.handleSlotPress(4, SD_PLUS_LAYOUT)).toMatchObject({ action: 'select-option', optionIndex: 2 });
    // ESC remains on the last key to cancel.
    expect(manager.getSlotConfig(7, SD_PLUS_LAYOUT)).toMatchObject({ type: 'esc', label: 'active' });
    expect(manager.handleSlotPress(7, SD_PLUS_LAYOUT)).toMatchObject({ action: 'esc' });
  });

  it('shows a SUGGESTED quick-send button leading the IDLE detail content on SD+', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.IDLE })]);
    manager.enterDetailView('session-1');
    manager.updateDetailState(State.IDLE, [], undefined, undefined, undefined, 'claude-opus-4-8', undefined, undefined, 'run the test suite');

    // Leading content slot (slot 2 on SD+) = the suggested-prompt preset.
    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({
      type: 'preset',
      preset: { label: 'SUGGESTED', prompt: 'run the test suite' },
    });
    // Pressing it sends the suggestion as a prompt.
    expect(manager.handleSlotPress(2, SD_PLUS_LAYOUT)).toMatchObject({ action: 'send-prompt', promptText: 'run the test suite' });
    // The CC quick-action presets follow (shifted by one).
    expect(manager.getSlotConfig(3, SD_PLUS_LAYOUT)).toMatchObject({ type: 'preset', preset: { label: 'GO ON' } });
  });

  it('does NOT add a SUGGESTED button on classic Stream Deck (behavior unchanged)', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.IDLE })]);
    manager.enterDetailView('session-1');
    manager.updateDetailState(State.IDLE, [], undefined, undefined, undefined, 'claude-opus-4-8', undefined, undefined, 'run the test suite');

    const suggested = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT))
      .filter(c => c.type === 'preset' && c.preset?.label === 'SUGGESTED');
    expect(suggested).toHaveLength(0);
    // Classic IDLE detail still leads with the CC quick-action presets.
    const firstContent = manager.getSlotConfig(2, SD_CLASSIC_LAYOUT);
    expect(firstContent).toMatchObject({ type: 'preset', preset: { label: 'GO ON' } });
  });

  it('drops the SUGGESTED button when the session leaves IDLE', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([makeSession({ state: State.IDLE })]);
    manager.enterDetailView('session-1');
    manager.updateDetailState(State.IDLE, [], undefined, undefined, undefined, 'm', undefined, undefined, 'do the thing');
    expect(manager.getSlotConfig(2, SD_PLUS_LAYOUT)).toMatchObject({ preset: { label: 'SUGGESTED' } });

    // A PROCESSING update with a stale suggestion must not surface the button.
    manager.updateDetailState(State.PROCESSING, [], 'Edit', 'x.ts', undefined, 'm', undefined, undefined, 'do the thing');
    const suggested = [0, 1, 2, 3, 4, 5, 6, 7]
      .map(i => manager.getSlotConfig(i, SD_PLUS_LAYOUT))
      .filter(c => c.type === 'preset' && c.preset?.label === 'SUGGESTED');
    expect(suggested).toHaveLength(0);
  });
});

describe('SessionSlotManager list-view usage tiles', () => {
  const fewSessions = (n: number) =>
    Array.from({ length: n }, (_, i) => makeSession({ id: `s${i}`, port: 9121 + i, projectName: `p${i}` }));

  const CODEX_LIMITS = {
    primary: { usedPercent: 30, windowMinutes: 300, resetsAt: '2099-01-01T00:00:00Z' },
    secondary: { usedPercent: 12, windowMinutes: 10080, resetsAt: '2099-01-08T00:00:00Z' },
  };

  it('pins Claude 5H/7D to the last two keys of a classic Stream Deck (no Codex)', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 42, sevenDayPercent: 17 });
    manager.updateSessions(fewSessions(3));

    expect(manager.getSlotConfig(14, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'usage', usageLabel: '7D', usagePercent: 17, usageKnown: true, usageAgent: 'claude', usageWindow: '7d' });
    expect(manager.getSlotConfig(13, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'usage', usageLabel: '5H', usagePercent: 42, usageKnown: true, usageAgent: 'claude', usageWindow: '5h' });
    // Sessions fill the front keys.
    expect(manager.getSlotConfig(0, SD_CLASSIC_LAYOUT).type).toBe('session');
  });

  it('reserves 4 keys (Claude 5h/7d + Codex 5h/7d), left-aligned, when both agents report quota', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({
      fiveHourPercent: 42,
      fiveHourResetsAt: '2099-01-01T00:00:00Z',
      sevenDayPercent: 17,
      sevenDayResetsAt: '2099-01-02T00:00:00Z',
      codexRateLimits: CODEX_LIMITS,
    });
    manager.updateSessions(fewSessions(3));

    // Block is the last 4 keys: 11=C5h, 12=C7d, 13=CX5h, 14=CX7d.
    expect(manager.getSlotConfig(11, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'usage', usageLabel: '5H', usageAgent: 'claude', usageWindow: '5h', usagePercent: 42 });
    expect(manager.getSlotConfig(12, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'usage', usageLabel: '7D', usageAgent: 'claude', usageWindow: '7d', usagePercent: 17 });
    // Codex windows use the same short labels — agent rides usageAgent/brand dot.
    expect(manager.getSlotConfig(13, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'usage', usageLabel: '5H', usageAgent: 'codex', usageWindow: '5h', usagePercent: 30 });
    expect(manager.getSlotConfig(14, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'usage', usageLabel: '7D', usageAgent: 'codex', usageWindow: '7d', usagePercent: 12 });
    // Sessions still fill the front keys (before the reserved block).
    expect(manager.getSlotConfig(0, SD_CLASSIC_LAYOUT).type).toBe('session');
  });

  it('hides Codex tiles when only Claude reports quota (reserve 2, not 4)', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 42, sevenDayPercent: 17 });
    manager.updateSessions(fewSessions(3));

    const types = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT).type);
    expect(types.filter((t) => t === 'usage')).toHaveLength(2);
    // No Codex tiles anywhere (agent identity rides usageAgent, not a label).
    const agents = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT).usageAgent);
    expect(agents.some((a) => a === 'codex')).toBe(false);
  });

  it('hides Claude tiles when only Codex reports quota (reserve 2 Codex tiles)', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ codexRateLimits: CODEX_LIMITS });
    manager.updateSessions(fewSessions(3));

    expect(manager.getSlotConfig(13, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'usage', usageLabel: '5H', usageAgent: 'codex' });
    expect(manager.getSlotConfig(14, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'usage', usageLabel: '7D', usageAgent: 'codex' });
    const types = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT).type);
    expect(types.filter((t) => t === 'usage')).toHaveLength(2);
  });

  it('does NOT reserve usage on Stream Deck+ (encoder carries usage)', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 42, sevenDayPercent: 17, codexRateLimits: CODEX_LIMITS });
    manager.updateSessions(fewSessions(3));

    for (let slot = 0; slot < 8; slot++) {
      expect(manager.getSlotConfig(slot, SD_PLUS_LAYOUT).type).not.toBe('usage');
    }
  });

  it('does NOT reserve usage on the Stream Deck + XL (6 dials carry usage)', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 42, sevenDayPercent: 17, codexRateLimits: CODEX_LIMITS });
    manager.updateSessions(fewSessions(3));

    // All 36 keys stay session/status — none pinned to usage (it lives on the dials).
    for (let slot = 0; slot < SD_PLUS_XL_LAYOUT.keyCount; slot++) {
      expect(manager.getSlotConfig(slot, SD_PLUS_XL_LAYOUT).type).not.toBe('usage');
    }
  });

  it('pins usage to the last keys of the Stream Deck XL (no encoder, 32 keys)', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 42, sevenDayPercent: 17, codexRateLimits: CODEX_LIMITS });
    manager.updateSessions(fewSessions(3));

    // Same keypad-usage path as the classic deck, scaled to 32 keys: the reserved
    // block is the last 4 keys (Claude 5h/7d + Codex 5h/7d).
    expect(manager.getSlotConfig(28, SD_XL_LAYOUT)).toMatchObject({ type: 'usage', usageAgent: 'claude', usageWindow: '5h' });
    expect(manager.getSlotConfig(31, SD_XL_LAYOUT)).toMatchObject({ type: 'usage', usageAgent: 'codex', usageWindow: '7d' });
    expect(manager.getSlotConfig(0, SD_XL_LAYOUT).type).toBe('session');
  });

  it('isPlusFamily covers both dial-bearing families but not the plain XL', () => {
    expect(isPlusFamily('streamdeckplus')).toBe(true);
    expect(isPlusFamily('streamdeckplusxl')).toBe(true);
    expect(isPlusFamily('streamdeckxl')).toBe(false);
    expect(isPlusFamily('streamdeck')).toBe(false);
    expect(isPlusFamily(undefined)).toBe(false);
  });

  it('reserves NO usage keys when no quota was fed (hide-if-absent)', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions(fewSessions(1));
    const types = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT).type);
    expect(types.filter((t) => t === 'usage')).toHaveLength(0);
  });

  it('drops Claude tiles when its quota goes stale (hide-if-absent on stale)', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 42, sevenDayPercent: 17 });
    manager.updateSessions(fewSessions(3));
    expect(manager.getSlotConfig(13, SD_CLASSIC_LAYOUT).type).toBe('usage');

    manager.updateUsage({ fiveHourPercent: 42, sevenDayPercent: 17, usageStale: true });
    const types = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT).type);
    expect(types.filter((t) => t === 'usage')).toHaveLength(0);
  });

  it('fits 13 sessions on a classic deck without paging (15 keys − 2 usage)', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 1, sevenDayPercent: 2 });
    manager.updateSessions(fewSessions(13));

    const types = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT).type);
    expect(types.filter((t) => t === 'session')).toHaveLength(13);
    expect(types.filter((t) => t === 'next-page')).toHaveLength(0);
    expect(types.filter((t) => t === 'usage')).toHaveLength(2);
  });

  it('paginates over capacity: NEXT→ at slot 12, usage at 13/14', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 1, sevenDayPercent: 2 });
    manager.updateSessions(fewSessions(15)); // > 13 cap → 12/page + NEXT

    expect(manager.getSlotConfig(12, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'next-page', label: '1/2' });
    expect(manager.getSlotConfig(13, SD_CLASSIC_LAYOUT).type).toBe('usage');
    expect(manager.getSlotConfig(14, SD_CLASSIC_LAYOUT).type).toBe('usage');
    const sessionCount = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT).type)
      .filter((t) => t === 'session').length;
    expect(sessionCount).toBe(12);
  });

  it('repositions NEXT→ ahead of a 4-key usage block when paginating', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 1, sevenDayPercent: 2, codexRateLimits: CODEX_LIMITS });
    manager.updateSessions(fewSessions(15)); // > (15 − 4) cap → paginate

    // NEXT→ sits just before the reserved block: keyCount(15) − 1 − reserve(4) = 10.
    expect(manager.getSlotConfig(10, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'next-page' });
    for (const s of [11, 12, 13, 14]) {
      expect(manager.getSlotConfig(s, SD_CLASSIC_LAYOUT).type).toBe('usage');
    }
    const sessionCount = Array.from({ length: 15 }, (_, i) => manager.getSlotConfig(i, SD_CLASSIC_LAYOUT).type)
      .filter((t) => t === 'session').length;
    expect(sessionCount).toBe(10); // cap(11) − 1 NEXT key
  });

  it('pressing a usage tile resolves to refresh-usage', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 5, sevenDayPercent: 6 });
    manager.updateSessions(fewSessions(2));
    expect(manager.handleSlotPress(14, SD_CLASSIC_LAYOUT)).toEqual({ action: 'refresh-usage' });
  });

  it('shows usage tiles even with zero sessions', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage({ fiveHourPercent: 5, sevenDayPercent: 6 });
    manager.updateSessions([]);
    expect(manager.getSlotConfig(13, SD_CLASSIC_LAYOUT).type).toBe('usage');
    expect(manager.getSlotConfig(14, SD_CLASSIC_LAYOUT).type).toBe('usage');
    // Status cards still render on the front keys.
    expect(manager.getSlotConfig(0, SD_CLASSIC_LAYOUT)).toMatchObject({ type: 'status', label: 'HUB READY' });
  });
});

describe('VOICE hold-to-talk key', () => {
  const allSlots = (mgr: SessionSlotManager, layout: DeckLayout) =>
    Array.from({ length: layout.keyCount }, (_, i) => mgr.getSlotConfig(i, layout));

  function idleDetailManager(): SessionSlotManager {
    const mgr = new SessionSlotManager();
    mgr.updateSessions([makeSession({})]);
    mgr.enterDetailView('session-1');
    mgr.updateDetailState(State.IDLE, []);
    return mgr;
  }

  it('renders VOICE after the CC idle presets and maps its press to voice-ptt-begin', () => {
    const mgr = idleDetailManager();
    const configs = allSlots(mgr, SD_PLUS_LAYOUT);
    const voiceSlot = configs.findIndex(c => c.type === 'preset' && c.preset?.localAction === 'voice_ptt');
    expect(voiceSlot).toBeGreaterThanOrEqual(0);
    expect(configs[voiceSlot].preset).toMatchObject({ label: 'VOICE', subtitle: 'hold to talk' });

    const press = mgr.handleSlotPress(voiceSlot, SD_PLUS_LAYOUT);
    expect(press).toMatchObject({ action: 'voice-ptt-begin', sessionId: 'session-1' });
  });

  it('keeps localAction on materialized CC presets so REVIEW presses dispatch', () => {
    const mgr = idleDetailManager();
    const review = allSlots(mgr, SD_PLUS_LAYOUT)
      .find(c => c.type === 'preset' && c.preset?.label === 'REVIEW');
    expect(review?.preset?.localAction).toBe('review_run');
  });

  it('restyles the VOICE key from daemon voice_state transitions', () => {
    const mgr = idleDetailManager();
    expect(mgr.updateVoiceState('recording')).toBe(true);
    expect(mgr.updateVoiceState('recording')).toBe(false); // no repaint on no-op
    const voice = allSlots(mgr, SD_PLUS_LAYOUT)
      .find(c => c.type === 'preset' && c.preset?.localAction === 'voice_ptt');
    expect(voice?.preset?.subtitle).toBe('● listening');
  });

  it('offers VOICE on observed Claude idle next to REVIEW (terminal-injection delivery)', () => {
    const mgr = new SessionSlotManager();
    mgr.updateSessions([makeSession({
      id: 'observed:claude:abc',
      controlMode: 'observed',
      state: State.IDLE,
    })]);
    mgr.enterDetailView('observed:claude:abc');
    const configs = allSlots(mgr, SD_PLUS_LAYOUT);
    const voice = configs.find(c => c.type === 'preset' && c.preset?.localAction === 'voice_ptt');
    expect(voice?.preset?.label).toBe('VOICE');
    // The honest "control in terminal" tile survives the insertion.
    expect(configs.some(c => c.type === 'status' && c.label === 'OBSERVED')).toBe(true);
  });
});

describe('SessionSlotManager detail cache ownership', () => {
  // The 2026-07-17 guards stop a *foreign* event from being applied to the
  // focused session. They cannot help when the field was cached while another
  // session was focused and no event ever arrives for the new one — an idle or
  // mid-turn session emits nothing. That combination is what put OpenClaw's
  // GLM model on a Claude session's detail.
  const OPENCLAW = makeSession({
    id: 'openclaw-gateway', agentType: 'openclaw',
    projectName: 'OpenClaw', modelName: 'GLM-5.2 (1M)', effortLevel: undefined,
  });
  const CLAUDE = makeSession({
    id: 'claude-1', agentType: 'claude-code',
    projectName: 'AgentDeck', modelName: 'claude-opus-5', state: State.PROCESSING,
  });

  function managerWithBothSessions(): SessionSlotManager {
    const manager = new SessionSlotManager();
    manager.updateSessions([CLAUDE, OPENCLAW]);
    return manager;
  }

  it('does not carry the previous session model into the next detail view', () => {
    const manager = managerWithBothSessions();
    manager.enterDetailView('openclaw-gateway');
    manager.updateDetailState(State.IDLE, [], undefined, undefined, undefined, 'GLM-5.2 (1M)');
    expect(manager.detailModelName).toBe('GLM-5.2 (1M)');

    // Straight to another session's detail, with no state_update in between.
    manager.exitDetailView();
    manager.enterDetailView('claude-1');

    expect(manager.detailModelName).toBe('claude-opus-5');
  });

  it('seeds the detail readout from the session row rather than blanking it', () => {
    const manager = managerWithBothSessions();
    manager.enterDetailView('claude-1');

    // INFO renders manager.detailState directly, so a cleared cache would show
    // DISCONNECTED for a live session.
    expect(manager.detailState).toBe(State.PROCESSING);
    expect(manager.detailEffortLevel).toBe('high');
  });

  it('drops the cached model when re-entering a session that has none', () => {
    const manager = new SessionSlotManager();
    manager.updateSessions([
      OPENCLAW,
      makeSession({ id: 'unknown-1', modelName: undefined, effortLevel: undefined }),
    ]);
    manager.enterDetailView('openclaw-gateway');
    manager.updateDetailState(State.IDLE, [], undefined, undefined, undefined, 'GLM-5.2 (1M)');
    manager.enterDetailView('unknown-1');

    expect(manager.detailModelName).toBeUndefined();
  });
});
