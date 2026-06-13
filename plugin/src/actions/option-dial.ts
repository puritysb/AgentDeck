import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  DialUpEvent,
  TouchTapEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import { State, PromptOption } from '@agentdeck/shared';
import type { AgentType, AgentCapabilities, OcSessionStatus } from '@agentdeck/shared';
import type { AgentLink } from '../agent-link.js';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { encoderRegistry, encoderLayout, isVoiceTextTakeoverActive, handleVtRotate, handleVtDown, handleVtUp, fireRefreshTakeover } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import {
  renderResponseIdle,
  renderResponseProcessing,
  renderResponseDisconnected,
  renderResponseDisabled,
  renderResponseInteractive,
  renderResponseSuggestion,
  renderSetupPrompt,
} from '../renderers/response-renderer.js';
import { isPickerActive, scrollPicker, selectProject, closePicker } from '../project-picker.js';
import { isInDetailView, getFocusedSession } from './session-slot-button.js';
import { timelineStore } from '../timeline-store.js';
import { renderTimeline } from '../renderers/timeline-renderer.js';
import { dlog } from '../log.js';
import { openAgentDeckAppOrGitHub } from '../utility-modes/macos.js';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';

import type { JsonValue } from '@elgato/utils';

interface ResponseDialSettings {
  [key: string]: JsonValue;
  commandList?: string;
}

const PIXMAP_LAYOUT = 'layouts/voice-layout.json';

// ---- Prompt list (IDLE mode) ----
const DEFAULT_PROMPTS = [
  'continue',
  '/review',
  '/commit',
  '/clear',
];
let prompts = [...DEFAULT_PROMPTS];
let promptIndex = 0;

// ---- Option state (interactive mode) ----
let bridge: AgentLink;
let setupRequired = false;
let currentState = State.DISCONNECTED;
let currentOptions: PromptOption[] = [];
let selectedIndex = 0;
let navigable = false;
let currentQuestion: string | undefined;
let currentTool: string | undefined;
let currentToolInput: string | undefined;
let rotateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentSuggestedPrompt: string | null = null;
let currentAgentType: AgentType | null = null;
let currentCapabilities: AgentCapabilities | null = null;
let currentSessionStatus: OcSessionStatus | null = null;
/** requestId of a gated PreToolUse permission on the focused session, when the
 *  daemon synthesizes an awaiting-permission state_update for an observed
 *  session. When set, the encoder replies with permission_decision. */
let currentRequestId: string | undefined;

/** Set the gated-permission requestId (called from plugin.ts on state_update). */
export function setOptionDialRequestId(requestId?: string): void {
  currentRequestId = requestId;
}

export function setOptionSetupRequired(value: boolean): void {
  setupRequired = value;
  refreshOptionDials();
}

export function initOptionDial(b: AgentLink): void {
  bridge = b;
  // Timeline store change → re-render left panel when in OC detail view non-interactive mode
  timelineStore.onChange(() => {
    if (isOcDetailView() && !isInteractive() && !isVoiceTextTakeoverActive() && !isEncoderTakeoverActive()) {
      renderTimelineLeftPanel();
    }
  });
}

