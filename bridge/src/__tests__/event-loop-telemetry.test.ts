import { describe, expect, it } from 'vitest';
import {
  sampleEventLoopDelay,
  __resetEventLoopTelemetryForTest,
} from '../event-loop-telemetry.js';

describe('event-loop delay telemetry (#327)', () => {
  it('reports a sane snapshot and resets the window per read', async () => {
    __resetEventLoopTelemetryForTest();
    const first = sampleEventLoopDelay();
    // A quiet loop must read as quiet — the field exists to separate
    // "loop blocked" from "process gone", so a phantom 5 s reading on an
    // idle machine would be worse than no field at all.
    expect(first.p50Ms).toBeLessThan(100);
    expect(first.maxMs).toBeLessThan(2_000);

    // Blocking the loop for ~150ms must be visible in the next window. The
    // monitor's timer runs at the 20ms resolution, so the test yields ≥30ms
    // on both sides of the spin: a shorter pre-spin yield can leave the timer
    // between arms and the late fire goes unrecorded.
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    while (Date.now() - t0 < 150) { /* spin */ }
    await new Promise((r) => setTimeout(r, 30));
    const second = sampleEventLoopDelay();
    expect(second.maxMs).toBeGreaterThanOrEqual(100);

    // And the read resets: the third window does not carry the old spike.
    await new Promise((r) => setTimeout(r, 30));
    const third = sampleEventLoopDelay();
    expect(third.maxMs).toBeLessThan(second.maxMs);
    __resetEventLoopTelemetryForTest();
  });
});
