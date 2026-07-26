import net from 'net';
import { execFile } from './proc.js';
import { debug } from './logger.js';

const GATEWAY_PORT = 18789;
const PROBE_TIMEOUT = 2000;
const DOCTOR_TIMEOUT = 15000;

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

/**
 * Run `openclaw doctor` to check gateway health.
 * Returns true if errors are detected (exit code != 0).
 * Runs at a slower cadence than probeGateway (caller should throttle).
 */
export async function checkGatewayHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('openclaw', ['doctor'], { timeout: DOCTOR_TIMEOUT }, (err) => {
      if (err) {
        // Command not found — not an error, just no openclaw installed
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve(false);
          return;
        }
        debug('GatewayProbe', `doctor failed: ${err.message}`);
        resolve(true);
        return;
      }
      // exit 0 = healthy
      resolve(false);
    });
  });
}
