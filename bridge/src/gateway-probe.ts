import net from 'net';
import { execFile } from 'child_process';
import { debug } from './logger.js';

const GATEWAY_PORT = 18789;
const PROBE_TIMEOUT = 2000;
/** `openclaw doctor` is not a cheap health ping: measured 8-9 s against an idle
 *  Gateway on 2026-09-12. The old 15 s ceiling left ~6 s of headroom, so a busy
 *  machine crossed it and the kill was read as "the Gateway is broken". */
const DOCTOR_TIMEOUT = 30000;

export interface GatewayStatus {
  available: boolean;
  hasError?: boolean;
}

export async function probeGateway(): Promise<GatewayStatus> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: GATEWAY_PORT, host: '127.0.0.1' });
    socket.setTimeout(PROBE_TIMEOUT);
    socket.on('connect', () => { socket.destroy(); resolve({ available: true }); });
    socket.on('error', () => { socket.destroy(); resolve({ available: false }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ available: false }); });
  });
}

/** Which part of the `openclaw doctor` run decided the verdict — for the
 *  transition log, so an OpenClaw row that goes red leaves a trace. */
export type GatewayDoctorReason =
  | 'exit_code'
  | 'not_installed'
  | 'timed_out'
  | 'unreadable';

export interface GatewayDoctorVerdict {
  /** False when the run said nothing usable — the caller RETAINS its previous
   *  value rather than inventing one. Same contract as `resolveGatewayHealth`
   *  (`shared/src/gateway-health.ts`) for the health-frame path. */
  known: boolean;
  /** Only meaningful when `known`. */
  hasError: boolean;
  reason: GatewayDoctorReason;
  detail?: string;
}

/**
 * Run `openclaw doctor` to check Gateway health.
 *
 * A probe has three answers, not two. This one used to have two, tilted BOTH
 * ways at once:
 *
 *   - `ENOENT` (no `openclaw` on PATH) resolved **false** — "healthy". A
 *     surface whose process did not inherit the CLI's directory reported a
 *     Gateway it had never once contacted as fine.
 *   - A timeout resolved **true** — "broken". `execFile` kills the child at
 *     `DOCTOR_TIMEOUT`, and a doctor run that is merely slow is not a failing
 *     Gateway. Against a measured 8-9 s command this fired on load alone.
 *
 * Both are "I could not look", and both now return `known: false`. Only a run
 * that actually completed sets `hasError`, from its exit code.
 *
 * Runs at a slower cadence than `probeGateway` (caller throttles).
 */
export async function checkGatewayHealth(): Promise<GatewayDoctorVerdict> {
  return new Promise((resolve) => {
    execFile('openclaw', ['doctor'], { timeout: DOCTOR_TIMEOUT, windowsHide: true }, (err) => {
      if (!err) {
        resolve({ known: true, hasError: false, reason: 'exit_code' });
        return;
      }

      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };

      // No `openclaw` on PATH — nothing was measured, so nothing is known.
      if (e.code === 'ENOENT') {
        debug('GatewayProbe', 'doctor not on PATH — health unknown, retaining previous value');
        resolve({ known: false, hasError: false, reason: 'not_installed' });
        return;
      }

      // `execFile` killed it at DOCTOR_TIMEOUT. Slow is not broken.
      if (e.killed === true || (e.signal != null && e.signal !== '')) {
        debug('GatewayProbe', `doctor killed after ${DOCTOR_TIMEOUT}ms (${e.signal ?? 'timeout'}) — health unknown`);
        resolve({ known: false, hasError: false, reason: 'timed_out', detail: e.signal ?? undefined });
        return;
      }

      // A real non-zero exit: doctor ran and disagreed with the Gateway.
      if (typeof e.code === 'number') {
        debug('GatewayProbe', `doctor exited ${e.code}`);
        resolve({ known: true, hasError: true, reason: 'exit_code', detail: String(e.code) });
        return;
      }

      // Spawn failed some other way (EACCES, EAGAIN, …) — still not a verdict.
      debug('GatewayProbe', `doctor could not run: ${e.message}`);
      resolve({ known: false, hasError: false, reason: 'unreadable', detail: e.code ? String(e.code) : undefined });
    });
  });
}
