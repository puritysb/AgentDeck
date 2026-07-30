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
import { type UsageModeData, updateUsageModeData, getUsageModeData, fireUsageRefresh, buildCodexUsageEncoder } from '../utility-modes/usage.js';
import type { ConnectionManager } from '../connection-manager.js';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';
import { dlog, dinfo } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../utility-modes/system-control.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

/** Views the dial rotates through. */
const USAGE_VIEWS = ['both', '5h', '7d', 'session'] as const;
type UsageView = typeof USAGE_VIEWS[number];

let currentLayout = '';
let hasReceivedData = false;
/** Dial-cycled view index for the Codex usage encoder (E3). */
let viewIndex = 0;

export function initUsageDial(_bridge: ConnectionManager): void {
  dinfo('CodexUsageDial', 'initUsageDial called');
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

/** Render the current dial-cycled view for the Codex usage encoder. */
function renderCodexUsageView(): string {
  const data = getUsageModeData();
  const enc = buildCodexUsageEncoder(data, hasReceivedData);
  const view: UsageView = USAGE_VIEWS[viewIndex];
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
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    // Rotation cycles the usage view (both → 5h → 7d → session).
    const dir = ev.payload.ticks >= 0 ? 1 : -1;
    viewIndex = (viewIndex + dir + USAGE_VIEWS.length) % USAGE_VIEWS.length;
    dlog('CodexUsageDial', `rotate → view=${USAGE_VIEWS[viewIndex]}`);
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
