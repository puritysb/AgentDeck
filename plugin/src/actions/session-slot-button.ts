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
import { State, PASSIVE_OFFLINE_LABEL, OPEN_AGENTDECK_LABEL } from '@agentdeck/shared';
import type { SessionInfo, PromptOption, CodexRateLimits } from '@agentdeck/shared';
import { SessionSlotManager, type DeckLayout, type SessionSlotConfig } from '../session-slot-manager.js';
import {
  renderSessionSlot,
  renderEmptySlot,
  renderDisconnectedSlot,
  renderBackButton,
  renderNextPageButton,
  renderEscButton,
  renderStopButton,
  renderOptionButton,
  renderPresetButton,
  type DisconnectedSlotConfig,
} from '../renderers/session-slot-renderer.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderUsageGauge } from '../renderers/usage-gauge.js';
import { renderStatusReadout, renderSessionReadout } from '../renderers/display-tile.js';
import { dlog } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../utility-modes/system-control.js';

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
 * Kept across animation timer restarts so already-running sessions do not
 * re-enter in lockstep; cleared when sessions leave the animated state or
 * the visible slot set.
 */
const processingStartFrame = new Map<string, { state: string; frame: number }>();

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

export function updateSessionSlotSessions(sessions: SessionInfo[]): void {
  manager.updateSessions(sessions);
  refreshAll();
}


/** Feed latest Claude 5H/7D + Codex quota; re-render only the list view (where usage tiles live). */
export function updateSlotUsage(usage: {
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
  usageStale?: boolean;
  codexRateLimits?: CodexRateLimits;
}): void {
  manager.updateUsage(usage);
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
  suggestedPrompt?: string,
): void {
  manager.updateDetailState(state, options, tool, toolInput, question, modelName, mode, effortLevel, suggestedPrompt);
  if (manager.view === 'detail') refreshAll();
}

export function exitDetailView(): void {
  manager.exitDetailView();
  stopAnimation();
  refreshAll();
}

/**
 * Repaint every key from current state. Used on display wake, where nothing
 * changed except that the keys are allowed to light up again.
 */
export function refreshSessionSlots(): void {
  refreshAll();
}

export function getSessionSlotManager(): SessionSlotManager {
  return manager;
}

/** Instant press-ack: flip the REVIEW tile to REVIEWING before the daemon round trip. */
export function markSessionReviewPending(sessionId: string): void {
  manager.markReviewPending(sessionId);
  refreshAll();
}

/** Daemon refused/errored the review — drop the optimistic REVIEWING flip. */
export function clearSessionReviewPending(sessionId: string): void {
  manager.clearReviewPending(sessionId);
  refreshAll();
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
    manager.updateSessions([]);
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
    label: PASSIVE_OFFLINE_LABEL,
    subtitle: OPEN_AGENTDECK_LABEL,
    col,
    row,
    cols,
    rows,
  };
}

function refreshAll(): void {
  // The awaiting/processing animation timer keeps ticking while the host
  // display sleeps; without this gate it would repaint over the black frame.
  if (isDisplayDimmed()) return;
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

function stableSessionPhaseFrames(session: SessionInfo): number {
  const key = `${session.id}|${session.startedAt ?? ''}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 36;
}

function renderSlotSvg(config: SessionSlotConfig, _slot: number): string {
  switch (config.type) {
    case 'session': {
      const sess = config.session!;
      const animatedState = sess.state === 'processing' || (sess.state?.startsWith('awaiting') ?? false);
      const phaseState = animatedState ? sess.state ?? 'processing' : '';
      if (animatedState) {
        const existing = processingStartFrame.get(sess.id);
        if (!existing || existing.state !== phaseState) {
          processingStartFrame.set(sess.id, {
            state: phaseState,
            frame: animFrame - stableSessionPhaseFrames(sess),
          });
        }
      } else {
        processingStartFrame.delete(sess.id);
      }
      return renderSessionSlot(sess, false, animFrame, undefined, {
        processingStartFrame: processingStartFrame.get(sess.id)?.frame,
        isStale: daemonStale,
      });
    }

    case 'back':
      return renderBackButton();

    // INFO is a pure readout (which session am I steering) — render it flat and
    // non-interactive so it doesn't masquerade as a pressable control.
    case 'info':
      if (config.session) {
        return renderSessionReadout(
          config.session,
          manager.detailState,
          manager.detailModelName ?? config.session.modelName,
          config.label,
          manager.detailEffortLevel ?? config.session.effortLevel,
        );
      }
      return renderStatusReadout({
        label: config.label ?? '---',
        subtitle: config.subtitle,
        detail: config.detail,
        tone: config.tone,
      });

    // STATUS cards (MODEL / MODE / READY·STANDBY / AWAITING / TOOL / IDLE /
    // HUB READY / NO SESSION) are readouts, not controls — flat, non-interactive.
    case 'status':
      return renderStatusReadout({
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

    case 'usage':
      return renderUsageGauge({
        agent: config.usageAgent ?? 'claude',
        window: config.usageWindow ?? '5h',
        label: config.usageLabel ?? '',
        usedPercent: config.usagePercent ?? 0,
        resetsAt: config.usageResetsAt,
        known: config.usageKnown !== false,
      });

    case 'usage-page':
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
    if (dimActionIfNeeded(ev.action, 'Keypad')) return;
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

    if (result.action === 'cycle-usage-page') {
      manager.cycleUsagePage();
      refreshAll();
      return;
    }

    // 'refresh-usage' has no local view change — fall through to the bridge
    // callback, which sends query_usage to pull fresh quota.

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
