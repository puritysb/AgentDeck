import { PAIRING_CREDENTIALS, parsePairingRetirement } from '@agentdeck/shared';
import { localPeerOwnership } from './auth.js';
import { readDaemonInfo, findDaemonPort, probeDaemonHealth } from './session-registry.js';
import { isValidDaemonPort, resolveDaemonPort } from './daemon-port.js';

/** Rotate the actual owner, never an inactive on-disk profile. No retries on a
 * lost response: a rotation may have committed, so the next action is readback. */
export async function rotateActivePairingToken(): Promise<void> {
  const info = readDaemonInfo();
  const candidate = info?.httpPort ?? info?.port ?? findDaemonPort() ?? resolveDaemonPort({}).port;
  if (!isValidDaemonPort(candidate)) throw new Error('Invalid active daemon port; pairing credentials were not changed.');
  // daemon.json is untyped input. Convert only after the canonical port guard;
  // no file-supplied string can become URL authority or a request destination.
  const port = Number(candidate);
  const health = await probeDaemonHealth(port);
  if (health?.mode !== 'daemon') throw new Error('No confirmed active daemon; pairing credentials were not changed. Start your daemon and retry.');
  if (localPeerOwnership(health.pid) !== 'same-user') throw new Error('Cannot confirm that the active daemon belongs to this user; pairing credentials were not changed.');
  if (health.pairingRotation !== true || !parsePairingRetirement(health.pairingRetirement)) {
    throw new Error('The active daemon does not support active-owner token retirement. Update that daemon before rotating; no inactive-profile token was changed.');
  }
  const minimumRevision = parsePairingRetirement(health.pairingRetirement)!.revision;
  const response = await fetch(`http://127.0.0.1:${port}/pair/rotate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true, minimumRevision }), signal: AbortSignal.timeout(PAIRING_CREDENTIALS.timeoutMs),
    redirect: 'error',
  });
  if (response.status !== 200) throw new Error('Owner rotation was not confirmed. Read owner state before retrying; no inactive-profile fallback was used.');
  const result = await response.json() as Record<string, unknown>;
  const retirement = parsePairingRetirement(result.pairingRetirement);
  if (result.scope !== PAIRING_CREDENTIALS.rotationScope || result.globalRevocation !== PAIRING_CREDENTIALS.globalRevocation || result.rotated !== true || !retirement || retirement.revision <= minimumRevision) throw new Error('Invalid rotation receipt; read owner state before retrying.');
  const current = await probeDaemonHealth(port);
  const observed = parsePairingRetirement(current?.pairingRetirement);
  if (!current || current.pid !== health.pid || !observed || observed.revision < retirement.revision ||
      (observed.revision === retirement.revision && observed.eventId !== retirement.eventId)) {
    throw new Error('Rotation may have committed but owner readback is unavailable; read owner state before retrying.');
  }
  // The serving owner has already persisted this receipt. A short-lived CLI
  // must never overwrite it with a health snapshot that another rotation may
  // have superseded. Other profiles converge through their normal lifecycle.
}
