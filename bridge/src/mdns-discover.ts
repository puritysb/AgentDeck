/**
 * mDNS/Bonjour browser — the consume side of `mdns.ts` (which only publishes).
 *
 * Lets a session bridge find a daemon hub on the LAN the same way the iOS and
 * Android apps do: browse `_agentdeck._tcp`, read the TXT record, then confirm
 * each candidate with a `/health` GET (which also yields the pairing token when
 * the TXT omitted it). Mirrors `apple/AgentDeck/Net/BridgeDiscovery.swift`.
 *
 * Used only on the opt-in remote-attach path (`--remote-daemon`); the default
 * local-only flow never imports this module.
 */
import Bonjour from 'bonjour-service';
import { debug } from './logger.js';
import { probeHealthAt } from './session-registry.js';

export interface DiscoveredDaemon {
  host: string;
  port: number;
  token?: string;
  projectName?: string;
  /** Daemon advertises same-socket reverse control (always true for confirmed
   *  candidates — daemons without it are filtered during the /health confirm). */
  sameSocketControl?: boolean;
}

/** Reject addresses that can't be reached from another device. */
function isUsableAddress(addr: string): boolean {
  if (!addr) return false;
  if (addr.startsWith('127.') || addr === '::1') return false; // loopback
  if (addr.startsWith('169.254.')) return false;               // IPv4 link-local
  if (/^fe80:/i.test(addr)) return false;                      // IPv6 link-local
  return true;
}

/** Coerce a bonjour-service TXT value (string | Buffer | undefined) to string. */
function txtStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (v instanceof Buffer) return v.toString('utf-8');
  return String(v);
}

/**
 * Browse the LAN for AgentDeck daemons. Collects services for `timeoutMs`, then
 * confirms each via `/health` (keeps only `mode === 'daemon'`). A `hostHint`
 * floats a matching candidate to the front of the list.
 */
export async function discoverDaemons(opts?: { timeoutMs?: number; hostHint?: string }): Promise<DiscoveredDaemon[]> {
  const timeoutMs = opts?.timeoutMs ?? 2500;
  const instance = new Bonjour();
  // Dedup by host:port — the same daemon shows up on every interface.
  const candidates = new Map<string, { host: string; port: number; txtToken?: string; project?: string }>();

  try {
    await new Promise<void>((resolve) => {
      const browser = instance.find({ type: 'agentdeck' }, (service) => {
        try {
          const port = Number(txtStr(service.txt?.port)) || service.port;
          if (!port) return;
          const txtToken = txtStr(service.txt?.token);
          const project = txtStr(service.txt?.project);
          // Prefer a resolvable IP from the service addresses; fall back to the
          // TXT `ip` the daemon self-reported (may be stale, but better than nothing).
          const addrs = (service.addresses ?? []).filter(isUsableAddress);
          const ipv4 = addrs.find((a) => !a.includes(':'));
          const host = ipv4 ?? addrs[0] ?? txtStr(service.txt?.ip);
          if (!host || !isUsableAddress(host)) return;
          candidates.set(`${host}:${port}`, { host, port, txtToken, project });
        } catch (err) {
          debug('mDNS', `discover: bad service record ignored (${String(err)})`);
        }
      });
      const timer = setTimeout(() => {
        try { browser.stop(); } catch { /* ignore */ }
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });
  } finally {
    try { instance.destroy(); } catch { /* ignore */ }
  }

  // Confirm reachability + resolve token from /health (the daemon's pairingToken
  // is authoritative; the TXT token can lag a token rotation). Candidates that
  // don't advertise sameSocketControl (e.g. the Swift App Store daemon) are
  // dropped here: selecting one would register a remote session the daemon has
  // no control frames to drive — it must never be auto-selected.
  const confirmed: DiscoveredDaemon[] = [];
  await Promise.all([...candidates.values()].map(async (c) => {
    const health = await probeHealthAt(c.host, c.port);
    if (health?.mode !== 'daemon') return;
    if (health.sameSocketControl !== true) {
      debug('mDNS', `discover: ${c.host}:${c.port} lacks sameSocketControl — skipped`);
      return;
    }
    const token = typeof health.pairingToken === 'string' ? health.pairingToken : c.txtToken;
    confirmed.push({ host: c.host, port: c.port, token, projectName: c.project, sameSocketControl: true });
  }));

  // Float an explicit host hint to the front so callers can pin a node.
  if (opts?.hostHint) {
    confirmed.sort((a, b) => (a.host === opts.hostHint ? -1 : b.host === opts.hostHint ? 1 : 0));
  }
  debug('mDNS', `discover: ${confirmed.length} daemon(s) on LAN`);
  return confirmed;
}
