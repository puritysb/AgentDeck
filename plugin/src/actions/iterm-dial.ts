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
  TouchTapEvent,
} from '@elgato/streamdeck';
import { encoderRegistry, isDaemonConnected } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderUsageEncoderBoth, renderUsageEncoderSingle } from '../renderers/usage-gauge.js';
import { renderUsageSession } from '../renderers/usage-dial-renderer.js';
import {
  type UsageModeData, type UsageProviderId, type UsageView,
  updateUsageModeData, getUsageModeData, fireUsageRefresh,
  availableUsageProviders, availableUsageViews, buildProviderUsageEncoder,
  getUsageDialSelections, setE3UsageProvider, selectUsageDialProvider, onUsageDialSelectionChanged,
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
let currentView: UsageView = 'both';

/**
 * E3's provider page (#349) — the user's STICKY "what do I want to watch" dial.
 * Touch-tap cycles through all available providers; rotation cycles the views
 * of the current page; press refreshes. The page only re-anchors when the
 * current provider loses its data entirely or an explicit E2 choice claims it.
 */
function anchoredProvider(): UsageProviderId {
  const data = getUsageModeData();
  const available = availableUsageProviders(data);
  const current = getUsageDialSelections().e3;
  if (available.length === 0 || available.includes(current)) return current;
  // Data loss: re-anchor to any live page (prefer one E2 is not on).
  const next = available.find((p) => p !== getUsageDialSelections().e2) ?? available[0];
  const anchored = next ?? 'codex';
  setE3UsageProvider(anchored);
  return anchored;
}

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

  setCanvasFeedback(renderCodexUsageView());
}

/** Render the current dial-cycled view for the current provider page. */
function renderCodexUsageView(): string {
  const data = getUsageModeData();
  const enc = buildProviderUsageEncoder(anchoredProvider(), data, hasReceivedData);
  // A window can vanish between rotations (or never arrive), so re-anchor to a
  // reachable view instead of rendering a stop that no longer exists.
  const views = availableUsageViews(enc);
  const view: UsageView = views.includes(currentView) ? currentView : 'both';
  if (view === 'session') {
    // Session tokens/cost are shared (not Codex-specific). When none exist, fall
    // back to the windows rather than an empty text card.
    const hasSession =
      (data.inputTokens ?? 0) > 0 || (data.outputTokens ?? 0) > 0 || data.estimatedCostUsd != null;
    if (hasSession) return renderUsageSession(data);
    return renderUsageEncoderBoth(enc);
  }
  if (view === '5h') return renderUsageEncoderSingle(enc, '5h');
  if (view === '7d') return renderUsageEncoderSingle(enc, '7d');
  return renderUsageEncoderBoth(enc);
}

@action({ UUID: 'bound.serendipity.agentdeck.iterm-dial' })
export class UsageDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.usageIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('CodexUsageDial', `onWillAppear: id=${ev.action.id}`);
    if (!encoderRegistry.usageIds.includes(ev.action.id)) {
      encoderRegistry.usageIds.push(ev.action.id);
    }
    currentLayout = PIXMAP_LAYOUT;
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    fireUsageRefresh();
    refreshUsageDials();
  }

  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    // Touch-tap cycles the provider page (#349) through ALL available providers.
    // The never-same-provider preference is the ANCHOR default, not a cycle
    // restriction: excluding E2's provider from the cycle made it impossible
    // to reach z.ai when E2 was anchored there and only codex+z.ai were live
    // (the filtered list was length 1 — a no-op cycle).
    const available = availableUsageProviders(getUsageModeData());
    if (available.length < 2) return;
    const current = getUsageDialSelections().e3;
    const at = available.indexOf(current);
    const next = available[((at < 0 ? 0 : at) + 1) % available.length];
    selectUsageDialProvider('e3', next, getUsageModeData());
    dlog('UsageDial', `touch-tap → provider=${next}`);
    refreshUsageDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    // Rotation cycles the views the current payload actually has — with only a
    // weekly window that is both → 7d → session, no dead 5h stop.
    const dir = ev.payload.ticks >= 0 ? 1 : -1;
    const views = availableUsageViews(
      buildProviderUsageEncoder(anchoredProvider(), getUsageModeData(), hasReceivedData),
    );
    const at = views.indexOf(currentView);
    currentView = views[((at < 0 ? 0 : at) + dir + views.length) % views.length];
    dlog('UsageDial', `rotate → view=${currentView}`);
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
    const idx = encoderRegistry.usageIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.usageIds.splice(idx, 1);
    }
  }
}
