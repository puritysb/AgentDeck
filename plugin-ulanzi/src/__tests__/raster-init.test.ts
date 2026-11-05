import { describe, expect, it } from 'vitest';
import { initRaster, rasterReady, rasterFailureCount, svgToBase64Png } from '../raster.js';

/**
 * #730 finding 2, against the real WASM raster: a failed initialization used to
 * be memoized as done, and a failed raster was cached as that SVG's image.
 */
const BLANK = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TILE = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#123"/></svg>';

describe('raster initialization and failure caching', () => {
  it('a failed load is retried by the next call instead of staying blank', async () => {
    await initRaster(() => { throw new Error('resvg.wasm not found'); });
    expect(rasterReady()).toBe(false);
    const before = rasterFailureCount();
    expect(svgToBase64Png(TILE)).toBe(BLANK);
    expect(rasterFailureCount()).toBe(before + 1);

    await initRaster();
    expect(rasterReady()).toBe(true);
    // The blank produced before the load was not cached for this SVG.
    expect(svgToBase64Png(TILE)).not.toBe(BLANK);
  });

  it('a failing SVG is re-rasterized on every call, never served from the cache', async () => {
    await initRaster();
    const before = rasterFailureCount();
    expect(svgToBase64Png('<svg')).toBe(BLANK);
    expect(svgToBase64Png('<svg')).toBe(BLANK);
    expect(rasterFailureCount()).toBe(before + 2);
  });
});
