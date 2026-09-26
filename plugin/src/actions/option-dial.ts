/**
 * E2 usage dial: tap to select a provider, rotate to select its view, press
 * to refresh. Hold the touchscreen to resume activity-driven selection.
 * Explicit choices take precedence; a collision moves the peer dial.
 * The option-dial UUID remains stable for installed profiles.
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
  DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import type { JsonValue } from '@elgato/utils';
import type { AgentLink } from '../agent-link.js';
import { encoderRegistry, isDaemonConnected } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import {
  renderUsageEncoderBoth,
  renderUsageEncoderSingle,
  renderUsageEncoderTriple,
  renderUsageEncoderScopedSingle,
  type UsageEncoderScoped,
} from '../renderers/usage-gauge.js';
import { renderUsageSession } from '../renderers/usage-dial-renderer.js';
import {
  type UsageModeData,
  type UsageProviderId,
  updateUsageModeData,
  getUsageModeData,
  fireUsageRefresh,
  buildProviderUsageEncoder,
  availableUsageViews,
  getUsageDialSelections,
  availableUsageProviders,
  resolveE2UsageProvider,
  selectUsageDialProvider,
  resetE2UsageProvider,
  onUsageDialSelectionChanged,
  pickWorstScopedLimit,
} from '../utility-modes/usage.js';
import type { ScopedUsageLimit } from '@agentdeck/shared';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';
import { dlog } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../system/index.js';
import { PerActionViewState } from './per-action-view-state.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

let currentLayout = '';
let hasReceivedData = false;

interface ClaudeUsageDialSettings {
  [key: string]: JsonValue;
  usageView?: string;
}

/** Per-action Claude usage view. Each physical dial persists independently. */
const claudeUsageViews = new PerActionViewState('triple');

/** Scoped model limits are hidden while the snapshot is stale — a stale number
 *  reads as live. Mirrors buildClaudeUsageEncoder's staleness gate. */
function liveScopedLimits(data: UsageModeData, provider: UsageProviderId): ScopedUsageLimit[] {
  if (provider !== 'claude') return [];
  return data.usageStale === true ? [] : (data.scopedLimits ?? []);
}

/** Resolve a user-pinned provider, or follow activity while E2 is automatic. */
function autoProvider(data: UsageModeData): UsageProviderId {
  return resolveE2UsageProvider(data);
}

/** The dial-rotation view list, built dynamically: 'triple' default, the two
 *  single-window zooms, one zoom per live scoped model, then 'session'. */
function usageViews(data: UsageModeData, provider: UsageProviderId): string[] {
  const views: string[] = availableUsageViews(buildProviderUsageEncoder(provider, data, hasReceivedData))
    .filter((view) => view !== 'session').map((view) => view === 'both' ? 'triple' : view);
  liveScopedLimits(data, provider).forEach((_, i) => views.push(`scoped:${i}`));
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
  onUsageDialSelectionChanged(refreshClaudeUsageDials);
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

  const data = getUsageModeData();
  for (const id of encoderRegistry.optionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (!dial) continue;
    const feedback = { canvas: svgToDataUrl(renderClaudeUsageView(id, data)) };
    void dial.setFeedback(feedback).catch(() => {});
  }
}

/** Render the independently selected view for one usage encoder (E2 shows the
 *  auto-selected provider's page; scoped-cap views exist only on the Claude
 *  page). */
function renderClaudeUsageView(actionId: string, data: UsageModeData = getUsageModeData()): string {
  const provider = autoProvider(data);
  const views = usageViews(data, provider);
  // A scoped view can disappear when its limit expires. Render the default until
  // the user rotates again, without changing any other dial's selection.
  const view = claudeUsageViews.resolve(actionId, views);
  // Session view is shared token/cost text — show it regardless of quota note.
  if (view === 'session') return renderUsageSession(data);
  const enc = buildProviderUsageEncoder(provider, data, hasReceivedData);
  if (view === '5h') return renderUsageEncoderSingle(enc, '5h');
  if (view === '7d') return renderUsageEncoderSingle(enc, '7d');
  if (view.startsWith('scoped:')) {
    const i = parseInt(view.slice('scoped:'.length), 10);
    const s = toEncScoped(liveScopedLimits(data, provider)[i]);
    return s ? renderUsageEncoderScopedSingle(enc, s) : renderUsageEncoderBoth(enc);
  }
  // 'triple' default: 5H + 7D + worst scoped cap (Claude page only). Falls back
  // to the two-panel 'both' view when there's no scoped model limit to headline.
  const worst = toEncScoped(pickWorstScopedLimit(data));
  return worst && provider === 'claude' ? renderUsageEncoderTriple(enc, worst) : renderUsageEncoderBoth(enc);
}

@action({ UUID: 'bound.serendipity.agentdeck.option-dial' })
export class ResponseDialAction extends SingletonAction {
  static get actionIds(): string[] {
    return encoderRegistry.optionIds;
  }

  override async onWillAppear(ev: WillAppearEvent<ClaudeUsageDialSettings>): Promise<void> {
    if (!encoderRegistry.optionIds.includes(ev.action.id)) {
      encoderRegistry.optionIds.push(ev.action.id);
    }
    const savedView = ev.payload?.settings?.usageView;
    claudeUsageViews.load(ev.action.id, savedView);
    currentLayout = PIXMAP_LAYOUT;
    // An encoder that appears while the host display is already asleep never
    // saw the sleep edge, so blank it here instead of drawing usage.
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    fireUsageRefresh();
    refreshClaudeUsageDials();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ClaudeUsageDialSettings>): void {
    const savedView = ev.payload.settings.usageView;
    claudeUsageViews.load(ev.action.id, savedView);
    refreshClaudeUsageDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    // Rotation changes only this physical dial and persists its view.
    const views = usageViews(getUsageModeData(), autoProvider(getUsageModeData()));
    const nextView = claudeUsageViews.rotate(ev.action.id, views, ev.payload.ticks);
    void ev.action.setSettings({ ...(ev.payload?.settings ?? {}), usageView: nextView }).catch(() => {});
    dlog('ClaudeUsageDial', `rotate → view=${nextView}`);
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

  override async onDialUp(_ev: DialUpEvent): Promise<void> {}

  override async onTouchTap(ev: TouchTapEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    const data = getUsageModeData();
    if (ev.payload.hold) { resetE2UsageProvider(data); return; }
    const available = availableUsageProviders(data);
    if (!available.length) return;
    const current = autoProvider(data);
    selectUsageDialProvider('e2', available[(available.indexOf(current) + 1) % available.length], data);
    refreshClaudeUsageDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.optionIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.optionIds.splice(idx, 1);
    }
    claudeUsageViews.remove(ev.action.id);
  }
}
