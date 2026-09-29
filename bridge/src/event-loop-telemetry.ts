import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

/**
 * Event-loop delay telemetry for the daemon's /health.
 *
 * #327 recorded a daemon whose /health went unanswered for 5–15 s under host
 * load while the pid and the 9120 listener stayed alive — and the only way
 * anyone could tell "the loop was blocked" from "the process was gone" was a
 * native sample taken later. This surfaces the blocked-loop fact on the health
 * route itself: the Apple app's takeover decision, the CLI's suspend calls and
 * any post-incident diagnosis all get the same number.
 *
 * Lazy on purpose: the monitor starts on the first sample call, so importing
 * this module (or running the CLI) costs nothing until /health is served.
 */

let histogram: IntervalHistogram | null = null;
let startedAtMs = 0;

function ensureRunning(): IntervalHistogram {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    startedAtMs = Date.now();
  }
  return histogram;
}

export interface EventLoopDelaySnapshot {
  /** Median loop delay since the previous read (or boot). */
  p50Ms: number;
  /** 99th percentile loop delay in the same window. */
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  /** Length of the measurement window; 0 on the very first read. */
  windowMs: number;
}

/**
 * Read (and reset) the rolling delay snapshot. Reading resets the histogram,
 * so each caller sees the delay since the previous /health read — a health
 * poller therefore gets per-poll latency, not a lifetime maximum that only
 * grows. If two readers race, the loser sees an empty window, which reads as
 * low delay for one poll — acceptable for a diagnostic field.
 */
export function sampleEventLoopDelay(): EventLoopDelaySnapshot {
  const h = ensureRunning();
  const snapshot: EventLoopDelaySnapshot = {
    p50Ms: h.percentile(50) / 1e6,
    p99Ms: h.percentile(99) / 1e6,
    maxMs: h.max / 1e6,
    meanMs: h.mean / 1e6,
    windowMs: startedAtMs ? Date.now() - startedAtMs : 0,
  };
  h.reset();
  startedAtMs = Date.now();
  return snapshot;
}

/** Test seam: drop the monitor so a fresh one starts on the next sample. */
export function __resetEventLoopTelemetryForTest(): void {
  histogram?.disable();
  histogram = null;
  startedAtMs = 0;
}
