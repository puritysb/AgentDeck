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
import { pushApmeEval, type ApmeEvalEntry } from './utility-modes/apme.js';
import { updateTowerSessions } from './utility-modes/tower.js';
import { setVoiceTextExitCallback, setEncoderDaemonConnected } from './encoder-registry.js';
import { dlog, dinfo } from './log.js';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';

// Encoder actions
import {
  ResponseDialAction,
  initOptionDial,
  updateClaudeUsageDial,
  refreshClaudeUsageDial,
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
  setDaemonStale,
  updateSlotUsage,
} from './actions/session-slot-button.js';
import { timelineStore } from './timeline-store.js';
import { FocusedDetailState, type FocusedDetailSnapshot } from './focused-detail-state.js';

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
let proxiedAgentType: AgentType | null = null;
let currentVoiceAssistantState: VoiceAssistantState = 'disabled';
let currentGatewayHasError = false;

const focusedDetailState = new FocusedDetailState();

function renderFocusedDetail(snapshot: FocusedDetailSnapshot): void {
  updateDetailViewState(
    snapshot.state,
    snapshot.options,
    snapshot.tool,
    snapshot.toolInput,
    snapshot.question,
    snapshot.modelName,
    snapshot.mode,
    snapshot.effortLevel,
    snapshot.suggestedPrompt,
  );
}

function primeDetailViewFromSession(session?: SessionInfo): void {
  if (!session) {
    focusedDetailState.clear();
    return;
  }
  renderFocusedDetail(focusedDetailState.prime(session));
}

function sendFocusedSessionCommand(command: { type: string; [key: string]: unknown }): void {
  const focused = getFocusedSession();
  // Wrap in session_command for any session the daemon can route: managed
  // bridges (port > 0) get PTY delivery; observed sessions get the daemon's
  // hook-steering primitives (soft STOP / turn-end queue / gate resolution).
  // The old code excluded observed here, which made their buttons fall through
  // to a bare daemon command that was silently dropped.
  if (
    focused &&
    focused.agentType !== 'openclaw' &&
    (focused.port > 0 || focused.controlMode === 'observed')
  ) {
    connMgr.send({ type: 'session_command', sessionId: focused.id, command } as any);
    return;
  }
  connMgr.send(command as any);
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

      // Prime with the selected session's own list-state. The focused
      // session relay will replace this with full tool/options shortly.
      primeDetailViewFromSession(session);
      broadcastStateUpdate();  // refresh encoders (timeline ↔ normal)
      break;
    }

    case 'exit-detail':
      focusedDetailState.clear();
      exitDetailView();
      broadcastStateUpdate();  // refresh encoders (timeline ↔ normal)
      break;

    case 'select-option':
      if (result.optionIndex != null) {
        sendFocusedSessionCommand({ type: 'select_option', index: result.optionIndex });
      }
      break;

    case 'send-prompt':
      if (result.promptText) {
        sendFocusedSessionCommand({ type: 'send_prompt', text: result.promptText });
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
      sendFocusedSessionCommand({ type: 'send_prompt', text: '/model' });
      // Refresh to show loading state immediately
      if (isInDetailView()) {
        primeDetailViewFromSession(getFocusedSession());
      }
      break;
    }

    case 'review-run': {
      // Independent on-demand eval — a daemon-level command (the daemon
      // resolves the session's work product + judge), never a PTY prompt.
      const focused = getFocusedSession();
      if (focused) connMgr.send({ type: 'review_run', sessionId: focused.id } as any);
      break;
    }

    case 'stop':
      sendFocusedSessionCommand({ type: 'interrupt' });
      break;

    case 'esc':
      sendFocusedSessionCommand({ type: 'escape' });
      break;

    case 'refresh-usage':
      connMgr.send({ type: 'query_usage' });
      break;
  }
});

