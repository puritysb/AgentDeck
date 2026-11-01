import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderOptionButton } from '@agentdeck/shared';

describe('portable controller fonts', () => {
  it('stages the canonical Korean face and license and renders distinct Korean decisions', async () => {
    const { koreanFonts, stageFonts } = await import(new URL('../../scripts/stage-fonts.mjs', import.meta.url).href);
    stageFonts();
    for (const name of koreanFonts) {
      const source = new URL('../../../design/fonts/' + name, import.meta.url);
      const staged = new URL('../../com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/resources/fonts/' + name, import.meta.url);
      expect(readFileSync(staged)).toEqual(readFileSync(source));
    }
    const { initRaster, svgToPng } = await import('../raster.js');
    await initRaster();
    const render = (text: string) => svgToPng(renderOptionButton({ label: text, index: 0 }, 0), 144);
    expect(render('승인')).not.toEqual(render('거절'));
  }, 20_000);
});
