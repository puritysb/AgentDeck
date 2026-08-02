/**
 * E2 — Claude usage dial (Stream Deck+).
 *
 * This encoder shows the Claude subscription quota on its 200×100 LCD using the
 * full-bleed level-fill gauge. The dial ROTATION cycles between views: 'triple'
 * (5H + 7D + the worst per-model scoped cap side-by-side) → '5h' → '7d' → one
 * zoom view per scoped model → 'session'. The dial PRESS requests a usage
 * refresh. It never gets commandeered for option/permission selection — that interaction
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
import { renderUsageEncoderBoth, renderUsageEncoderSingle, renderUsageEncoderTriple, renderUsageEncoderScopedSingle, type UsageEncoderScoped } from '../renderers/usage-gauge.js';
import { renderUsageSession } from '../renderers/usage-dial-renderer.js';
import { type UsageModeData, updateUsageModeData, getUsageModeData, fireUsageRefresh, buildClaudeUsageEncoder, pickWorstScopedLimit } from '../utility-modes/usage.js';
import type { ScopedUsageLimit } from '@agentdeck/shared';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';
import { dlog } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../system/index.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

let currentLayout = '';
let hasReceivedData = false;
/** Dial-cycled view index for the Claude usage encoder (E2). */
let viewIndex = 0;

/** Scoped model limits are hidden while the snapshot is stale — a stale number
 *  reads as live. Mirrors buildClaudeUsageEncoder's staleness gate. */
function liveScopedLimits(data: UsageModeData): ScopedUsageLimit[] {
  return data.usageStale === true ? [] : (data.scopedLimits ?? []);
}

/** The dial-rotation view list, built dynamically: 'triple' default, the two
 *  single-window zooms, one zoom per live scoped model, then 'session'. */
function usageViews(data: UsageModeData): string[] {
  const views = ['triple', '5h', '7d'];
  liveScopedLimits(data).forEach((_, i) => views.push(`scoped:${i}`));
  views.push('session');
  return views;
}

function toEncScoped(s?: ScopedUsageLimit): UsageEncoderScoped | undefined {
  if (!s) return undefined;
  // A relayed/legacy limit may omit `active`; treat missing as NOT binding so an
  // inactive cap never latches the critical ramp (CLAUDE.md wire-flag rule).
  return { label: s.label, usedPercent: s.percent, resetsAt: s.resetsAt, known: true, active: s.active === true };
}


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
  const views = usageViews(data);
  // Data can shrink (a scoped limit expiring) between rotate and render — clamp
  // so a stale index never falls off the end of the list.
  if (viewIndex >= views.length) viewIndex = 0;
  const view = views[viewIndex];
  // Session view is shared token/cost text — show it regardless of quota note.
  if (view === 'session') return renderUsageSession(data);
  const enc = buildClaudeUsageEncoder(data, hasReceivedData);
  if (view === '5h') return renderUsageEncoderSingle(enc, '5h');
  if (view === '7d') return renderUsageEncoderSingle(enc, '7d');
  if (view.startsWith('scoped:')) {
    const i = parseInt(view.slice('scoped:'.length), 10);
    const s = toEncScoped(liveScopedLimits(data)[i]);
    return s ? renderUsageEncoderScopedSingle(enc, s) : renderUsageEncoderBoth(enc);
  }
  // 'triple' default: 5H + 7D + worst scoped cap. Falls back to the two-panel
  // 'both' view when there's no scoped model limit to headline.
  const worst = toEncScoped(pickWorstScopedLimit(data));
  return worst ? renderUsageEncoderTriple(enc, worst) : renderUsageEncoderBoth(enc);
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
    // Rotation cycles the usage view (triple → 5h → 7d → scoped… → session).
    const views = usageViews(getUsageModeData());
    const dir = ev.payload.ticks >= 0 ? 1 : -1;
    viewIndex = (viewIndex + dir + views.length) % views.length;
    dlog('ClaudeUsageDial', `rotate → view=${views[viewIndex]}`);
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
