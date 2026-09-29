import { usageSeverity } from '@agentdeck/shared';
/**
 * Unicode block gauge and density bar rendering.
 * Ports the E-ink blockGauge pattern to terminal.
 */

import { sgr, RESET } from './ansi.js';

/** Render a block gauge: [████░░░░░░] 62%. `muted` forces the dim (grey) fill
 *  regardless of percent for stale readings. An inactive model cap is cyan. */
export function blockGauge(percent: number, width: number, muted = false, inactive = false): string {
  const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  // Freshness outranks an inactive scoped cap; otherwise use shared severity.
  let color: string;
  if (muted || usageSeverity(percent) === 'unknown') color = sgr(90);               // unknown / stale
  else if (inactive) color = sgr(36);
  else if (usageSeverity(percent) === 'critical') color = sgr(31);  // red
  else if (usageSeverity(percent) === 'warning') color = sgr(33);  // yellow
  else color = sgr(32);                      // green

  return `${color}${'█'.repeat(filled)}${sgr(90)}${'░'.repeat(empty)}${RESET}`;
}

/** Format reset time: "↻1h23m" or "↻2d5h" */
export function resetTimeStr(isoDate?: string): string {
  if (!isoDate) return '';
  const diff = new Date(isoDate).getTime() - Date.now();
  if (diff <= 0) return '↻now';

  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `↻${days}d${hours % 24}h`;
  if (hours > 0) return `↻${hours}h${mins % 60}m`;
  return `↻${mins}m`;
}

/** Format uptime from seconds */
export function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

/** Format token count: 1234 → "1.2k", 12345 → "12k" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Activity density bar: recent events visualized as intensity blocks */
export function activityDensityBar(
  timestamps: number[],
  width: number,
  windowSec = 300,
): string {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const bucketMs = windowMs / width;
  const buckets = new Array<number>(width).fill(0);

  for (const ts of timestamps) {
    const age = now - ts;
    if (age < 0 || age > windowMs) continue;
    const idx = Math.min(width - 1, Math.floor((windowMs - age) / bucketMs));
    buckets[idx]++;
  }

  const maxCount = Math.max(1, ...buckets);
  const chars = '░▒▓█';

  let bar = '';
  for (const count of buckets) {
    if (count === 0) {
      bar += `${sgr(90)}░`;
    } else {
      const level = Math.min(3, Math.floor((count / maxCount) * 4));
      bar += `${sgr(36)}${chars[level]}`;
    }
  }
  return bar + RESET;
}
