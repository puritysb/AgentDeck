import { dotSurfaceSnapshot, type DotDeckSnapshot } from '@agentdeck/shared';

/** A static key must expire its report even when no new host frame arrives. */
export class DotExpiryRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly refresh: () => void) {}
  update(dot: DotDeckSnapshot | null | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const remaining = dot?.configured ? dotSurfaceSnapshot(dot).validForMs ?? 0 : 0;
    if (remaining <= 0) return;
    this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, remaining);
  }
}
