/**
 * APME Hardware Sampler.
 *
 * Samples the machine's approximate resource state so the recommender can
 * factor in "is the Mac Studio free enough to run a local MLX judge right
 * now?" when ranking candidates.
 *
 * macOS-only for v1 — uses `sysctl`, `vm_stat`, and `sw_vers`. Anything that
 * needs elevated privileges (powermetrics, IOReport) is deliberately avoided.
 * On other platforms we return a minimal snapshot and callers fall back to
 * neutral behavior.
 */

import { execFileSync } from '../proc.js';
import { debug } from '../logger.js';

export interface HwSnapshot {
  platform: NodeJS.Platform;
  /** Total physical RAM in bytes, if available. */
  memTotal?: number;
  /** Resident RAM in use (active+wired+compressed) in bytes, if available. */
  memUsed?: number;
  /** Normalized CPU load (0..1) — 1-minute average divided by logical CPU count. */
  cpuLoad?: number;
  /** Logical CPU count. */
  cpuCount?: number;
  /** Hardware model, e.g. "Mac14,14" (Mac Studio M2 Max). */
  model?: string;
  timestamp: number;
}

function safeSysctl(key: string): string | null {
  try {
    return execFileSync('sysctl', ['-n', key], {
      encoding: 'utf-8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readMacMemory(): { total?: number; used?: number } {
  const total = safeSysctl('hw.memsize');
  let memTotal: number | undefined;
  if (total) {
    const n = Number(total);
    if (isFinite(n) && n > 0) memTotal = n;
  }

  let memUsed: number | undefined;
  try {
    const out = execFileSync('vm_stat', [], {
      encoding: 'utf-8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    // vm_stat prints "page size of N bytes" on the first line, then
    // "Pages active:   N." style lines.
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
    const pickPages = (label: string): number => {
      const re = new RegExp(`${label}:\\s+(\\d+)\\.?`);
      const m = out.match(re);
      return m ? parseInt(m[1], 10) : 0;
    };
    const active = pickPages('Pages active');
    const wired = pickPages('Pages wired down');
    const compressed = pickPages('Pages occupied by compressor');
    memUsed = (active + wired + compressed) * pageSize;
  } catch {
    /* ignore */
  }
  return { total: memTotal, used: memUsed };
}

function readMacCpu(): { load?: number; count?: number } {
  const count = safeSysctl('hw.logicalcpu');
  let cpuCount: number | undefined;
  if (count) {
    const n = Number(count);
    if (isFinite(n) && n > 0) cpuCount = n;
  }

  let cpuLoad: number | undefined;
  try {
    // `uptime` prints "... load averages: 1.23 1.45 1.67"
    const out = execFileSync('uptime', [], {
      encoding: 'utf-8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/load averages?:\s+([0-9.]+)/);
    if (m && cpuCount) {
      const load1 = parseFloat(m[1]);
      if (isFinite(load1) && load1 >= 0) {
        cpuLoad = Math.min(1, load1 / cpuCount);
      }
    }
  } catch {
    /* ignore */
  }
  return { load: cpuLoad, count: cpuCount };
}

export class ApmeHwSampler {
  async snapshot(): Promise<HwSnapshot> {
    const snap: HwSnapshot = { platform: process.platform, timestamp: Date.now() };
    if (process.platform !== 'darwin') return snap;
    try {
      const mem = readMacMemory();
      const cpu = readMacCpu();
      snap.memTotal = mem.total;
      snap.memUsed = mem.used;
      snap.cpuLoad = cpu.load;
      snap.cpuCount = cpu.count;
      const model = safeSysctl('hw.model');
      if (model) snap.model = model;
    } catch (err) {
      debug('APME', `hw-sampler failed: ${String(err)}`);
    }
    return snap;
  }
}
