import { describe, expect, it, vi } from 'vitest';
import { RasterRecovery, RASTER_RETRY_MS } from '../raster-recovery.js';

/** #730 finding 2: a failed raster must lead to a repaint, not a permanent blank key. */
function harness(opts: { ready?: boolean } = {}) {
  let failures = 0;
  let ready = opts.ready ?? true;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const repaint = vi.fn();
  const init = vi.fn(async () => { ready = true; });
  const rec = new RasterRecovery({
    failureCount: () => failures,
    ready: () => ready,
    init,
    repaint,
    log: () => {},
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  const pass = (fail: number) => { const b = rec.before(); failures += fail; rec.after(b); };
  const fire = async () => { const t = timers.shift()!; t.fn(); await Promise.resolve(); await Promise.resolve(); return t.ms; };
  return { rec, pass, fire, timers, repaint, init };
}

describe('RasterRecovery', () => {
  it('a clean pass schedules nothing', () => {
    const h = harness();
    h.pass(0);
    expect(h.timers).toHaveLength(0);
  });

  it('a failed pass repaints after a delay, reloading WASM if it never loaded', async () => {
    const h = harness({ ready: false });
    h.pass(3);
    expect(h.rec.pending()).toBe(true);
    expect(await h.fire()).toBe(RASTER_RETRY_MS[0]);
    expect(h.init).toHaveBeenCalledTimes(1);
    expect(h.repaint).toHaveBeenCalledTimes(1);
    expect(h.rec.pending()).toBe(false);
  });

  it('does not reload WASM that is already loaded (per-SVG failure)', async () => {
    const h = harness({ ready: true });
    h.pass(1);
    await h.fire();
    expect(h.init).not.toHaveBeenCalled();
    expect(h.repaint).toHaveBeenCalledTimes(1);
  });

  it('coalesces failures while a retry is pending, backs off, and resets after a clean pass', async () => {
    const h = harness();
    h.pass(1);
    h.pass(1);
    expect(h.timers).toHaveLength(1);
    const delays: number[] = [];
    for (let i = 0; i < RASTER_RETRY_MS.length + 1; i++) { delays.push(await h.fire()); h.pass(1); }
    expect(delays).toEqual([...RASTER_RETRY_MS, RASTER_RETRY_MS.at(-1)]);
    await h.fire();
    h.pass(0);
    h.pass(1);
    expect(await h.fire()).toBe(RASTER_RETRY_MS[0]);
  });
});
