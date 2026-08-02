import streamDeck from '@elgato/streamdeck';
import {
  StateUpdateEvent,
  PromptOptionsEvent,
  UsageEvent,
  ConnectionEvent,
  UserPromptEvent,
  State,
  PermissionMode,
  OPENCLAW_GATEWAY_PORT,
  type AgentType,
  type DeckSlotConfig,
  type DeckSlotMapEvent,
  type SessionInfo,
} from '@agentdeck/shared';

import { ConnectionManager } from './connection-manager.js';
import { updateUsageModeData, setUsageRefreshCallback } from './utility-modes/usage.js';
import { setEncoderDaemonConnected } from './encoder-registry.js';
import { dlog, dinfo } from './log.js';

// Encoder actions
import {
  ResponseDialAction,
  initOptionDial,
  updateClaudeUsageDial,
  refreshClaudeUsageDial,
} from './actions/option-dial.js';
import {
  LauncherDialAction,
  initLauncherDial,
  updateLauncherDialState,
} from './actions/launcher-dial.js';
import {
  UtilityDialAction,
  initUtilityDial,
  updateUtilityDialState,
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
  updateDetailViewState,
  exitDetailView,
  isInDetailView,
  getSessionSlotManager,
  getFocusedSession,
  setDaemonConnected,
  setDaemonStale,
  updateSlotUsage,
  markSessionReviewPending,
  clearSessionReviewPending,
  refreshSessionSlots,
} from './actions/session-slot-button.js';
import { isDisplayDimmed, setDisplayDimmed, dimActionIfNeeded } from './display-dim.js';
import { FocusedDetailState, type FocusedDetailSnapshot } from './focused-detail-state.js';
import { voiceCommandForAction } from './voice-ptt.js';

// ---- Shared state ----
let currentState = State.DISCONNECTED;
let currentMode = PermissionMode.DEFAULT;
let currentOptions: import('@agentdeck/shared').PromptOption[] = [];
let proxiedAgentType: AgentType | null = null;

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
initLauncherDial();
initUtilityDial();
initUsageDial(connMgr);

