/**
 * One keypad slot config → its key SVG. Pure: the animation frame, each
 * session's phase start, the stale flag and the focused detail state come in
 * as arguments, so the Stream Deck action and the Elgato Marketplace generator
 * draw the same keys from the same function.
 */
import { renderUsagePairGauge, type State } from '@agentdeck/shared';
import type { DeckLayout, SessionSlotConfig } from '../session-slot-manager.js';
import {
  renderSessionSlot,
  renderEmptySlot,
  renderBackButton,
  renderNextPageButton,
  renderEscButton,
  renderStopButton,
  renderOptionButton,
  renderPresetButton,
} from './session-slot-renderer.js';
import { renderUsageGauge } from './usage-gauge.js';
import { renderStatusReadout, renderSessionReadout } from './display-tile.js';
import { usesLowResolutionKeyProfile } from '../device-profile.js';

export interface SlotRenderEnv {
  animFrame: number;
  /** Frame at which this session entered its animated state (keeps each key's own phase). */
  processingStartFrame?: (sessionId: string) => number | undefined;
  isStale: boolean;
  layout?: DeckLayout;
  detail: { state: State; modelName?: string; effortLevel?: string };
}

export function renderSlotConfig(config: SessionSlotConfig, env: SlotRenderEnv): string {
  const layout = env.layout;
  switch (config.type) {
    case 'session': {
      const sess = config.session!;
      return renderSessionSlot(sess, false, env.animFrame, undefined, {
        processingStartFrame: env.processingStartFrame?.(sess.id),
        isStale: env.isStale,
        lowResolutionKey: layout != null
          && usesLowResolutionKeyProfile(layout.family, layout.columns, layout.rows),
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
          env.detail.state,
          env.detail.modelName ?? config.session.modelName,
          config.label,
          env.detail.effortLevel ?? config.session.effortLevel,
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

    case 'usage': {
      const rows = config.usageWeekly?.map(g => ({ ...g, usedPercent: g.percent }));
      if (rows?.length === 2) return renderUsagePairGauge('claude', [rows[0], rows[1]]);
      if (rows?.length === 1) return renderUsageGauge(rows[0]);
      return renderUsageGauge({
        agent: config.usageAgent ?? 'claude',
        window: config.usageWindow ?? '5h',
        label: config.usageLabel ?? '',
        usedPercent: config.usagePercent ?? 0,
        resetsAt: config.usageResetsAt,
        known: config.usageKnown !== false,
        footnote: config.usageFootnote,
        inactive: config.usageInactive === true,
        luna: config.usageLuna,
      });

    }
    case 'usage-page':
      return renderNextPageButton(config.label ?? '');

    case 'empty':
    default:
      return renderEmptySlot();
  }
}
