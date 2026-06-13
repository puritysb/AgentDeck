/**
 * SessionSlotButton — v4 dynamic session-per-button action.
 *
 * Single action UUID, 8 instances (SupportedInMultiActions).
 * Each instance auto-detects its physical slot from willAppear coordinates.
 * Central SessionSlotManager drives all rendering and press handling.
 */
import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import type { SessionInfo, PromptOption } from '@agentdeck/shared';
import { SessionSlotManager, type DeckLayout, type SessionSlotConfig } from '../session-slot-manager.js';
import { computeCenterCluster } from '../center-slot.js';
import {
  renderSessionSlot,
  renderEmptySlot,
  renderDisconnectedSlot,
  renderBackButton,
  renderNextPageButton,
  renderEscButton,
  renderStopButton,
  renderDetailInfo,
  renderOptionButton,
  renderInfoSlot,
  renderPresetButton,
  renderStatusCard,
  type DisconnectedSlotConfig,
} from '../renderers/session-slot-renderer.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { dlog } from '../log.js';
import { openAgentDeckAppOrGitHub } from '../utility-modes/macos.js';

// ---- Module state ----

const manager = new SessionSlotManager();

/** Action instance ID → physical slot + physical device layout */
const slotMap = new Map<string, { slot: number; layout: DeckLayout }>();

/** All registered action instance IDs */
const actionIds: string[] = [];

/** Animation frame counter for orbiting session borders. */
let animFrame = 0;
let animTimer: ReturnType<typeof setInterval> | null = null;
const ANIM_INTERVAL_MS = 150;

/**
 * Per-session animFrame at which the session entered processing/awaiting.
 * Lets each button orbit out of phase with siblings — phase reflects real
 * start time instead of every PROCESSING button rotating in lockstep.
 * Cleared on animation restart (animFrame resets to 0) and when sessions
 * leave the animated state or the visible slot set.
 */
const processingStartFrame = new Map<string, number>();

/** Callback for press actions that need bridge interaction */
let onSlotAction: ((action: ReturnType<typeof manager.handleSlotPress>) => void) | null = null;

/** Whether daemon connection is alive */
let daemonConnected = false;

/** Soft-stale: daemon is still connected but has gone quiet past the stale
 *  window. Dims the last-known session renders until data resumes or the
 *  connection hard-disconnects (which flips to OFFLINE via daemonConnected). */
let daemonStale = false;

// ---- Public API ----

export function initSessionSlots(
  callback: (action: ReturnType<typeof manager.handleSlotPress>) => void,
): void {
  onSlotAction = callback;
}

export function updateSessionSlotSessions(sessions: SessionInfo[], gatewayAvailable: boolean): void {
  manager.updateSessions(sessions, gatewayAvailable);
  refreshAll();
}

export function setActiveSession(sessionId: string | null, port: number | null): void {
  manager.setActiveSession(sessionId, port);
  if (manager.view === 'list') refreshAll();
}

export function updateDetailViewState(
  state: State,
  options: PromptOption[],
  tool?: string,
  toolInput?: string,
  question?: string,
  modelName?: string,
  mode?: string,
  effortLevel?: string,
): void {
  manager.updateDetailState(state, options, tool, toolInput, question, modelName, mode, effortLevel);
  if (manager.view === 'detail') refreshAll();
}

export function exitDetailView(): void {
  manager.exitDetailView();
  stopAnimation();
  refreshAll();
}

export function getSessionSlotManager(): SessionSlotManager {
  return manager;
}

export function isInDetailView(): boolean {
  return manager.view === 'detail';
}

export function getFocusedSession(): SessionInfo | undefined {
  return manager.getFocusedSession();
}

export function setDaemonConnected(connected: boolean): void {
  daemonConnected = connected;
  if (!connected) {
    daemonStale = false;
    // Clear sessions on daemon disconnect
    manager.updateSessions([], false);
    if (manager.view === 'detail') {
      manager.exitDetailView();
    }
  }
  refreshAll();
}