// ---- Initialize v4 utility mode callbacks ----
setUsageRefreshCallback(() => {
  connMgr.send({ type: 'query_usage' });
});
// ---- Initialize v4 session slot buttons ----
initSessionSlots((result) => {
  dlog('Plugin', `sessionSlot action: ${result.action} session=${result.sessionId ?? '-'} port=${result.sessionPort ?? '-'}`);

  const voiceCommand = voiceCommandForAction(result.action, result.sessionId);
  if (voiceCommand) {
    connMgr.send(voiceCommand as any);
    return;
  }

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
      import('./system/index.js').then(({ openOrFocusBrowserTab }) => {
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
      if (focused) {
        connMgr.send({ type: 'review_run', sessionId: focused.id } as any);
        // Instant press-ack: flip the tile to REVIEWING before the daemon's
        // review_status/sessions_list round trip (which can lag many seconds
        // while a judge is busy). Cleared on refusal via review_status error.
        markSessionReviewPending(focused.id);
      }
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

// ---- Bridge event handlers ----

connMgr.on('state_update', (ev: StateUpdateEvent) => {
  dlog('Plugin', `state_update: ${ev.state} mode=${ev.permissionMode} tool=${ev.currentTool || '-'} project=${ev.projectName || '-'} opts=${ev.options?.length ?? '-'} nav=${ev.navigable ?? '-'}`);

  currentState = ev.state;
  currentMode = ev.permissionMode;

  // Track proxied agent type from daemon (state_update.agentType overrides connection-level detection)
  if (ev.agentType === 'openclaw' || ev.agentType === 'claude-code' || ev.agentType === 'codex-cli' || ev.agentType === 'codex-app' || ev.agentType === 'opencode' || ev.agentType === 'antigravity') {
    proxiedAgentType = ev.agentType;
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
    broadcastStateUpdate();
  }
  // 'connected' case: state_update (sent before connection event) already
  // set the correct state — don't clobber it to IDLE here.
});

// ---- v4 Session Slot: sessions_list → slot assignment ----
connMgr.on('sessions_list', (ev: { type: 'sessions_list'; sessions: SessionInfo[] }) => {
  dlog('Plugin', `sessions_list: ${ev.sessions.length} sessions`);
  updateSessionSlotSessions(ev.sessions);
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
});

connMgr.on('user_prompt', (ev: UserPromptEvent) => {
  dlog('Plugin', `user_prompt: "${ev.text.slice(0, 60)}"`);
});

// Review lifecycle: an error (mid-turn refusal, judge failure) must clear the
// optimistic REVIEWING flip set at press time — success flows through the
// sessions_list reviewStatus badge instead.
connMgr.on('review_status', (ev: { type: 'review_status'; sessionId: string; status: string; message?: string }) => {
  dlog('Plugin', `review_status: ${ev.sessionId} ${ev.status}${ev.message ? ` (${ev.message})` : ''}`);
  if (ev.status === 'error' && ev.sessionId) clearSessionReviewPending(ev.sessionId);
});

// Host push-to-talk progress -> VOICE key facelift. Error is transient by
// design: the daemon parks on 'error' after a failed capture, and without the
// reset the key would read "no speech" forever.
let voiceErrorResetTimer: ReturnType<typeof setTimeout> | null = null;
connMgr.on('voice_state', (ev: { type: 'voice_state'; state: 'idle' | 'recording' | 'transcribing' | 'error'; text?: string; error?: string }) => {
  dlog('Plugin', `voice_state: ${ev.state}${ev.text ? ` "${ev.text.slice(0, 40)}"` : ''}${ev.error ? ` (${ev.error})` : ''}`);
  if (voiceErrorResetTimer) { clearTimeout(voiceErrorResetTimer); voiceErrorResetTimer = null; }
  const changed = getSessionSlotManager().updateVoiceState(ev.state);
  if (ev.state === 'error') {
    voiceErrorResetTimer = setTimeout(() => {
      voiceErrorResetTimer = null;
      if (getSessionSlotManager().updateVoiceState('idle') && isInDetailView()) refreshSessionSlots();
    }, 3000);
  }
  if (changed && isInDetailView()) refreshSessionSlots();
});

// ---- Display sleep/wake dimming ----
// The gate itself lives in display-dim.ts so the per-action repaint paths that
// never pass through broadcastStateUpdate() (usage ticks, the volume poll, the
// awaiting animation) can consult it too.

function dimAllActions(): void {
  for (const [actionId, entry] of appearedActions.entries()) {
    const act = streamDeck.actions.getActionById(actionId);
    if (!act) continue;
    dimActionIfNeeded(act, entry.controller);
  }
}

connMgr.on('display_state', (ev: {
  type: 'display_state';
  displayOn: boolean;
  dim?: { enabled?: boolean; mode?: 'off' | 'min'; level?: number };
}) => {
  // The SDK exposes no key brightness, so "dark" can only be black pixels.
  // That makes mode "min" (dim but readable) unrepresentable — blanking would
  // hide more than it dims — so only "off" blanks; "min" stays lit. Honor
  // `enabled: false` too: the user turned dimming off, and blanking anyway was
  // the previous behavior because this handler never parsed `dim` at all.
  const dimEnabled = ev.dim?.enabled !== false;
  const blanks = ev.dim?.mode !== 'min';
  const shouldDim = !ev.displayOn && dimEnabled && blanks;
  dinfo('Plugin', `display_state: displayOn=${ev.displayOn} enabled=${dimEnabled} mode=${ev.dim?.mode ?? 'off'}`);
  if (shouldDim && !isDisplayDimmed()) {
    setDisplayDimmed(true);
    dimAllActions();
  } else if (!shouldDim && isDisplayDimmed()) {
    setDisplayDimmed(false);
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
  currentState = State.DISCONNECTED;
  currentOptions = [];
  broadcastStateUpdate();
});

function broadcastStateUpdate(): void {
  // Skip rendering while display is dimmed (Mac display asleep)
  if (isDisplayDimmed()) return;

  dlog('Plugin', `broadcast: state=${currentState} mode=${currentMode} opts=${currentOptions.length}`);

  // Phase 2 SD+ encoder roles are fixed: E1 utility, E2 Claude usage, E3 Codex
  // usage, E4 launcher. None get commandeered for AWAITING anymore — option /
  // permission selection lives on the keypad detail view (session-slot), which
  // is driven by updateDetailViewState. The encoders are permanent; we still
  // repaint them here so display-wake restores them. (Each refresh is a no-op
  // SVG redraw and self-gates on daemon-down.)
  updateLauncherDialState();
  updateUtilityDialState(currentState);
  refreshClaudeUsageDial();
  updateUsageDialState();
  // Keypad slots too — on display wake nothing else will repaint them, since
  // sessions_list only fires when the session set actually changes.
  refreshSessionSlots();
}

// ---- Register actions ----
streamDeck.actions.registerAction(new ResponseDialAction());
streamDeck.actions.registerAction(new LauncherDialAction());
streamDeck.actions.registerAction(new UtilityDialAction());
streamDeck.actions.registerAction(new UsageDialAction());
streamDeck.actions.registerAction(new SessionSlotButtonAction());

// ---- Slot Map Reporting (Phase A7) ----

// UUID suffix → actionType mapping
const UUID_TO_ACTION_TYPE: Record<string, string> = {
  'session-slot': 'session-slot',
  'response-dial': 'option-dial',
  'launcher': 'launcher',
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
