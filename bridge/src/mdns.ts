import Bonjour from 'bonjour-service';
import type { AgentType } from './types.js';
import { debug, log } from './logger.js';
import { getLanIp } from '@agentdeck/shared';

let instance: Bonjour | null = null;

const MDNS_RECOVERY_INTERVAL = 5_000; // 5s — tightens WiFi-change discovery gap (was 30s)

/**
 * True if an uncaught error is a non-fatal mDNS multicast failure that should be
 * tolerated (instance invalidated + recovery timer re-publishes) rather than
 * crashing the daemon.
 *
 * `bonjour-service` performs async `send()` to the mDNS multicast group
 * (224.0.0.251:5353 / ff02::fb:5353). On network-interface changes — sleep/wake,
 * WiFi reconnect, VPN toggle, or a WSL/Hyper-V virtual interface that has no route
 * to the multicast group (Windows) — that send rejects asynchronously and surfaces
 * as an uncaughtException. None of these are recoverable by crashing.
 *
 * Covers:
 * - "already in use on the network" (duplicate service name)
 * - bind/send failures targeting the mDNS endpoint: EADDRNOTAVAIL, EHOSTUNREACH,
 *   ENETUNREACH, EHOSTDOWN, ENETDOWN, EADDRINUSE, EPERM, EACCES, ENODEV
 */
export function isNonFatalMdnsError(msg: string, code?: string): boolean {
  if (msg.includes('already in use on the network')) return true;

  // Scope socket errors to the mDNS multicast endpoint so unrelated network
  // failures (e.g. EHOSTUNREACH to a peer) still crash as before.
  const targetsMdns =
    msg.includes('5353') || msg.includes('224.0.0.251') || msg.includes('ff02::fb');
  if (!targetsMdns) return false;

  const mdnsCodes = [
    'EADDRNOTAVAIL', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN',
    'ENETDOWN', 'EADDRINUSE', 'EPERM', 'EACCES', 'ENODEV',
  ];
  return mdnsCodes.some((c) => code === c || msg.includes(c));
}

/**
 * Called from uncaughtException handler when mDNS socket fails.
 * Nulls the instance so the recovery timer knows to re-publish.
 */
export function invalidateMdnsInstance(): void {
  if (instance) {
    try {
      instance.destroy();
    } catch { /* ignore */ }
    instance = null;
    debug('mDNS', 'Instance invalidated — recovery timer will re-publish');
  }
}

/** Trigger function, set by advertiseBridge() for immediate wake recovery. */
let _triggerRecovery: (() => void) | null = null;

/**
 * Force immediate mDNS re-publish (wake recovery).
 * Bypasses the 30s recovery timer interval.
 */
export function triggerMdnsRecovery(): void {
  _triggerRecovery?.();
}

/**
 * Advertise this bridge session via mDNS/Bonjour so Android/LAN clients
 * can discover it automatically.
 *
 * Includes automatic recovery: if the underlying mDNS socket fails (e.g. after
 * sleep/wake or WiFi reconnect), a periodic check detects the broken state and
 * re-publishes the service.
 *
 * @returns cleanup function to call on shutdown
 */
export function advertiseBridge(
  port: number,
  projectName: string,
  agentType: AgentType,
  token?: string,
): () => void {
  let stopped = false;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  let currentCleanup: (() => void) | null = null;

  function publish(): boolean {
    try {
      // Tear down previous instance if any
      if (instance) {
        try {
          instance.unpublishAll();
          instance.destroy();
        } catch { /* ignore cleanup errors */ }
        instance = null;
      }

      instance = new Bonjour();

      const lanIp = getLanIp();
      const txt: Record<string, string> = {
        project: projectName,
        agent: agentType,
        v: '1',
        port: String(port),
      };
      if (token) txt.token = token;
      if (lanIp) txt.ip = lanIp;

      const service = instance.publish({
        name: `${projectName}-${port}`,
        type: 'agentdeck',
        port,
        txt,
      });

      // Catch async publish errors — mDNS is non-critical
      service.on?.('error', (err: Error) => {
        debug('mDNS', `Service error (ignored): ${err.message}`);
      });

      debug('mDNS', `Published _agentdeck._tcp on port ${port} (project: ${projectName})`);

      currentCleanup = () => {
        try {
          service.stop?.();
          instance?.unpublishAll();
          instance?.destroy();
          instance = null;
        } catch (err) {
          debug('mDNS', `Cleanup error: ${err}`);
        }
      };

      return true;
    } catch (err) {
      debug('mDNS', `Failed to advertise: ${err}`);
      instance = null;
      currentCleanup = null;
      return false;
    }
  }

  // Track published IP to detect changes (DHCP renewal, interface switch)
  let publishedIp: string | undefined;

  function publishAndTrackIp(): boolean {
    publishedIp = getLanIp();
    return publish();
  }

  // Initial publish
  publishAndTrackIp();

  // Wire immediate recovery for wake handler
  _triggerRecovery = () => {
    if (stopped) return;
    const lanIp = getLanIp();
    if (!lanIp) return;
    log('[mDNS] Wake recovery — immediate re-publish');
    invalidateMdnsInstance();
    publishAndTrackIp();
  };

  // Periodic recovery: re-publish if instance lost OR IP changed
  recoveryTimer = setInterval(() => {
    if (stopped) return;
    const lanIp = getLanIp();
    if (!lanIp) {
      debug('mDNS', 'Recovery check: no LAN IP available');
      return;
    }
    if (!instance) {
      log('[mDNS] Network recovered — re-publishing service');
      publishAndTrackIp();
    } else if (lanIp !== publishedIp) {
      log(`[mDNS] IP changed (${publishedIp} → ${lanIp}) — re-publishing service`);
      publishAndTrackIp();
    }
  }, MDNS_RECOVERY_INTERVAL);

  return () => {
    stopped = true;
    _triggerRecovery = null;
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
    currentCleanup?.();
    currentCleanup = null;
  };
}
