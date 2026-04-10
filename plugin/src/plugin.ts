import streamDeck from '@elgato/streamdeck';
import {
  StateUpdateEvent,
  PromptOptionsEvent,
  UsageEvent,
  ConnectionEvent,
  UserPromptEvent,
  VoiceStateEvent,
  State,
  PermissionMode,
  OPENCLAW_CAPABILITIES,
  OPENCODE_CAPABILITIES,
  CODEX_CLI_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES,
  OPENCLAW_GATEWAY_PORT,
  type AgentType,
  type BillingType,
  type DeckSlotConfig,
  type DeckSlotMapEvent,
  type VoiceAssistantStateEvent,
  type VoiceAssistantState,
  type SessionInfo,
} from '@agentdeck/shared';

import { ConnectionManager } from './connection-manager.js';
import { updateUsageModeData, setUsageRefreshCallback } from './utility-modes/usage.js';
import { updatePermissionModeData, setPermissionModeSwitchCallback } from './utility-modes/permission-mode.js';
import {
  isEncoderTakeoverActive,
  enterEncoderTakeover,
  exitEncoderTakeover,
} from './encoder-takeover.js';
import { setVoiceTextExitCallback } from './encoder-registry.js';
import { dlog, dinfo } from './log.js';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';

// Encoder actions
import {
  ResponseDialAction,
  initOptionDial,
  updateOptionDialState,
  setOptionSetupRequired,
} from './actions/option-dial.js';
import {
  VoiceDialAction,
  initVoiceDial,
  updateVoiceDialState,
  setVoiceRecordingState,
  setVoiceTranscription,
  setVoiceError,
  updateVoiceAssistantIndicator,
} from './actions/voice-dial.js';
import {
  UtilityDialAction,
  initUtilityDial,
  updateUtilityDialState,
  setUtilitySetupRequired,
} from './actions/utility-dial.js';
import {
  UsageDialAction,
  initUsageDial,
  updateUsageDialData,
  updateUsageDialState,
} from './actions/iterm-dial.js';
import {
  SessionSlotButtonAction,
  initSessionSlots,
  updateSessionSlotSessions,
  setActiveSession,
  updateDetailViewState,
  exitDetailView,
  isInDetailView,
  getSessionSlotManager,
  getFocusedSession,
  setDaemonConnected,
} from './actions/session-slot-button.js';
import { timelineStore } from './timeline-store.js';

// ---- Setup detection ----
let setupRequired = false;

function detectSetupState(): void {
  const bridgeEverStarted = existsSync(`${homedir()}/.agentdeck/`);
  let sdcInPath = false;
  try {
    execSync('which agentdeck', { stdio: 'ignore', timeout: 3000 });
    sdcInPath = true;
  } catch { /* not found */ }
  setupRequired = !bridgeEverStarted && !sdcInPath;
  dinfo('Plugin', `detectSetupState: bridgeEverStarted=${bridgeEverStarted} agentdeckInPath=${sdcInPath} setupRequired=${setupRequired}`);
}

function propagateSetupRequired(value: boolean): void {
  setupRequired = value;
  setUtilitySetupRequired(value);
  setOptionSetupRequired(value);
}

// ---- Shared state ----
let currentState = State.DISCONNECTED;
let currentMode = PermissionMode.DEFAULT;
let currentTool: string | undefined;
let currentToolInput: string | undefined;
let currentProjectName: string | undefined;
let currentModelName: string | undefined;
let currentEffortLevel: string | undefined;
let currentBillingType: BillingType = 'unknown';
let currentOptions: import('@agentdeck/shared').PromptOption[] = [];
let currentQuestion: string | undefined;
let currentNavigable = false;
let currentCursorIndex = 0;
let currentSuggestedPrompt: string | undefined;
let currentSessionStatus: Record<string, unknown> | null = null;
let takeoverGeneration = 0;
let proxiedAgentType: AgentType | null = null;
let currentVoiceAssistantState: VoiceAssistantState = 'disabled';
let currentGatewayHasError = false;

