/**
 * E2 — Claude usage dial (Stream Deck+).
 *
 * This encoder shows the Claude subscription quota on its 200×100 LCD using the
 * full-bleed level-fill gauge. The dial ROTATION cycles between views
 * ('both' → '5h' → '7d' → 'session'); the dial PRESS requests a usage refresh.
 * It never gets commandeered for option/permission selection — that interaction
 * lives on the keypad detail view (session-slot). The UUID (`option-dial`) is
 * kept for profile/manifest stability even though the role is "Claude usage".
 */
import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  DialUpEvent,
  TouchTapEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import type { AgentLink } from '../agent-link.js';
import { encoderRegistry, isDaemonConnected } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderUsageEncoderBoth, renderUsageEncoderSingle } from '../renderers/usage-gauge.js';
import { renderUsageSession } from '../renderers/usage-dial-renderer.js';
import { type UsageModeData, updateUsageModeData, getUsageModeData, fireUsageRefresh, buildClaudeUsageEncoder } from '../utility-modes/usage.js';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';
import { dlog } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../utility-modes/system-control.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

/** Views the dial rotates through. */
const USAGE_VIEWS = ['both', '5h', '7d', 'session'] as const;
type UsageView = typeof USAGE_VIEWS[number];

let currentLayout = '';
let hasReceivedData = false;
/** Dial-cycled view index for the Claude usage encoder (E2). */
let viewIndex = 0;


export function initOptionDial(_b: AgentLink): void {
  // No bridge interaction required — refreshes ride fireUsageRefresh().
}

/** Called from plugin.ts when usage_update arrives. */
export function updateClaudeUsageDial(data: UsageModeData): void {
  updateUsageModeData(data);
  hasReceivedData = true;
  refreshClaudeUsageDials();
}

/** Called from plugin.ts on daemon connect/disconnect to redraw (offline banner). */
export function refreshClaudeUsageDial(): void {
  if (!isDaemonConnected()) hasReceivedData = false;
  refreshClaudeUsageDials();
}

function ensurePixmapLayout(): void {
  if (currentLayout === PIXMAP_LAYOUT) return;
  currentLayout = PIXMAP_LAYOUT;
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

function refreshClaudeUsageDials(): void {
  // `usage_update` ticks arrive continuously; without this the LCD would light
  // back up seconds after the host display slept.
  if (isDisplayDimmed()) return;
  if (encoderRegistry.optionIds.length === 0) return;
  ensurePixmapLayout();

  // Offline banner is highest priority and all-or-nothing across the 4 encoders.
  // Gate on real daemon-down, NOT a transient session-level state.
  if (!isDaemonConnected()) {
    setCanvasFeedback(renderOfflineTouchStrip(1));
    return;
  }

  setCanvasFeedback(renderClaudeUsageView());
}

/** Render the current dial-cycled view for the Claude usage encoder. */
function renderClaudeUsageView(): string {
  const data = getUsageModeData();
  const view: UsageView = USAGE_VIEWS[viewIndex];
  // Session view is shared token/cost text — show it regardless of quota note.
  if (view === 'session') return renderUsageSession(data);
  const enc = buildClaudeUsageEncoder(data, hasReceivedData);
  if (view === '5h') return renderUsageEncoderSingle(enc, '5h');
  if (view === '7d') return renderUsageEncoderSingle(enc, '7d');
  return renderUsageEncoderBoth(enc);
}

@action({ UUID: 'bound.serendipity.agentdeck.option-dial' })
export class ResponseDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.optionIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.optionIds.includes(ev.action.id)) {
      encoderRegistry.optionIds.push(ev.action.id);
    }
    currentLayout = PIXMAP_LAYOUT;
    // An encoder that appears while the host display is already asleep never
    // saw the sleep edge, so blank it here instead of drawing usage.
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    fireUsageRefresh();
    refreshClaudeUsageDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    // Rotation cycles the usage view (both → 5h → 7d → session).
    const dir = ev.payload.ticks >= 0 ? 1 : -1;
    viewIndex = (viewIndex + dir + USAGE_VIEWS.length) % USAGE_VIEWS.length;
    dlog('ClaudeUsageDial', `rotate → view=${USAGE_VIEWS[viewIndex]}`);
    refreshClaudeUsageDials();
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    // Push: pull fresh usage.
    fireUsageRefresh();
    dlog('ClaudeUsageDial', 'push: requesting usage refresh');
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
  }

  override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.optionIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.optionIds.splice(idx, 1);
    }
  }
}
