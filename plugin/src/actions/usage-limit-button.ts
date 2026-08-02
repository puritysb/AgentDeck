/**
 * "Claude Limit" keypad button.
 *
 * A dedicated key that surfaces the worst per-model scoped Claude cap (e.g. the
 * weekly "Fable" limit at 98%) — the number that actually binds when the
 * account-wide 5H/7D windows still read low. "Worst" is active-first then
 * percent-desc, so an ACTIVE cap always headlines over an inactive one; when only
 * inactive caps exist the highest is still shown, muted rather than
 * alarming. Press requests a usage refresh
 * (offline → open the AgentDeck app). Shares the usage store with the E2 encoder
 * and renders the 144×144 level-fill limit gauge. Placeable on any keypad key.
 */
import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderUsageLimitGauge, type UsageEncoderScoped } from '../renderers/usage-gauge.js';
import { getUsageModeData, fireUsageRefresh, pickWorstScopedLimit, type UsageModeData } from '../utility-modes/usage.js';
import { isDaemonConnected } from '../encoder-registry.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../system/index.js';
import { dlog } from '../log.js';

/** Live Claude Limit key instance IDs (usually one, but the SDK allows many). */
const actionIds: string[] = [];

function worstScoped(data: UsageModeData): UsageEncoderScoped | undefined {
  const s = pickWorstScopedLimit(data);
  // Missing `active` (relayed/legacy) → NOT binding, so an inactive cap renders
  // muted rather than latching the critical ramp (CLAUDE.md wire-flag rule).
  return s ? { label: s.label, usedPercent: s.percent, resetsAt: s.resetsAt, known: true, active: s.active === true } : undefined;
}

function renderLimitButton(): string {
  return renderUsageLimitGauge(worstScoped(getUsageModeData()));
}

function paint(): void {
  // Usage ticks arrive continuously — don't relight a slept host display.
  if (isDisplayDimmed()) return;
  if (actionIds.length === 0) return;
  const svg = renderLimitButton();
  for (const id of actionIds) {
    const a = streamDeck.actions.getActionById(id) as { setImage?: (s: string) => Promise<void> } | undefined;
    if (a?.setImage) void a.setImage(svgToDataUrl(svg)).catch(() => {});
  }
}

/** Called from plugin.ts on usage_update. */
export function updateUsageLimitButtons(_data: UsageModeData): void {
  paint();
}

/** Called from plugin.ts on daemon connect/disconnect and on display wake. */
export function refreshUsageLimitButtons(): void {
  paint();
}

@action({ UUID: 'bound.serendipity.agentdeck.limit-key' })
export class UsageLimitButtonAction extends SingletonAction {
  static get actionIds(): string[] { return actionIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!actionIds.includes(ev.action.id)) actionIds.push(ev.action.id);
    // A key that appears while the host display is asleep never saw the sleep
    // edge — blank it here instead of drawing the gauge.
    if (dimActionIfNeeded(ev.action, 'Keypad')) return;
    await ev.action.setImage(svgToDataUrl(renderLimitButton()));
  }

  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    fireUsageRefresh();
    dlog('LimitKey', 'push: requesting usage refresh');
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
  }
}