/** Resolve capabilities for the current proxied agent type */
function capsForProxiedAgent(): import('@agentdeck/shared').AgentCapabilities {
  if (proxiedAgentType === 'openclaw') return OPENCLAW_CAPABILITIES;
  if (proxiedAgentType === 'opencode') return OPENCODE_CAPABILITIES;
  if (proxiedAgentType === 'codex-cli') return CODEX_CLI_CAPABILITIES;
  return connMgr.getCapabilities() ?? CLAUDE_CODE_CAPABILITIES;
}

// ---- Instances ----
const connMgr = new ConnectionManager();

// ---- Initialize action modules ----
initOptionDial(connMgr);
initVoiceDial(connMgr);
initUtilityDial();
initUsageDial(connMgr);

// ---- Initialize v4 utility mode callbacks ----
setUsageRefreshCallback(() => {
  connMgr.send({ type: 'query_usage' });
});
setPermissionModeSwitchCallback(() => {
  connMgr.send({ type: 'switch_mode' });
});

// ---- Initialize v4 session slot buttons ----
initSessionSlots((result) => {
  dlog('Plugin', `sessionSlot action: ${result.action} session=${result.sessionId ?? '-'} port=${result.sessionPort ?? '-'}`);

  switch (result.action) {
    case 'enter-detail': {
      if (!result.sessionId) break;
      const mgr = getSessionSlotManager();
      mgr.enterDetailView(result.sessionId);

      // Tell daemon to focus this session (daemon relays its state)
      const session = mgr.getFocusedSession();
      if (session?.agentType === 'openclaw') {
        connMgr.switchToOpenClaw();
      } else {
        connMgr.focusSession(result.sessionId);
      }

      // Update detail view with current state (will be refreshed on state_update)
      updateDetailViewState(currentState, currentOptions, currentTool, currentToolInput, currentQuestion, currentModelName, currentMode as string);
      broadcastStateUpdate();  // refresh encoders (timeline ↔ normal)
      break;
    }

    case 'exit-detail':
      exitDetailView();
      broadcastStateUpdate();  // refresh encoders (timeline ↔ normal)
      break;

    case 'select-option':
      if (result.optionIndex != null) {
        connMgr.send({ type: 'select_option', index: result.optionIndex });
      }
      break;

    case 'send-prompt':
      if (result.promptText) {
        connMgr.send({ type: 'send_prompt', text: result.promptText });
      }
      break;

    case 'open-gateway':
      import('./utility-modes/macos.js').then(({ openOrFocusBrowserTab }) => {
        void openOrFocusBrowserTab(`http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`).catch(() => {});
      });
      break;

    case 'switch-model': {
      const mgr = getSessionSlotManager();
      mgr.startModelSwitch();
      connMgr.send({ type: 'send_prompt', text: '/model' });
      // Refresh to show loading state immediately
      if (isInDetailView()) {
        updateDetailViewState(currentState, currentOptions, currentTool, currentToolInput, currentQuestion, currentModelName, currentMode as string);
      }
      break;
    }

    case 'stop':
      connMgr.send({ type: 'interrupt' });
      break;

    case 'esc':
      connMgr.send({ type: 'escape' });
      break;
  }
});

// Refresh other dials when voice text takeover exits
setVoiceTextExitCallback(() => {
  const agentType = proxiedAgentType;
  const vtCaps = capsForProxiedAgent();
  updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus, vtCaps);
  updateUtilityDialState(currentState);
  updateUsageDialState(currentState, agentType, currentSessionStatus, vtCaps);
});

// ---- Bridge event handlers ----

