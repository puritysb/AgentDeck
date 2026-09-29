import { readFile } from 'node:fs/promises';
import http from 'node:http';
import WebSocket from 'ws';
import { getCandidateDaemonJsonPaths } from './session-registry.js';

type RecordValue = Record<string, unknown>;
type PidStatus = 'alive' | 'dead' | 'unknown';
interface RegistryProbe {
  candidate: number;
  status: 'readable' | 'missing' | 'unreadable' | 'invalid';
  port?: number;
  httpPort?: number;
  pid?: number;
  process?: PidStatus;
}
interface HealthProbe {
  status: 'ok' | 'timeout' | 'unreachable' | 'http-error' | 'invalid' | 'too-large';
  httpStatus?: number;
  pid?: number;
  build?: string;
  implementation?: 'node' | 'swift' | 'unknown';
}
interface SocketProbe {
  status: 'pong' | 'timeout' | 'unreachable' | 'rejected' | 'closed';
  httpStatus?: number;
  closeCode?: number;
}
export interface ConnectionDiagnosticReport {
  ok: boolean;
  runtime: { node: string; platform: string; arch: string };
  registry: RegistryProbe[];
  target?: { source: 'registry' | 'explicit'; candidate?: number; port: number; httpPort: number };
  health?: HealthProbe;
  websocket?: SocketProbe;
  identity: 'match' | 'mismatch' | 'unknown';
  scope: string;
}

const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const portNumber = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
const pidNumber = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** EPERM and failed probes are inconclusive, exactly as in plugin discovery. */
export function probeConnectionPid(pid: number, kill: typeof process.kill = process.kill): PidStatus {
  try { kill(pid, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

function probeHealth(port: number, timeoutMs: number): Promise<HealthProbe> {
  return new Promise(resolve => {
    let done = false;
    const finish = (result: HealthProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(result);
    };
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health' }, res => {
      if (res.statusCode !== 200) { finish({ status: 'http-error', httpStatus: res.statusCode }); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { finish({ status: 'too-large' }); return; }
        chunks.push(chunk);
      });
      res.on('error', () => finish({ status: 'unreachable' }));
      res.on('end', () => {
        try {
          const data = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (!data || data.status !== 'ok' || data.mode !== 'daemon') {
            finish({ status: 'invalid' }); return;
          }
          // Never spread a health frame: it contains tokens, paths and session data.
          finish({ status: 'ok',
            ...(pidNumber(data.pid) ? { pid: data.pid } : {}),
            ...(typeof data.build === 'string' && /^[a-f\d]{12}$/i.test(data.build) ? { build: data.build } : {}),
            implementation: data.isSwift === true ? 'swift' : data.isSwift === false || typeof data.build === 'string' ? 'node' : 'unknown',
          });
        } catch { finish({ status: 'invalid' }); }
      });
    });
    // Absolute deadline also bounds a response body which never ends.
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    req.on('error', () => finish({ status: 'unreachable' }));
  });
}

function probeSocket(port: number, timeoutMs: number): Promise<SocketProbe> {
  return new Promise(resolve => {
    let done = false;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 1024 * 1024 });
    const finish = (result: SocketProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    socket.on('open', () => socket.ping('agentdeck-diag'));
    socket.on('pong', data => { if (data.toString() === 'agentdeck-diag') finish({ status: 'pong' }); });
    socket.on('unexpected-response', (_req, res) => {
      res.destroy();
      finish({ status: 'rejected', httpStatus: res.statusCode });
    });
    socket.on('close', code => finish({ status: 'closed', closeCode: code }));
    // Error messages and close reasons can contain remote-controlled secrets.
    socket.on('error', () => finish({ status: 'unreachable' }));
  });
}

/** Read-only local probe. No fallback port scan, token use, session commands,
 * registry pruning or full-health/log dump. Tests can supply isolated files. */
export async function collectConnectionDiagnostic(opts: {
  port?: number;
  paths?: string[];
  timeoutMs?: number;
  probePid?: (pid: number) => PidStatus;
} = {}): Promise<ConnectionDiagnosticReport> {
  if (opts.port !== undefined && !portNumber(opts.port)) throw new Error('Port must be an integer from 1 to 65535');
  const registry: RegistryProbe[] = [];
  const paths = opts.paths ?? getCandidateDaemonJsonPaths();
  for (const [candidate, path] of paths.entries()) {
    try {
      const text = await readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
      const data = text.length <= 64 * 1024 ? object(JSON.parse(text)) : undefined;
      if (!data || !portNumber(data.port) || !pidNumber(data.pid) ||
          (data.httpPort !== undefined && !portNumber(data.httpPort))) {
        registry.push({ candidate, status: 'invalid' }); continue;
      }
      registry.push({ candidate, status: 'readable', port: data.port,
        httpPort: (data.httpPort as number | undefined) ?? data.port, pid: data.pid,
        process: (opts.probePid ?? probeConnectionPid)(data.pid) });
    } catch (error) {
      registry.push({ candidate, status: error instanceof SyntaxError ? 'invalid'
        : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' });
    }
  }
  const selected = registry.find(row => row.status === 'readable' && row.process !== 'dead');
  const target: ConnectionDiagnosticReport['target'] = opts.port !== undefined
    ? { source: 'explicit', port: opts.port, httpPort: opts.port }
    : selected ? { source: 'registry', candidate: selected.candidate, port: selected.port!, httpPort: selected.httpPort! } : undefined;
  const report: ConnectionDiagnosticReport = {
    ok: false, runtime: { node: process.version, platform: process.platform, arch: process.arch },
    registry, target, identity: 'unknown',
    scope: 'This CLI process only; Stream Deck may run under a different account, environment or elevation. No agent session state is tested.',
  };
  if (!target) return report;
  const timeoutMs = opts.timeoutMs ?? 3000;
  [report.health, report.websocket] = await Promise.all([
    probeHealth(target.httpPort, timeoutMs), probeSocket(target.port, timeoutMs),
  ]);
  if (target.source === 'registry' && report.health.pid !== undefined) {
    report.identity = report.health.pid === selected!.pid ? 'match' : 'mismatch';
  }
  report.ok = report.health.status === 'ok' && report.websocket.status === 'pong' && report.identity !== 'mismatch';
  return report;
}

export function formatConnectionDiagnostic(report: ConnectionDiagnosticReport): string {
  return [
    `Local daemon connection: ${report.ok ? 'reachable' : 'not confirmed'}`,
    `Registry: ${report.registry.map(row => `${row.candidate}=${row.status}${row.process ? ` (${row.process})` : ''}`).join(', ') || 'no candidates'}`,
    `Target: ${report.target ? `WS ${report.target.port}, HTTP ${report.target.httpPort} (${report.target.source})` : 'none; start the daemon or specify --port'}`,
    `Health: ${report.health?.status ?? 'not probed'}; WebSocket: ${report.websocket?.status ?? 'not probed'}; PID identity: ${report.identity}`,
    report.scope,
  ].join('\n');
}
