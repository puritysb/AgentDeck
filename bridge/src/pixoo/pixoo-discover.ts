/**
 * Daemon-side auto-discovery for Divoom Pixoo64 (WiFi, no mDNS).
 *
 * Pixoo devices don't advertise over mDNS, so a fresh install otherwise needs
 * the user to type the device IP. This adds zero-config discovery: when no Pixoo
 * is configured we (1) try the Divoom cloud "same-LAN" API (fast when
 * reachable) and (2) fall back to a bounded, concurrency-limited local /24
 * subnet sweep that probes each host's `Channel/GetAllConf` endpoint. The sweep
 * uses only local HTTP (`URLSession`/`http` equivalent), so the same approach is
 * App-Store-safe when mirrored in the Swift daemon — no external service, no
 * subprocess.
 *
 * Auto-add only happens when zero devices are configured (avoid grabbing a
 * neighbour's frame on a shared LAN) and `pixooAutoDiscover` isn't disabled.
 */

import { networkInterfaces } from 'os';
import { getDeviceConfig, discoverDevices } from './pixoo-client.js';
import { addDevice, isPixooAutoDiscoverEnabled, loadPixooDevices } from './pixoo-settings.js';

export interface DiscoveredPixoo {
  name: string;
  ip: string;
}

/**
 * A `Channel/GetAllConf` reply from a real Pixoo carries display config fields
 * (`Brightness`, channel indices, etc). A random HTTP server on :80 returns
 * different JSON (or none), so the presence of `Brightness` is a reliable
 * Pixoo signal. Exported pure for unit testing.
 */
export function isPixooConfigReply(obj: unknown): boolean {
  return !!obj && typeof obj === 'object' && 'Brightness' in (obj as Record<string, unknown>);
}

/** Local non-internal IPv4 /24 subnets, with this host's address to skip. */
function localIpv4Subnets(): Array<{ base: string; self: string }> {
  const out: Array<{ base: string; self: string }> = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      // Node <18 exposes family as 'IPv4'; >=18 may expose 4. Accept both.
      const isV4 = ni.family === 'IPv4' || (ni.family as unknown as number) === 4;
      if (!isV4 || ni.internal) continue;
      const parts = ni.address.split('.');
      if (parts.length !== 4) continue;
      const base = parts.slice(0, 3).join('.');
      if (!out.some((s) => s.base === base)) out.push({ base, self: ni.address });
    }
  }
  return out;
}

/** Probe every host in a /24, `concurrency` at a time, with a short per-host timeout. */
async function sweepSubnet(
  base: string,
  self: string,
  concurrency: number,
  perHostTimeoutMs: number,
): Promise<DiscoveredPixoo[]> {
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${base}.${i}`;
    if (ip !== self) hosts.push(ip);
  }
  const found: DiscoveredPixoo[] = [];
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < hosts.length) {
      const ip = hosts[idx++];
      const conf = await getDeviceConfig(ip, perHostTimeoutMs);
      if (isPixooConfigReply(conf)) found.push({ name: 'Pixoo64', ip });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

/**
 * Discover Pixoo devices: cloud API first, local subnet sweep as fallback.
 * Never throws — returns [] when nothing is found / reachable.
 *
 * `cloud: false` skips the Divoom lookup and sweeps only. The two steps are
 * different disclosures — one is egress to a third party, the other is traffic
 * that stays on the segment — so a caller on a corporate network can take the
 * second without the first.
 */
export async function discoverPixoo(opts: { cloud?: boolean } = {}): Promise<DiscoveredPixoo[]> {
  if (opts.cloud !== false) {
    try {
      const cloud = await discoverDevices();
      if (cloud.length > 0) return cloud.filter((d) => !!d.ip);
    } catch {
      /* cloud unreachable — fall through to local sweep */
    }
  }
  const out: DiscoveredPixoo[] = [];
  for (const { base, self } of localIpv4Subnets()) {
    out.push(...(await sweepSubnet(base, self, 40, 600)));
  }
  return out;
}

/**
 * Discover Pixoo devices and add them to settings.
 * @returns number of newly-added devices.
 */
export async function autoDiscoverPixoo(): Promise<number> {
  if (!isPixooAutoDiscoverEnabled()) return 0;
  if (loadPixooDevices().length > 0) return 0; // only when nothing configured

  const devices = await discoverPixoo();
  let count = 0;
  for (const d of devices) {
    if (addDevice({ ip: d.ip, name: d.name })) count++;
  }
  return count;
}