connMgr.on('state_update', (ev: StateUpdateEvent) => {
  dlog('Plugin', `state_update: ${ev.state} mode=${ev.permissionMode} tool=${ev.currentTool || '-'} project=${ev.projectName || '-'} opts=${ev.options?.length ?? '-'} nav=${ev.navigable ?? '-'}`);

  // Auto-resolve setup state on first bridge connection
  if (setupRequired) {
    propagateSetupRequired(false);
  }

  currentState = ev.state;
  currentMode = ev.permissionMode;
  updatePermissionModeData(ev.permissionMode); // v4: feed to E1 utility mode
  currentTool = ev.currentTool;
  currentToolInput = ev.toolInput;
  if (ev.projectName) currentProjectName = ev.projectName;
  if (ev.modelName) currentModelName = ev.modelName;
  if (ev.effortLevel !== undefined) currentEffortLevel = ev.effortLevel;
  if (ev.billingType) currentBillingType = ev.billingType;
  if (ev.gatewayAvailable !== undefined) {
    connMgr.setBridgeGatewayAvailable(ev.gatewayAvailable);
  }
  if (ev.gatewayHasError !== undefined) {
    currentGatewayHasError = ev.gatewayHasError;
  }

  // Track proxied agent type from daemon (state_update.agentType overrides connection-level detection)
  if (ev.agentType === 'openclaw' || ev.agentType === 'claude-code' || ev.agentType === 'codex-cli' || ev.agentType === 'opencode') {
    proxiedAgentType = ev.agentType;
  }

  // Capture question from state_update
  if (ev.question !== undefined) {
    currentQuestion = ev.question;
  }

  // Capture navigable/cursorIndex
  if (ev.navigable !== undefined) {
    currentNavigable = ev.navigable;
  }
  if (ev.cursorIndex !== undefined) {
    currentCursorIndex = ev.cursorIndex;
  }

  // Capture suggested prompt
  if (ev.suggestedPrompt !== undefined) {
    currentSuggestedPrompt = ev.suggestedPrompt;
  }
  // Capture session status (OpenClaw)
  if (ev.sessionStatus !== undefined) {
    currentSessionStatus = ev.sessionStatus;
  }
  // Voice assistant state piggybacked on state_update
  if (ev.voiceAssistantState !== undefined) {
    currentVoiceAssistantState = ev.voiceAssistantState;
    updateVoiceAssistantIndicator(ev.voiceAssistantState, ev.voiceAssistantText);
  }

  // Clear suggestion on non-IDLE states
  if (ev.state !== State.IDLE) {
    currentSuggestedPrompt = undefined;
  }

  // Use options from state_update atomically (avoids race with separate prompt_options)
  if (ev.options && ev.options.length > 0) {
    currentOptions = ev.options;
  } else if (
    ev.state !== State.AWAITING_OPTION &&
    ev.state !== State.AWAITING_PERMISSION &&
    ev.state !== State.AWAITING_DIFF
  ) {
    currentOptions = [];
    currentQuestion = undefined;
    currentNavigable = false;
    currentCursorIndex = 0;
    currentToolInput = undefined;
  }

  // v4: Update detail view state if in detail mode
  if (isInDetailView()) {
    updateDetailViewState(currentState, currentOptions, currentTool, currentToolInput, currentQuestion, currentModelName, currentMode as string);
  }

  broadcastStateUpdate();
});

connMgr.on('prompt_options', (ev: PromptOptionsEvent) => {
  dlog('Plugin', `prompt_options: type=${ev.promptType} count=${ev.options.length} q=${ev.question ? `"${ev.question.slice(0, 40)}"` : '-'}`);
  currentOptions = ev.options;
  if (ev.question) currentQuestion = ev.question;
  if (isInDetailView()) {
    updateDetailViewState(currentState, currentOptions, currentTool, currentToolInput, currentQuestion, currentModelName, currentMode as string);
  }
  broadcastStateUpdate();
});