function renderTimelineLeftPanel(): void {
  ensurePixmapLayout();
  const { panels } = renderTimeline(
    timelineStore.getGroupedDisplay(),
    timelineStore.getScrollIndex(),
    timelineStore.isDetailMode(),
    currentSessionStatus,
  );
  const feedback = { canvas: svgToDataUrl(panels[0]) };
  for (const id of encoderRegistry.optionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

export function updateOptionDialState(
  state: State,
  options: PromptOption[],
  question?: string,
  tool?: string,
  nav?: boolean,
  cursorIdx?: number,
  toolInput?: string,
  suggestedPrompt?: string,
  agentType?: AgentType | null,
  sessionStatus?: OcSessionStatus | null,
  capabilities?: AgentCapabilities | null,
): void {
  if (agentType !== undefined) currentAgentType = agentType;
  if (capabilities !== undefined) currentCapabilities = capabilities ?? null;
  if (sessionStatus !== undefined) currentSessionStatus = sessionStatus ?? null;
  const prevSuggestion = currentSuggestedPrompt;
  const prevState = currentState;
  const prevOptions = currentOptions;
  currentState = state;
  currentOptions = options;
  currentQuestion = question;
  currentTool = tool;
  currentToolInput = toolInput;
  navigable = nav ?? false;
  currentSuggestedPrompt = suggestedPrompt ?? null;

  // When suggestion arrives, reset to index 0 (show suggestion first)
  if (currentSuggestedPrompt && !prevSuggestion && state === State.IDLE) {
    promptIndex = 0;
  }
  // When suggestion disappears, adjust index (suggestion was at position 0)
  if (!currentSuggestedPrompt && prevSuggestion && state === State.IDLE) {
    promptIndex = promptIndex > 0 ? promptIndex - 1 : 0;
  }

  if (isInteractive() && options.length > 0) {
    // Sync cursor from PTY if provided, otherwise reset to 0 on new prompt
    if (cursorIdx !== undefined && cursorIdx >= 0 && cursorIdx < options.length) {
      selectedIndex = cursorIdx;
    } else if (state !== prevState || options !== prevOptions) {
      selectedIndex = 0;
    }
    dlog('ResDial', `options received: ${options.length} items, nav=${navigable}, cursor=${selectedIndex}`);
  }
  refreshOptionDials();
}

/** Get the current selected index (used by plugin.ts for takeover refresh) */
export function getSelectedIndex(): number {
  return selectedIndex;
}

function isOcDetailView(): boolean {
  if (!isInDetailView()) return false;
  const session = getFocusedSession();
  return session?.agentType === 'openclaw';
}

function isInteractive(): boolean {
  return (
    currentState === State.AWAITING_OPTION ||
    currentState === State.AWAITING_PERMISSION ||
    currentState === State.AWAITING_DIFF
  );
}

function getEffectivePrompts(): { list: string[]; hasSuggestion: boolean } {
  const basePrompts = currentCapabilities && !currentCapabilities.hasSuggestedPrompts ? ['continue'] : prompts;
  if (currentSuggestedPrompt && currentState === State.IDLE) {
    return { list: [currentSuggestedPrompt, ...basePrompts], hasSuggestion: true };
  }
  return { list: basePrompts, hasSuggestion: false };
}

function ensurePixmapLayout(): void {
  if (encoderLayout.option === PIXMAP_LAYOUT) return;
  encoderLayout.option = PIXMAP_LAYOUT;
  for (const id of encoderRegistry.optionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }
}

function setCanvasFeedback(svg: string): void {
  const feedback = { canvas: svgToDataUrl(svg) };
  for (const id of encoderRegistry.optionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

function refreshOptionDials(): void {
  // Voice text takeover: skip option dial refresh (voice-dial handles all panels)
  if (isVoiceTextTakeoverActive()) return;
  // When takeover is active, delegate to encoder-takeover for all encoders
  if (isEncoderTakeoverActive()) {
    fireRefreshTakeover(
      currentState,
      currentOptions,
      selectedIndex,
      currentQuestion,
      currentTool,
      currentToolInput,
    );
    return;
  }

  // OC detail view: show timeline when not in interactive mode
  if (isOcDetailView() && !isInteractive()) {
    renderTimelineLeftPanel();
    return;
  }

  ensurePixmapLayout();

  let svg: string;

  if (currentState === State.AWAITING_OPTION && currentOptions.length > 0) {
    const opt = currentOptions[selectedIndex];
    svg = renderResponseInteractive(
      opt?.label ?? '', selectedIndex, currentOptions.length,
      'SELECT', '#93c5fd', '#2563eb',
    );
  } else if (
    (currentState === State.AWAITING_PERMISSION || currentState === State.AWAITING_DIFF) &&
    currentOptions.length > 0
  ) {
    const opt = currentOptions[selectedIndex];
    const isDiff = currentState === State.AWAITING_DIFF;
    svg = renderResponseInteractive(
      opt?.label ?? '', selectedIndex, currentOptions.length,
      isDiff ? 'DIFF' : 'PERMIT',
      isDiff ? '#fcd34d' : '#fca5a5',
      isDiff ? '#f59e0b' : '#dc2626',
    );
  } else if (currentState === State.IDLE) {
    const { list, hasSuggestion } = getEffectivePrompts();
    const text = list[promptIndex] ?? '';
    if (hasSuggestion && promptIndex === 0) {
      svg = renderResponseSuggestion(text, promptIndex, list.length);
    } else {
      svg = renderResponseIdle(text, promptIndex, list.length);
    }
  } else if (currentState === State.PROCESSING) {
    svg = renderResponseProcessing();
  } else if (currentState === State.DISCONNECTED) {
    svg = renderOfflineTouchStrip(1);
  } else {
    svg = renderResponseDisabled();
  }

  setCanvasFeedback(svg);
}

/**
 * Request a takeover refresh (e.g. when a new encoder appears mid-takeover).
 * Called by other dials' onWillAppear when they detect takeover is active.
 */
export function requestTakeoverRefresh(): void {
  if (isEncoderTakeoverActive()) {
    refreshOptionDials();
  }
}

/**
 * Takeover delegation: any encoder can confirm the current selection.
 * Called by other dials when they receive a push during encoder takeover.
 */
export function handleTakeoverPush(): void {
  if (currentState === State.AWAITING_OPTION && currentOptions.length > 0) {
    dlog('ResDial', `takeoverPush: select_option idx=${selectedIndex} "${currentOptions[selectedIndex]?.label}"`);
    bridge.send({ type: 'select_option', index: selectedIndex });
  } else if (
    (currentState === State.AWAITING_PERMISSION || currentState === State.AWAITING_DIFF) &&
    currentOptions.length > 0
  ) {
    if (currentState === State.AWAITING_PERMISSION && currentRequestId) {
      const decision = selectedIndex === 0 ? 'allow' : 'deny';
      dlog('ResDial', `takeoverPush: permission_decision req=${currentRequestId} ${decision}`);
      bridge.send({ type: 'permission_decision', requestId: currentRequestId, decision });
      return;
    }
    if (navigable) {
      // Navigable TUI (❯ cursor): use select_option (arrow keys + Enter)
      dlog('ResDial', `takeoverPush: select_option (nav) idx=${selectedIndex} "${currentOptions[selectedIndex]?.label}"`);
      bridge.send({ type: 'select_option', index: selectedIndex });
    } else {
      const opt = currentOptions[selectedIndex];
      const shortcut = opt?.shortcut || opt?.label?.charAt(0).toLowerCase();
      if (shortcut) {
        dlog('ResDial', `takeoverPush: respond "${opt.label}" (${shortcut})`);
        bridge.send({ type: 'respond', value: shortcut });
      }
    }
  }
}

/**
 * Takeover delegation: any encoder can navigate options.
 * Called by other dials when they receive rotation during encoder takeover.
 */
export function handleTakeoverRotate(ticks: number): void {
  if (!isInteractive() || currentOptions.length === 0) return;

  const prevIndex = selectedIndex;
  if (navigable) {
    // Clamp: stop at boundaries instead of wrapping
    if (ticks > 0) {
      selectedIndex = Math.min(selectedIndex + 1, currentOptions.length - 1);
    } else {
      selectedIndex = Math.max(selectedIndex - 1, 0);
    }
  } else {
    if (ticks > 0) {
      selectedIndex = (selectedIndex + 1) % currentOptions.length;
    } else {
      selectedIndex = (selectedIndex - 1 + currentOptions.length) % currentOptions.length;
    }
  }

  if (navigable && selectedIndex !== prevIndex) {
    const dir = ticks > 0 ? 'down' : 'up';
    bridge.send({ type: 'navigate_option', direction: dir });
  }

  dlog('ResDial', `takeoverRotate: idx=${selectedIndex}/${currentOptions.length}`);
  if (rotateDebounceTimer) clearTimeout(rotateDebounceTimer);
  rotateDebounceTimer = setTimeout(() => {
    rotateDebounceTimer = null;
    refreshOptionDials();
  }, 16);
}

@action({ UUID: 'bound.serendipity.agentdeck.option-dial' })
export class ResponseDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.optionIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.optionIds.includes(ev.action.id)) {
      encoderRegistry.optionIds.push(ev.action.id);
    }
    // Load saved prompt list from settings
    const settings = (ev.payload?.settings ?? {}) as ResponseDialSettings;
    if (settings.commandList?.trim()) {
      const parsed = settings.commandList.split('\n').map((s: string) => s.trim()).filter(Boolean);
      if (parsed.length > 0) {
        prompts = parsed;
        if (promptIndex >= prompts.length) promptIndex = 0;
      }
    } else {
      const defaults: ResponseDialSettings = { commandList: DEFAULT_PROMPTS.join('\n') };
      void ev.action.setSettings(defaults).catch(() => {});
    }
    encoderLayout.option = PIXMAP_LAYOUT;
    refreshOptionDials();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ResponseDialSettings>): void {
    const list = ev.payload.settings.commandList;
    dlog('ResDial', `onDidReceiveSettings: commandList=${list}`);
    if (list?.trim()) {
      const parsed = list.split('\n').map((s: string) => s.trim()).filter(Boolean);
      if (parsed.length > 0) {
        prompts = parsed;
        if (promptIndex >= prompts.length) promptIndex = 0;
        refreshOptionDials();
      }
    }
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (currentState === State.DISCONNECTED) return;
    if (isPickerActive()) { scrollPicker(ev.payload.ticks); return; }
    if (isVoiceTextTakeoverActive()) { handleVtRotate(ev.payload.ticks); return; }

    // OC detail view non-interactive: scroll timeline
    if (isOcDetailView() && !isInteractive()) {
      timelineStore.scroll(ev.payload.ticks);
      return;
    }

    // Interactive mode: scroll options
    if (isInteractive() && currentOptions.length > 0) {
      const prevIndex = selectedIndex;
      if (navigable) {
        // Clamp: stop at boundaries instead of wrapping
        if (ev.payload.ticks > 0) {
          selectedIndex = Math.min(selectedIndex + 1, currentOptions.length - 1);
        } else {
          selectedIndex = Math.max(selectedIndex - 1, 0);
        }
      } else {
        if (ev.payload.ticks > 0) {
          selectedIndex = (selectedIndex + 1) % currentOptions.length;
        } else {
          selectedIndex = (selectedIndex - 1 + currentOptions.length) % currentOptions.length;
        }
      }
      if (navigable && selectedIndex !== prevIndex) {
        const dir = ev.payload.ticks > 0 ? 'down' : 'up';
        bridge.send({ type: 'navigate_option', direction: dir });
      }
      dlog('ResDial', `rotate options: idx=${selectedIndex}/${currentOptions.length}`);
      if (rotateDebounceTimer) clearTimeout(rotateDebounceTimer);
      rotateDebounceTimer = setTimeout(() => {
        rotateDebounceTimer = null;
        refreshOptionDials();
      }, 16);
      return;
    }

    // IDLE mode: cycle prompts (including suggestion if present)
    if (currentState === State.IDLE) {
      const { list } = getEffectivePrompts();
      if (ev.payload.ticks > 0) {
        promptIndex = (promptIndex + 1) % list.length;
      } else {
        promptIndex = (promptIndex - 1 + list.length) % list.length;
      }
      dlog('ResDial', `rotate prompt: ${list[promptIndex]}`);
      refreshOptionDials();
    }
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (currentState === State.DISCONNECTED) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    if (isPickerActive()) { void selectProject(); return; }
    if (isVoiceTextTakeoverActive()) { handleVtDown(); return; }
    // OC detail view non-interactive: toggle detail view
    if (isOcDetailView() && !isInteractive()) {
      timelineStore.toggleDetail();
      return;
    }
    if (currentState === State.AWAITING_OPTION && currentOptions.length > 0) {
      dlog('ResDial', `push: select_option idx=${selectedIndex} "${currentOptions[selectedIndex]?.label}"`);
      bridge.send({ type: 'select_option', index: selectedIndex });
    } else if (
      (currentState === State.AWAITING_PERMISSION || currentState === State.AWAITING_DIFF) &&
      currentOptions.length > 0
    ) {
      // Device approval for a gated PreToolUse (observed session): reply with
      // permission_decision instead of select_option/respond — there's no PTY.
      // index 0 = Allow, anything else = Deny (matches synthesized options).
      if (currentState === State.AWAITING_PERMISSION && currentRequestId) {
        const decision = selectedIndex === 0 ? 'allow' : 'deny';
        dlog('ResDial', `push: permission_decision req=${currentRequestId} ${decision}`);
        bridge.send({ type: 'permission_decision', requestId: currentRequestId, decision });
        return;
      }
      if (navigable) {
        // Navigable TUI (❯ cursor): use select_option (arrow keys + Enter)
        dlog('ResDial', `push: select_option (nav) idx=${selectedIndex} "${currentOptions[selectedIndex]?.label}"`);
        bridge.send({ type: 'select_option', index: selectedIndex });
      } else {
        const opt = currentOptions[selectedIndex];
        const shortcut = opt?.shortcut || opt?.label?.charAt(0).toLowerCase();
        if (shortcut) {
          dlog('ResDial', `push: respond "${opt.label}" (${shortcut})`);
          bridge.send({ type: 'respond', value: shortcut });
        }
      }
    } else if (currentState === State.IDLE && bridge) {
      const { list } = getEffectivePrompts();
      const cmd = list[promptIndex];
      dlog('ResDial', `push: send_prompt "${cmd}"`);
      bridge.send({ type: 'send_prompt', text: cmd });
    }
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
    if (isVoiceTextTakeoverActive()) { handleVtUp(); return; }
  }

  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (currentState === State.DISCONNECTED) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    if (isVoiceTextTakeoverActive()) { handleVtDown(); return; }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.optionIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.optionIds.splice(idx, 1);
    }
  }
}
