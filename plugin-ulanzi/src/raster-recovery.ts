/**
 * Repaint after a raster failure (#730).
 *
 * A failed raster pushes the blank tile, and the per-key signature then records
 * that key as painted, so nothing would ever draw it again. After a render pass
 * that produced any blank fallback, this schedules one bounded retry: reload the
 * WASM module if it never loaded, then invalidate every key and render again. The
 * delay backs off while failures continue and resets after a clean pass, so a
 * permanently broken bundle logs at most once per `RASTER_RETRY_MS` ceiling.
 */
export const RASTER_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface RasterRecoveryDeps {
  failureCount: () => number;
  ready: () => boolean;
  init: () => Promise<void>;
  /** Invalidate every pushed tile and schedule a full render. */
  repaint: () => void;
  log: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export class RasterRecovery {
  private timer: unknown = null;
  private attempt = 0;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  constructor(private readonly deps: RasterRecoveryDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Snapshot before a render pass; pass the result to `after`. */
  before(): number {
    return this.deps.failureCount();
  }

  after(failuresBefore: number): void {
    if (this.deps.failureCount() === failuresBefore) {
      if (this.timer == null) this.attempt = 0;
      return;
    }
    if (this.timer != null) return;
    const delay = RASTER_RETRY_MS[Math.min(this.attempt, RASTER_RETRY_MS.length - 1)];
    this.attempt++;
    this.deps.log(`key image raster failed — repainting in ${delay}ms (attempt ${this.attempt})`);
    this.timer = this.setTimer(() => { void this.retry(); }, delay);
  }

  /** @internal exposed for tests. */
  pending(): boolean {
    return this.timer != null;
  }

  private async retry(): Promise<void> {
    try {
      if (!this.deps.ready()) await this.deps.init();
    } finally {
      this.timer = null;
      this.deps.repaint();
    }
  }
}