export function setDaemonStale(stale: boolean): void {
  if (daemonStale === stale) return;
  daemonStale = stale;
  refreshAll();
}

// ---- Animation ----

function startAnimation(): void {
  if (animTimer) return;
  animFrame = 0;
  processingStartFrame.clear();
  animTimer = setInterval(() => {
    animFrame++;
    refreshAll();
  }, ANIM_INTERVAL_MS);
}

function stopAnimation(): void {
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
}

/** Check if any visible session needs animation (active, awaiting, or processing border). */
function needsAnimation(): boolean {
  if (manager.view === 'detail') return false; // Detail view doesn't animate session buttons
  if (slotMap.size === 0) {
    return manager.sessions.some((session) =>
      session.state?.startsWith('awaiting') || session.state === 'processing',
    );
  }
  for (const { slot, layout } of slotMap.values()) {
    const config = manager.getSlotConfig(slot, layout);
    if (config.type !== 'session' || !config.session) continue;
    if (config.isActive) return true;
    if (config.session.state?.startsWith('awaiting')) return true;
    if (config.session.state === 'processing') return true;
  }
  return false;
}

// ---- Rendering ----

function familyForDeviceType(type: number | undefined): string {
  switch (type) {
    case 0: return 'streamdeck';
    case 1: return 'streamdeckmini';
    case 2: return 'streamdeckxl';
    case 7: return 'streamdeckplus';
    default: return 'streamdeck';
  }
}

function layoutForEvent(ev: WillAppearEvent | KeyDownEvent): DeckLayout {
  const device = (ev.action as any)?.device;
  const columns = Number(device?.size?.columns ?? 4);
  const rows = Number(device?.size?.rows ?? 2);
  return {
    columns: Number.isFinite(columns) && columns > 0 ? columns : 4,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 2,
    keyCount: Math.max(1, (Number.isFinite(columns) && columns > 0 ? columns : 4) * (Number.isFinite(rows) && rows > 0 ? rows : 2)),
    family: familyForDeviceType(Number(device?.type)),
  };
}

function getDisconnectedSlotConfig(slot: number, layout: DeckLayout): DisconnectedSlotConfig {
  const cols = layout.columns;
  const rows = layout.rows;
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  return {
    kind: 'open-app',
    label: 'OFFLINE',
    subtitle: 'Open AgentDeck',
    col,
    row,
    cols,
    rows,
  };
}

function refreshAll(): void {
  // Daemon not connected -> single OFFLINE hero on the center key, the rest empty.
  if (!daemonConnected) {
    for (const id of actionIds) {
      const entry = slotMap.get(id);
      if (entry == null) continue;
      const act = streamDeck.actions.getActionById(id);
      if (!act) continue;
      void act.setImage(svgToDataUrl(renderDisconnectedSlot(getDisconnectedSlotConfig(entry.slot, entry.layout)))).catch(() => {});
    }
    stopAnimation();
    return;
  }

  // Start/stop animation based on visible session border state.
  if (needsAnimation() && !animTimer) {
    startAnimation();
  } else if (!needsAnimation() && animTimer) {
    stopAnimation();
  }

  const liveSessionIds = new Set<string>();
  for (const id of actionIds) {
    const entry = slotMap.get(id);
    if (entry == null) continue;
    const act = streamDeck.actions.getActionById(id);
    if (!act) continue;

    const config = manager.getSlotConfig(entry.slot, entry.layout);
    if (config.type === 'session' && config.session) liveSessionIds.add(config.session.id);
    const svg = renderSlotSvg(config, entry.slot);
    void act.setImage(svgToDataUrl(svg)).catch(() => {});
  }
  // Drop phase entries for sessions that are no longer visible.
  for (const id of processingStartFrame.keys()) {
    if (!liveSessionIds.has(id)) processingStartFrame.delete(id);
  }
}

