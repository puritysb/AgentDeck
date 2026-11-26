import net from 'net';
import { execFile } from 'child_process';
import { resolveGatewayHealth, type GatewayHealthVerdict } from '@agentdeck/shared';
import { debug } from './logger.js';

const GATEWAY_PORT = 18789;
const PROBE_TIMEOUT = 2000;
/** `openclaw health --json` queries the Gateway's `health` RPC (~1 s total,
 *  2–5 ms on the Gateway) — replacing `openclaw doctor`, which in OpenClaw
 *  2026.11.7 runs full config/DB/plugin/schema checks taking >30 s–5 min and
 *  getting killed by SIGTERM before reaching Gateway health. Keep a generous
 *  30 s ceiling for busy machines; a timeout still returns `known: false`. */
const HEALTH_CLI_TIMEOUT = 30000;

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

/** Which part of the health probe decided the verdict — for the transition
 *  log, so an OpenClaw row that goes red leaves a trace. */
export type GatewayDoctorReason =
  | GatewayHealthVerdict['reason']
  | 'exit_code'
  | 'not_installed'
  | 'timed_out'
  | 'rpc_error';

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

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function parseHealthJson(stdout: unknown): GatewayDoctorVerdict | null {
  const text = asText(stdout).trim();
  if (!text) return null;
  // Ignore leading banner lines if any precede the JSON object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return resolveGatewayHealth(parsed);
  } catch {
    return null;
  }
}

/**
 * Fallback CLI Gateway health check (`openclaw health --json`), used only when
 * the daemon has no live Gateway WebSocket or the Gateway does not advertise
 * the `health` RPC.
 *
 * A probe has three answers, not two: healthy, unhealthy, and "I could not
 * look" (`known: false`, caller retains its previous value).
 *
 *   - `ENOENT` (no `openclaw` on PATH) → `known: false` (`not_installed`).
 *   - Timeout / signal kill → `known: false` (`timed_out`).
 *   - Unsupported subcommand / unreadable JSON → `known: false` (`unreadable`).
 *   - Parsed JSON payload → `resolveGatewayHealth` SSOT verdict.
 *   - Completed run with no JSON payload → exit code (`0` healthy, non-zero broken).
 */
export async function checkGatewayHealth(): Promise<GatewayDoctorVerdict> {
  return new Promise((resolve) => {
    execFile(
      'openclaw',
      ['health', '--json'],
      { timeout: HEALTH_CLI_TIMEOUT, windowsHide: true },
      (err, stdout, stderr) => {
        const jsonVerdict = parseHealthJson(stdout);
        if (!err) {
          if (jsonVerdict) {
            resolve(jsonVerdict);
            return;
          }
          // Empty stdout (or mocked execFile callback with no stdout): fall back to exit 0.
          if (!asText(stdout).trim()) {
            resolve({ known: true, hasError: false, reason: 'exit_code' });
            return;
          }
          debug('GatewayProbe', 'openclaw health --json returned unreadable output — health unknown');
          resolve({ known: false, hasError: false, reason: 'unreadable' });
          return;
        }

        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };

        // No `openclaw` on PATH — nothing was measured, so nothing is known.
        if (e.code === 'ENOENT') {
          debug('GatewayProbe', 'openclaw not on PATH — health unknown, retaining previous value');
          resolve({ known: false, hasError: false, reason: 'not_installed' });
          return;
        }

        // `execFile` killed it at HEALTH_CLI_TIMEOUT. Slow is not broken.
        if (e.killed === true || (e.signal != null && e.signal !== '')) {
          debug('GatewayProbe', `health CLI killed after ${HEALTH_CLI_TIMEOUT}ms (${e.signal ?? 'timeout'}) — health unknown`);
          resolve({ known: false, hasError: false, reason: 'timed_out', detail: e.signal ?? undefined });
          return;
        }

        // If the CLI exited non-zero but still printed a structured health payload, trust the payload.
        if (jsonVerdict?.known) {
          resolve(jsonVerdict);
          return;
        }

        // A real non-zero exit: check for older CLIs lacking the `health` subcommand before blaming the Gateway.
        if (typeof e.code === 'number') {
          const errText = asText(stderr);
          if (/unknown command|unrecognized/i.test(errText)) {
            debug('GatewayProbe', `openclaw CLI does not support health subcommand (exit ${e.code}) — health unknown`);
            resolve({ known: false, hasError: false, reason: 'unreadable', detail: 'unsupported_cli' });
            return;
          }
          debug('GatewayProbe', `openclaw health exited ${e.code}`);
          resolve({ known: true, hasError: true, reason: 'exit_code', detail: String(e.code) });
          return;
        }

        // Spawn failed some other way (EACCES, EAGAIN, …) — still not a verdict.
        debug('GatewayProbe', `openclaw health could not run: ${e.message}`);
        resolve({ known: false, hasError: false, reason: 'unreadable', detail: e.code ? String(e.code) : undefined });
      },
    );
  });
}