connMgr.on('usage_update', (ev: UsageEvent) => {
  dlog('Plugin', `usage_update: 5h=${ev.fiveHourPercent ?? '-'}% 7d=${ev.sevenDayPercent ?? '-'}% extra=${ev.extraUsageEnabled ? 'on' : 'off'} tokens=${ev.inputTokens + ev.outputTokens}`);

  // Feed usage data to shared store + dedicated E3 Usage Dial
  const usageData = {
    fiveHourPercent: ev.fiveHourPercent,
    fiveHourResetsAt: ev.fiveHourResetsAt,
    sevenDayPercent: ev.sevenDayPercent,
    sevenDayResetsAt: ev.sevenDayResetsAt,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    estimatedCostUsd: ev.estimatedCostUsd,
    sessionDurationSec: ev.sessionDurationSec,
    extraUsageEnabled: ev.extraUsageEnabled,
    extraUsageUtilization: ev.extraUsageUtilization,
    extraUsageMonthlyLimit: ev.extraUsageMonthlyLimit,
    extraUsageUsedCredits: ev.extraUsageUsedCredits,
    subscriptions: ev.subscriptions,
  };
  updateUsageModeData(usageData);
  updateUsageDialData(usageData);
});

connMgr.on('connection', (ev: ConnectionEvent) => {
  dinfo('Plugin', `connection: ${ev.status}`);
  if (ev.status === 'disconnected') {
    currentState = State.DISCONNECTED;
    currentOptions = [];
    currentQuestion = undefined;
    currentNavigable = false;
    currentCursorIndex = 0;
    currentToolInput = undefined;
    currentSuggestedPrompt = undefined;
    broadcastStateUpdate();
  }
  // 'connected' case: state_update (sent before connection event) already
  // set the correct state — don't clobber it to IDLE here.
});

// ---- v4 Session Slot: sessions_list → slot assignment ----
connMgr.on('sessions_list', (ev: { type: 'sessions_list'; sessions: SessionInfo[] }) => {
  dlog('Plugin', `sessions_list: ${ev.sessions.length} sessions`);
  updateSessionSlotSessions(ev.sessions, connMgr.isGatewayAvailable());
});

connMgr.on('user_prompt', (ev: UserPromptEvent) => {
  dlog('Plugin', `user_prompt: "${ev.text.slice(0, 60)}"`);
});

connMgr.on('voice_state', (ev: VoiceStateEvent) => {
  dlog('Plugin', `voice_state: ${ev.state} text=${ev.text ? `"${ev.text.slice(0, 40)}"` : '-'} err=${ev.error || '-'}`);
  if (ev.state === 'error') {
    setVoiceError(ev.error);
  } else {
    const vs = ev.state === 'recording' ? 'recording'
      : ev.state === 'transcribing' ? 'transcribing'
      : 'idle';
    setVoiceRecordingState(vs);
  }
  // Show transcribed text on voice dial LCD
  if (ev.state === 'idle' && ev.text) {
    setVoiceTranscription(ev.text);
  }
});

connMgr.on('voice_assistant_state', (ev: VoiceAssistantStateEvent) => {
  dlog('Plugin', `voice_assistant_state: ${ev.state} text=${ev.text ? `"${ev.text.slice(0, 40)}"` : '-'}`);
  currentVoiceAssistantState = ev.state;
  updateVoiceAssistantIndicator(ev.state, ev.text);
  broadcastStateUpdate();
});

connMgr.on('timeline_event', (ev: { type: 'timeline_event'; entry: import('@agentdeck/shared').TimelineEntry; upsert?: boolean }) => {
  dlog('Plugin', `timeline_event from bridge: ${ev.entry.type} "${ev.entry.raw.slice(0, 60)}"${ev.upsert ? ' (upsert)' : ''}`);
  if (ev.upsert) {
    // Find existing entry with same type and ts within 1s tolerance
    const idx = timelineStore.findLastIndex(ev.entry.type);
    if (idx >= 0) {
      timelineStore.updateEntryRaw(idx, ev.entry.raw);
    } else {
      timelineStore.addEntry(ev.entry);
    }
  } else {
    timelineStore.addEntry(ev.entry);
  }
});

connMgr.on('timeline_history', (ev: { type: 'timeline_history'; entries: import('@agentdeck/shared').TimelineEntry[] }) => {
  dlog('Plugin', `timeline_history from bridge: ${ev.entries.length} entries`);
  timelineStore.mergeHistory(ev.entries);
});

