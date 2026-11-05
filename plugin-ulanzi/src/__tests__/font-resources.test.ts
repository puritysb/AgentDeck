import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderOptionButton } from '@agentdeck/shared';

describe('portable controller fonts', () => {
  it('stages the canonical Korean face and license and renders distinct Korean decisions', async () => {
    const { koreanFonts, japaneseFonts, stageFonts } = await import(new URL('../../scripts/stage-fonts.mjs', import.meta.url).href);
    stageFonts();
    for (const name of [...koreanFonts, ...japaneseFonts]) {
      const source = new URL('../../../design/fonts/' + name, import.meta.url);
      const staged = new URL('../../com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/resources/fonts/' + name, import.meta.url);
      expect(readFileSync(staged).equals(readFileSync(source))).toBe(true);
    }
    const { initRaster, svgToPng } = await import('../raster.js');
    await initRaster();
    const render = (text: string) => svgToPng(renderOptionButton({ label: text, index: 0 }, 0), 144);
    expect(render('승인').equals(render('거절'))).toBe(false);
    // Kana must draw real glyphs, not the same tofu box for every character.
    expect(render('挨拶への返信').equals(render('こんにちは'))).toBe(false);
    expect(render('こんにちは').equals(render('さようなら'))).toBe(false);
  }, 20_000);
});