// Refresh the encoder LCDs (E1 utility, E2 Claude usage, E3 Codex usage) when
// voice-text takeover exits and releases the borrowed panels.
setVoiceTextExitCallback(() => {
  updateUtilityDialState(currentState);
  refreshClaudeUsageDial();
  updateUsageDialState();
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
  if (ev.agentType === 'openclaw' || ev.agentType === 'claude-code' || ev.agentType === 'codex-cli' || ev.agentType === 'codex-app' || ev.agentType === 'opencode' || ev.agentType === 'antigravity') {
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

  // Keypad detail state is session-owned. Never render it from the plugin's
  // global caches: those intentionally follow the latest daemon/agent event.
  if (isInDetailView()) {
    const focused = getFocusedSession();
    const detail = focused ? focusedDetailState.applyState(ev, focused) : null;
    if (detail) {
      renderFocusedDetail(detail);
    } else if (focused) {
      dlog('Plugin', `drop detail state_update source=${ev.focusedSessionId || ev.sessionId || '-'} focused=${focused.id}`);
    }
  }

  broadcastStateUpdate();
});

connMgr.on('prompt_options', (ev: PromptOptionsEvent) => {
  dlog('Plugin', `prompt_options: source=${ev.focusedSessionId || ev.sessionId || '-'} type=${ev.promptType} count=${ev.options.length} q=${ev.question ? `"${ev.question.slice(0, 40)}"` : '-'}`);
  currentOptions = ev.options;
  currentQuestion = ev.question;
  if (isInDetailView()) {
    const focused = getFocusedSession();
    const detail = focused ? focusedDetailState.applyOptions(ev, focused) : null;
    if (detail) {
      renderFocusedDetail(detail);
    } else if (focused) {
      dlog('Plugin', `drop prompt_options source=${ev.focusedSessionId || ev.sessionId || '-'} focused=${focused.id}`);
    }
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
    usageStale: ev.usageStale,
  };
  // Codex rate limits (primary≈5h, secondary≈7d) ride alongside the Claude
  // 5h/7d quota so every usage surface can draw both agents.
  const merged = { ...usageData, codexRateLimits: ev.codexRateLimits };
  updateUsageModeData(merged);
  // SD+ encoders: E2 = Claude usage water-tank, E3 = Codex usage water-tank.
  updateClaudeUsageDial(merged);
  updateUsageDialData(merged);
  // v4: feed the pinned list-view water-tank usage tiles (classic SD / XL — no
  // encoder, so usage lives on the bottom keypad row).
  updateSlotUsage(merged);
});

connMgr.on('connection', (ev: ConnectionEvent) => {
  dinfo('Plugin', `connection: ${ev.status}`);
  if (ev.status === 'disconnected') {
    focusedDetailState.clear();
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
  if (isInDetailView()) {
    const focused = getFocusedSession();
    const snapshot = focusedDetailState.snapshot;
    // A Codex fold can replace the selected thread id. Observed sessions have
    // no focused bridge relay, so their sessions_list row is always canonical.
    if (focused && (snapshot?.sessionId !== focused.id || focused.controlMode === 'observed')) {
      primeDetailViewFromSession(focused);
    }
  } else {
    focusedDetailState.clear();
  }
  // Forward to Control Tower utility mode
  updateTowerSessions(
    ev.sessions.map(s => ({
      sessionId: s.id ?? '',
      projectName: s.projectName ?? '',
      agentType: s.agentType ?? '',
      state: s.state ?? 'disconnected',
      modelName: s.modelName,
    })),
    connMgr.isConnected(),
  );
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

  // Forward eval_result entries to APME utility mode
  if (ev.entry.type === 'eval_result') {
    const raw = ev.entry.raw;
    const scoreMatch = raw.match(/(\d+)%/);
    const catMatch = raw.match(/\[(\w+)\]/);
    const modelMatch = raw.match(/model=(\S+)/);
    if (scoreMatch) {
      pushApmeEval({
        runId: '',
        category: catMatch?.[1] ?? 'general',
        overall: parseInt(scoreMatch[1], 10),
        model: modelMatch?.[1] ?? '',
        ts: ev.entry.ts,
      });
    }
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

// Announce ourselves so the daemon's Dashboard → Downstream rail can surface
// a "Stream Deck" row with the physical devices this plugin sees. Called
// from `connected` (initial registration) and from device hot-plug events
// (so the row updates without waiting for the daemon's 120 s TTL eviction).
// DeviceType 7 = Stream Deck+, 0 = Stream Deck, 1 = Stream Deck Mini,
// 2 = Stream Deck XL, 6 = Stream Deck Pedal.
function sendClientRegister(reason: string): void {
  const familyFor = (type: number | undefined): string => {
    switch (type) {
      case 0: return 'streamdeck';
      case 1: return 'streamdeckmini';
      case 2: return 'streamdeckxl';
      case 6: return 'streamdeckpedal';
      case 7: return 'streamdeckplus';
      default: return 'streamdeck-unknown';
    }
  };
  const devices = Array.from(streamDeck.devices).map((d: any) => ({
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    family: familyFor(d.type as number | undefined),
    columns: d.size?.columns as number | undefined,
    rows: d.size?.rows as number | undefined,
  }));
  dinfo('Plugin', `client_register (${reason}) devices=${devices.length} families=[${devices.map(d => d.family).join(',')}]`);
  connMgr.send({
    type: 'client_register',
    clientType: 'streamdeck-plugin',
    clientLabel: 'Stream Deck',
    devices,
  });
}

// Re-announce on hot-plug. The Elgato SDK fires these for each physical
// device add/remove; SDK-side `streamDeck.devices` is updated *before* the
// listener runs, so the snapshot inside sendClientRegister picks up the
// change. send() is a no-op if WS is down — the `connected` handler below
// will resend on reconnect.
streamDeck.devices.onDeviceDidConnect(() => sendClientRegister('deviceDidConnect'));
streamDeck.devices.onDeviceDidDisconnect(() => sendClientRegister('deviceDidDisconnect'));

connMgr.on('connected', () => {
  dinfo('Plugin', `connected (agentType=${proxiedAgentType} prevState=${currentState})`);
  setDaemonConnected(true);
  setEncoderDaemonConnected(true);
  currentState = State.IDLE;
  // Re-send slot map so bridge knows our layout when the WS comes up after
  // the plugin has already loaded (onWillAppear's first send may have been
  // dropped because the bridge was not yet connected).
  sendSlotMap();
  sendClientRegister('connected');
  // Request fresh usage data immediately on connect (covers sleep/wake recovery)
  connMgr.send({ type: 'query_usage' });
  broadcastStateUpdate();
});

connMgr.on('stale-changed', (stale: boolean) => {
  dinfo('Plugin', `daemon stale-changed: ${stale}`);
  setDaemonStale(stale);
});

connMgr.on('disconnected', () => {
  dinfo('Plugin', `disconnected (agentType=${proxiedAgentType} prevState=${currentState})`);
  setDaemonConnected(false);
  setEncoderDaemonConnected(false);
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

function broadcastStateUpdate(): void {
  // Skip rendering while display is dimmed (Mac display asleep)
  if (displayDimmed) return;

  dlog('Plugin', `broadcast: state=${currentState} mode=${currentMode} opts=${currentOptions.length}`);

  // Phase 2 SD+ encoder roles are fixed: E1 utility, E2 Claude usage, E3 Codex
  // usage, E4 voice. None get commandeered for AWAITING anymore — option /
  // permission selection lives on the keypad detail view (session-slot), which
  // is driven by updateDetailViewState. The usage encoders are permanent; we
  // still repaint them here so display-wake / voice-text-takeover-exit restore
  // them. (Each refresh is a no-op SVG redraw and self-gates on voice-text
  // takeover + daemon-down.)
  updateVoiceDialState(currentState);
  updateUtilityDialState(currentState);
  refreshClaudeUsageDial();
  updateUsageDialState();
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
  const row = payload.coordinates?.row ?? 0;
  const device = (ev.action as any)?.device;
  const columns = Number(device?.size?.columns ?? 4);
  const keyColumns = Number.isFinite(columns) && columns > 0 ? columns : 4;

  appearedActions.set(ev.action.id, {
    slot: row * keyColumns + column,
    controller,
    actionType,
    settings: payload.settings,
  });

  // Debounce: wait for all actions to appear before sending
  if (slotMapTimer) clearTimeout(slotMapTimer);
  slotMapTimer = setTimeout(sendSlotMap, 500);

  // Sync state to newly appeared dial/button immediately
  broadcastStateUpdate();
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

  // Auto-switch to the bundled profile that matches the physical key grid.
  // Each physical key grid needs its own bundled profile. SD+ has encoders,
  // classic has 15 keys, and Mini has a compact 3x2 keypad.
  //
  // SD+ profile was renamed from
  // `agentdeck-v4` → `agentdeck-sdplus` on 2026-04-20 because Elgato cached
  // the former as "dropped embedded profile" after an earlier bad package
  // install and refused to auto-install it thereafter. New name is treated
  // as fresh so AutoInstall fires cleanly.
  for (const device of streamDeck.devices) {
    const type = (device as any).type;
    const profile = type === 7
      ? 'agentdeck-sdplus'
      : type === 0
        ? 'agentdeck-sd'
        : type === 1
          ? 'agentdeck-sdmini'
          : null;
    if (!profile) continue;
    dinfo('Plugin', `Stream Deck device found: ${device.id} type=${type}, switching to ${profile}`);
    void streamDeck.profiles.switchToProfile(device.id, profile).catch((e: Error) => {
      dlog('Plugin', `profile switch failed (may already be active): ${e.message}`);
    });
  }
});