// ---- Display sleep/wake dimming ----
let displayDimmed = false;

const BLACK_BUTTON_SVG = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#000"/></svg>'
);
const BLACK_LCD_SVG = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#000"/></svg>'
);

function dimAllActions(): void {
  for (const [actionId, entry] of appearedActions.entries()) {
    const act = streamDeck.actions.getActionById(actionId);
    if (!act) continue;
    if (entry.controller === 'Encoder') {
      void (act as any).setFeedback({ canvas: BLACK_LCD_SVG }).catch(() => {});
    } else {
      void act.setImage(BLACK_BUTTON_SVG).catch(() => {});
    }
  }
}

connMgr.on('display_state', (ev: { type: 'display_state'; displayOn: boolean }) => {
  dinfo('Plugin', `display_state: displayOn=${ev.displayOn}`);
  if (!ev.displayOn && !displayDimmed) {
    displayDimmed = true;
    dimAllActions();
  } else if (ev.displayOn && displayDimmed) {
    displayDimmed = false;
    broadcastStateUpdate(); // Re-render everything
  }
});

connMgr.on('connected', () => {
  dinfo('Plugin', `connected (agentType=${proxiedAgentType} prevState=${currentState})`);
  setDaemonConnected(true);
  // Re-send slot map so bridge knows our layout (covers bridge-starts-after-plugin case)
  sendSlotMap();
  // Request fresh usage data immediately on connect (covers sleep/wake recovery)
  connMgr.send({ type: 'query_usage' });
});

connMgr.on('disconnected', () => {
  dinfo('Plugin', `disconnected (agentType=${proxiedAgentType} prevState=${currentState})`);
  setDaemonConnected(false);
  proxiedAgentType = null;
  currentVoiceAssistantState = 'disabled';
  updateVoiceAssistantIndicator('disabled');
  currentState = State.DISCONNECTED;
  currentOptions = [];
  currentQuestion = undefined;
  currentNavigable = false;
  currentCursorIndex = 0;
  currentToolInput = undefined;
  currentSuggestedPrompt = undefined;
  broadcastStateUpdate();
});

function isInteractiveState(state: State): boolean {
  return (
    state === State.AWAITING_PERMISSION ||
    state === State.AWAITING_OPTION ||
    state === State.AWAITING_DIFF
  );
}

function broadcastStateUpdate(): void {
  // Skip rendering while display is dimmed (Mac display asleep)
  if (displayDimmed) return;

  dlog('Plugin', `broadcast: state=${currentState} mode=${currentMode} opts=${currentOptions.length} takeover=${isEncoderTakeoverActive()}`);

  const agentType = proxiedAgentType;
  const caps = capsForProxiedAgent();

  // Encoder actions — manage takeover lifecycle
  const shouldTakeover = isInteractiveState(currentState) && currentOptions.length > 0;

  if (shouldTakeover && !isEncoderTakeoverActive()) {
    // Exit VT before encoder takeover (clears all panels atomically)
    updateVoiceDialState(currentState);
    // Enter takeover, then update option dial with full context
    const enterGen = ++takeoverGeneration;
    void enterEncoderTakeover().then(() => {
      if (enterGen !== takeoverGeneration) return; // superseded by newer transition
      updateOptionDialState(
        currentState, currentOptions, currentQuestion, currentTool,
        currentNavigable, currentCursorIndex, currentToolInput,
        currentSuggestedPrompt, agentType, currentSessionStatus, caps,
      );
    });
  } else if (!shouldTakeover && isEncoderTakeoverActive()) {
    // Exit takeover, then restore all dials
    const exitGen = ++takeoverGeneration;
    void exitEncoderTakeover().then(() => {
      if (exitGen !== takeoverGeneration) return; // superseded by newer transition
      updateVoiceDialState(currentState);
      updateUtilityDialState(currentState);
      updateUsageDialState(currentState, agentType, currentSessionStatus, caps);
    });
    updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus, caps);
  } else if (shouldTakeover) {
    // Already in takeover — just refresh
    updateOptionDialState(
      currentState, currentOptions, currentQuestion, currentTool,
      currentNavigable, currentCursorIndex, currentToolInput,
      currentSuggestedPrompt, agentType, currentSessionStatus, caps,
    );
  } else {
    // Not in takeover, not entering — normal updates
    updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus, caps);
    updateVoiceDialState(currentState);
    updateUtilityDialState(currentState);
    updateUsageDialState(currentState, agentType, currentSessionStatus, caps);
  }
}