function renderSlotSvg(config: SessionSlotConfig, _slot: number): string {
  switch (config.type) {
    case 'session': {
      const sess = config.session!;
      const animatedState = sess.state === 'processing' || (sess.state?.startsWith('awaiting') ?? false);
      if (animatedState) {
        if (!processingStartFrame.has(sess.id)) processingStartFrame.set(sess.id, animFrame);
      } else {
        processingStartFrame.delete(sess.id);
      }
      return renderSessionSlot(sess, config.isActive ?? false, animFrame, undefined, {
        processingStartFrame: processingStartFrame.get(sess.id),
        isStale: daemonStale,
      });
    }

    case 'back':
      return renderBackButton();

    case 'info':
      if (config.session) {
        return renderDetailInfo(
          config.session,
          manager.detailState,
          undefined, // tool shown separately
          manager.detailModelName ?? config.session.modelName,
          undefined,
          config.label,
          manager.detailEffortLevel ?? config.session.effortLevel,
        );
      }
      return renderInfoSlot(config.label ?? '---', config.subtitle, config.icon, config.tone, config.detail);

    case 'status':
      return renderStatusCard({
        icon: config.icon ?? 'activity',
        label: config.label ?? '---',
        subtitle: config.subtitle,
        detail: config.detail,
        tone: config.tone,
      });

    case 'option':
      return renderOptionButton(config.option!, config.optionIndex ?? 0);

    case 'preset':
      if (config.preset) {
        return renderPresetButton(config.preset.label, config.preset.iconSvg, config.preset.color, config.preset.textColor, config.preset.subtitle, config.preset.loading);
      }
      return renderEmptySlot();

    case 'esc':
      return renderEscButton(config.label === 'active');

    case 'stop':
      return renderStopButton(config.label === 'active');

    case 'next-page':
      return renderNextPageButton(config.label ?? '');

    case 'empty':
    default:
      return renderEmptySlot();
  }
}

// ---- Action class ----

@action({ UUID: 'bound.serendipity.agentdeck.session-slot' })
export class SessionSlotButtonAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const id = ev.action.id;
    if (!actionIds.includes(id)) {
      actionIds.push(id);
    }

    // Auto-detect physical slot from coordinates and actual device key grid.
    const col = (ev.payload as any)?.coordinates?.column ?? 0;
    const row = (ev.payload as any)?.coordinates?.row ?? 0;
    const layout = layoutForEvent(ev);
    const slot = row * layout.columns + col;
    slotMap.set(id, { slot, layout });

    dlog('SesSlot', `willAppear: id=${id.slice(-6)} slot=${slot} (row=${row} col=${col} grid=${layout.columns}x${layout.rows}) daemon=${daemonConnected}`);

    // Render appropriate state
    if (!daemonConnected) {
      await ev.action.setImage(svgToDataUrl(renderDisconnectedSlot(getDisconnectedSlotConfig(slot, layout))));
    } else {
      const config = manager.getSlotConfig(slot, layout);
      await ev.action.setImage(svgToDataUrl(renderSlotSvg(config, slot)));
    }
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const entry = slotMap.get(ev.action.id);
    if (entry == null) return;
    const { slot, layout } = entry;

    if (!daemonConnected) {
      dlog('SesSlot', 'keyDown: launching AgentDeck app or GitHub');
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }

    const result = manager.handleSlotPress(slot, layout);
    dlog('SesSlot', `keyDown: slot=${slot} action=${result.action}`);

    if (result.action === 'next-page') {
      manager.nextPage(layout);
      refreshAll();
      return;
    }

    if (result.action === 'exit-detail') {
      manager.exitDetailView();
      refreshAll();
    }

    // Delegate to bridge callback
    if (onSlotAction) {
      onSlotAction(result);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
    slotMap.delete(ev.action.id);
  }
}
