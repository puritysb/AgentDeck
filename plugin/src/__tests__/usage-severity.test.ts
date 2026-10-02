import { describe, expect, it } from 'vitest';
import { UI, renderUsageGauge as renderDeckGauge, renderLunaReserveTile } from '@agentdeck/shared';
import { renderUsageGauge, renderLunaReserveGauge, renderUsageEncoderBoth } from '../renderers/usage-gauge.js';

describe('identical quota severity on Stream Deck and Ulanzi', () => {
  it.each([[69, UI.ok], [70, UI.attn], [82, UI.attn], [89, UI.attn], [90, UI.error], [100, UI.error]])('%s%% uses the shared color on both keypads', (used, color) => {
    const data = { agent: 'codex' as const, window: '5h' as const, label: '5H', usedPercent: used };
    for (const svg of [renderUsageGauge(data), renderDeckGauge(data)]) {
      expect(svg).toContain(`fill="${color}" opacity="0.38"`);
      if (used === 82) expect(svg).not.toContain(`fill="${UI.error}"`);
    }
  });
  it('colors 18% remaining from 82% consumed on both keypads and the encoder', () => {
    const reserve = { usedPercent: 82, available: true };
    const encoder = renderUsageEncoderBoth({ agent: 'codex', title: 'CODEX', luna: reserve,
      fiveHour: { label: '5H', usedPercent: 100, known: true }, sevenDay: { label: '7D', usedPercent: 0, known: true } });
    for (const svg of [renderLunaReserveGauge(reserve), renderLunaReserveTile(reserve), encoder]) {
      expect(svg).toContain(`fill="${UI.attn}">18%<tspan`);
    }
  });
});