// ---- Register actions ----
streamDeck.actions.registerAction(new ResponseDialAction());
streamDeck.actions.registerAction(new VoiceDialAction());
streamDeck.actions.registerAction(new UtilityDialAction());
streamDeck.actions.registerAction(new UsageDialAction());
streamDeck.actions.registerAction(new SessionSlotButtonAction());

// ---- Slot Map Reporting (Phase A7) ----

// UUID suffix → actionType mapping
const UUID_TO_ACTION_TYPE: Record<string, string> = {
  'session-slot': 'session-slot',
  'response-dial': 'option-dial',
  'voice-dial': 'voice-dial',
  'utility-dial': 'utility-dial',
  'iterm-dial': 'iterm-dial',
};

interface SlotEntry {
  slot: number;
  controller: 'Keypad' | 'Encoder';
  actionType: string;
  settings?: Record<string, unknown>;
}

const appearedActions = new Map<string, SlotEntry>();
let slotMapTimer: ReturnType<typeof setTimeout> | null = null;

// Global willAppear listener — tracks all actions without modifying individual action files
streamDeck.actions.onWillAppear((ev) => {
  const uuid = ev.action.manifestId;
  const suffix = uuid.replace('bound.serendipity.agentdeck.', '');
  const actionType = UUID_TO_ACTION_TYPE[suffix] || suffix;
  const payload = ev.payload as any;
  const controller = payload.controller || 'Keypad';
  const column = payload.coordinates?.column ?? 0;

  appearedActions.set(ev.action.id, {
    slot: column,
    controller,
    actionType,
    settings: payload.settings,
  });

  // Debounce: wait for all actions to appear before sending
  if (slotMapTimer) clearTimeout(slotMapTimer);
  slotMapTimer = setTimeout(sendSlotMap, 500);
});

function sendSlotMap(): void {
  const buttons: DeckSlotConfig[] = [];
  const encoders: DeckSlotConfig[] = [];

  for (const entry of appearedActions.values()) {
    const config: DeckSlotConfig = {
      slot: entry.slot,
      actionType: entry.actionType,
      settings: entry.settings,
    };
    if (entry.controller === 'Encoder') {
      encoders.push(config);
    } else {
      buttons.push(config);
    }
  }

  // Sort by slot
  buttons.sort((a, b) => a.slot - b.slot);
  encoders.sort((a, b) => a.slot - b.slot);

  const slotMap: DeckSlotMapEvent = {
    type: 'deck_slot_map',
    buttons,
    encoders,
  };

  dinfo('Plugin', `Sending slot map: ${buttons.length} buttons, ${encoders.length} encoders`);
  connMgr.send(slotMap as any);
}

// ---- Connect ----

streamDeck.connect().then(() => {
  dinfo('Plugin', 'Stream Deck connected, starting daemon-only connection');
  detectSetupState();
  if (setupRequired) {
    propagateSetupRequired(true);
    broadcastStateUpdate();
  }
  connMgr.start();

  // Auto-switch to v4 profile on SD+ devices
  for (const device of streamDeck.devices) {
    if ((device as any).type === 7) { // DeviceType 7 = Stream Deck+
      dinfo('Plugin', `SD+ device found: ${device.id}, switching to v4 profile`);
      void streamDeck.profiles.switchToProfile(device.id, 'agentdeck-v4').catch((e: Error) => {
        dlog('Plugin', `v4 profile switch failed (may already be active): ${e.message}`);
      });
    }
  }
});
