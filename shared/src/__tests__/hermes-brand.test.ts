import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HERMES_BRAND_PATHS } from '../svg-renderers/hermes-brand.js';
import { agentLogoIcon, agentLogoWatermark, agentGlyphMono } from '../svg-renderers/agent-logos.js';

describe('Hermes upstream brand fidelity', () => {
  it('preserves all upstream paths, including face negative space', () => {
    const svg = readFileSync(new URL('../../../design/brand/hermes.svg', import.meta.url), 'utf8');
    expect(HERMES_BRAND_PATHS).toEqual([...svg.matchAll(/\bd="([^"]+)"/g)].map(m => m[1]));
    for (const rendered of [agentLogoIcon('hermes'), agentLogoWatermark('hermes'), agentGlyphMono('hermes', 12, 12, 24, 'black', 'white')]) {
      for (const path of HERMES_BRAND_PATHS) expect(rendered).toContain(`d="${path}"`);
      expect(rendered).toContain('fill-rule="evenodd"');
    }
    expect(agentLogoIcon('hermes')).not.toEqual(agentLogoIcon('openclaw'));
  });
});
