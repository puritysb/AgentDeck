import dgram from 'node:dgram';
import type { AgentType } from './types.js';
import { debug, log } from './logger.js';
import { getLanIp } from '@agentdeck/shared';

/**
 * UDP broadcast fallback for daemon discovery.
 *
 * mDNS multicast (224.0.0.251:5353) is frequently filtered by home routers —
 * AP Isolation, IGMP Snooping without multicast enhancement, mesh/satellite
 * hops, and 5GHz-only segments all silently drop the multicast group traffic.
 * When that happens, the ESP32 dashboard sits in "discovering daemon" forever
 * because its MDNS.queryService() calls never receive an answer.
 *
 * This broadcaster sends a small JSON beacon to the subnet broadcast address
 * (and 255.255.255.255 as a fallback) on UDP port 9121 every 2 seconds.
 * Subnet broadcast is unicast-friendly IGMP-wise and is forwarded by every
 * WiFi AP we have seen, so the device's UDP listener picks it up even when
 * mDNS is blocked. The beacon contains discovery metadata only (ip / port /
 * project / agent) plus `authRequired`, matching the unauthenticated /health
 * semantics: discovery says "a daemon is here and pairing is required" and
 * nothing more. It must never contain the pairing token: UDP broadcast is
 * visible to every peer on the segment, just like multicast mDNS. A client
 * must already hold a token obtained through explicit pairing/provisioning.
 */

const UDP_DISCOVERY_PORT = 9121;
const UDP_BROADCAST_INTERVAL_MS = 2_000;
const UDP_INITIAL_DELAY_MS = 500; // let the socket finish binding before first send

/** Compute the /24 subnet broadcast address (e.g. 192.168.1.42 → 192.168.1.255). */
function computeSubnetBroadcast(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.255`;
}

export function advertiseUdpBroadcast(
  port: number,
  projectName: string,
  agentType: AgentType,
): () => void {
  let stopped = false;
  let socket: dgram.Socket | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err: Error) => {
      debug('broadcast', `socket error (ignored): ${err.message}`);
    });
    socket.on('message', () => {
      // We never read inbound traffic on this socket — opening it for send only.
      // Messages from other broadcasters on the same segment are dropped silently.
    });
    socket.bind(() => {
      try {
        socket?.setBroadcast(true);
      } catch (err) {
        debug('broadcast', `setBroadcast failed: ${err}`);
      }
    });
  } catch (err) {
    debug('broadcast', `failed to open UDP socket: ${err}`);
    socket = null;
  }

  const sendOnce = (): void => {
    if (stopped || !socket) return;
    const lanIp = getLanIp();
    if (!lanIp || lanIp === '127.0.0.1') {
      return;
    }

    const payload = {
      v: 1,
      ip: lanIp,
      port,
      project: projectName,
      agent: agentType,
      // Same signal the unauthenticated /health carries: tells a client to
      // open its pairing flow instead of expecting a self-serve credential.
      authRequired: true,
    };
    const buf = Buffer.from(JSON.stringify(payload));

    // Limited broadcast — accepted by every AP, never routed across subnets.
    // This is the primary path when IGMP Snooping drops multicast.
    socket.send(buf, UDP_DISCOVERY_PORT, '255.255.255.255', (err) => {
      if (err) debug('broadcast', `limited-broadcast send failed: ${err.message}`);
    });

    // Subnet broadcast — explicit <prefix>.255. Redundant on most APs but a
    // couple of consumer routers (some TP-Link firmware revs) silently drop
    // 255.255.255.255 while still forwarding subnet-direct broadcasts.
    const subnet = computeSubnetBroadcast(lanIp);
    if (subnet) {
      socket.send(buf, UDP_DISCOVERY_PORT, subnet, (err) => {
        if (err) debug('broadcast', `subnet-broadcast send failed: ${err.message}`);
      });
    }
  };

  log(`[broadcast] UDP discovery beacon on port ${UDP_DISCOVERY_PORT} (project: ${projectName})`);
  initialTimer = setTimeout(sendOnce, UDP_INITIAL_DELAY_MS);
  timer = setInterval(sendOnce, UDP_BROADCAST_INTERVAL_MS);

  return () => {
    stopped = true;
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore close errors during shutdown */
      }
      socket = null;
    }
  };
}
