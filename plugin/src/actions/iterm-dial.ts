import { usageDialViews, renderUsageDialView } from '../utility-modes/usage-dial-view.js';
import { PerActionViewState } from './per-action-view-state.js';
/**
 * E3 — Codex usage dial (Stream Deck+).
 *
 * This encoder shows the Codex subscription quota (from `codexRateLimits`) on
 * its 200×100 LCD using the full-bleed level-fill gauge. The dial ROTATION
 * cycles between views ('both' → '5h' → '7d' → 'session'); the dial PRESS
 * requests a usage refresh. When Codex reports no rate limits the gauge views
 * fall back to a muted "No Codex usage" note; the session view shows shared
 * token/cost text (or falls back to the windows when no token data exists).
 * The UUID (`iterm-dial`) is kept for backward profile compatibility.
 */
import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  DialUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
  TouchTapEvent,
} from '@elgato/streamdeck';
import { encoderRegistry, isDaemonConnected } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import {
  type UsageModeData, type UsageProviderId,
  updateUsageModeData, getUsageModeData, fireUsageRefresh,
  availableUsageProviders,
  getUsageDialSelections, selectUsageDialProvider, onUsageDialSelectionChanged,
} from '../utility-modes/usage.js';
import type { ConnectionManager } from '../connection-manager.js';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';
import { dlog, dinfo } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../system/index.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

let currentLayout = '';
let hasReceivedData = false;
/** Dial-cycled view for the current provider page (E3). Held as the view ITSELF,
 *  not an index — the reachable list resizes as windows appear/disappear, and a
 *  retained index would silently land on a different view. */
const usageViews = new PerActionViewState('both');

/**
 * E3's provider page (#349) — the user's STICKY "what do I want to watch" dial.
 * Touch-tap cycles through all available providers; rotation cycles the views
 * of the current page; press refreshes. A saved choice remains visible while
 * its usage data is unavailable, so a temporary fetch gap cannot replace it.
 */
function selectedProvider(): UsageProviderId { return getUsageDialSelections().e3; }

export function initUsageDial(_bridge: ConnectionManager): void {
  dinfo('CodexUsageDial', 'initUsageDial called');
  onUsageDialSelectionChanged(refreshUsageDials);
}

/** Called from plugin.ts when usage_update arrives. */
export function updateUsageDialData(data: UsageModeData): void {
  updateUsageModeData(data);
  hasReceivedData = true;
  refreshUsageDials();
}

/** Called from plugin.ts on daemon connect/disconnect to redraw (offline banner). */
export function updateUsageDialState(): void {
  if (!isDaemonConnected()) hasReceivedData = false;
  refreshUsageDials();
}

function ensurePixmapLayout(): void {
  if (currentLayout === PIXMAP_LAYOUT) return;
  currentLayout = PIXMAP_LAYOUT;
  for (const id of encoderRegistry.usageIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }
}

function setCanvasFeedback(svg: string): void {
  const feedback = { canvas: svgToDataUrl(svg) };
  for (const id of encoderRegistry.usageIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

function refreshUsageDials(): void {
  // See option-dial: usage ticks must not undo display-sleep blanking.
  if (isDisplayDimmed()) return;
  if (encoderRegistry.usageIds.length === 0) return;
  ensurePixmapLayout();

  // Offline banner is highest priority and all-or-nothing across the 4 encoders.
  if (!isDaemonConnected()) {
    setCanvasFeedback(renderOfflineTouchStrip(2));
    return;
  }

  for (const id of encoderRegistry.usageIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback({ canvas: svgToDataUrl(renderCodexUsageView(id)) }).catch(() => {});
  }
}

/** Render the current dial-cycled view for the current provider page. */
function renderCodexUsageView(id: string): string {
  const data = getUsageModeData();
  const provider = selectedProvider();
  return renderUsageDialView(data, provider, hasReceivedData, usageViews.resolve(id, usageDialViews(data, provider)));
}

@action({ UUID: 'bound.serendipity.agentdeck.iterm-dial' })
export class UsageDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.usageIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('CodexUsageDial', `onWillAppear: id=${ev.action.id}`);
    if (!encoderRegistry.usageIds.includes(ev.action.id)) {
      encoderRegistry.usageIds.push(ev.action.id);
    }
    usageViews.load(ev.action.id, ev.payload.settings?.usageView);
    currentLayout = PIXMAP_LAYOUT;
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    fireUsageRefresh();
    refreshUsageDials();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent): void {
    usageViews.load(ev.action.id, ev.payload.settings?.usageView);
    refreshUsageDials();
  }

  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    // Each tap changes only this dial.
    const available = availableUsageProviders(getUsageModeData());
    if (available.length === 0) return;
    const current = getUsageDialSelections().e3;
    const at = available.indexOf(current);
    if (available.length === 1 && at === 0) return;
    const next = available[(at + 1) % available.length];
    selectUsageDialProvider('e3', next, getUsageModeData());
    dlog('UsageDial', `touch-tap → provider=${next}`);
    refreshUsageDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    // Rotation cycles the views the current payload actually has — with only a
    // weekly window that is both → 7d → session, no dead 5h stop.
    const views = usageDialViews(getUsageModeData(), selectedProvider());
    const next = usageViews.rotate(ev.action.id, views, ev.payload.ticks);
    await ev.action.setSettings({ ...ev.payload.settings, usageView: next });
    refreshUsageDials();
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    // Push: pull fresh usage.
    fireUsageRefresh();
    dlog('CodexUsageDial', 'push: requesting usage refresh');
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    dinfo('CodexUsageDial', `onWillDisappear: id=${ev.action.id}`);
    usageViews.remove(ev.action.id);
    const idx = encoderRegistry.usageIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.usageIds.splice(idx, 1);
    }
  }
}
