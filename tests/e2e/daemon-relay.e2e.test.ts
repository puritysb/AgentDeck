/**
 * Daemon relay end-to-end (#273) — two real CLI daemons, one machine.
 *
 * A worker daemon publishes the sessions it observes to a hub daemon over one
 * outbound socket, and the hub steers them back down it. Both daemons are the
 * process a user actually runs (`agentdeck daemon start --foreground`), each
 * with its own temp HOME and data dir. The worker reaches the hub on
 * 127.0.0.1 — the shape of an `ssh -L` forward, which is the topology the
 * relay exists for — so no token is involved and nothing leaves loopback.
 *
 * The observed session is an OpenCode one, created through the observer
 * plugin's hooks: its steering is a command queue the test can read back from
 * the worker (`GET /opencode/commands`), which proves a deck press on the hub
 * reached the worker's own steering path and NOT the hub's.
 *
 * Same isolation and platform gate as daemon-hub.e2e.test.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'bridge/dist/cli.js');
const DARWIN_BLOCKED = process.platform === 'darwin' && process.env.AGENTDECK_E2E_ALLOW_DARWIN !== '1';

interface Daemon {
  child: ChildProcess;
  port: number;
  home: string;
  log: () => string;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

const SID = 'ses_relay_e2e_0001';
const ROW_ID = `observed:opencode:${SID}`;
const REQUEST_ID = `ocperm:${SID}:perm-1`;

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => ok(port));
    });
  });
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function health(port: number): Promise<Record<string, any> | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok ? ((await res.json()) as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

async function startDaemon(port: number, home: string): Promise<Daemon> {
  let output = '';
  const child = spawn(process.execPath, [
    CLI, 'daemon', 'start', '--foreground', '--local', '--loopback', '--no-build',
    '--port-window', `${port}-${port}`, '--port', String(port),
  ], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTDECK_DATA_DIR: join(home, '.agentdeck'),
      AGENTDECK_DAEMON_NO_SERIAL: '1',
      AGENTDECK_LOOPBACK_ONLY: '1',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      AGENTDECK_PORT: '',
      AGENTDECK_DAEMON_PORT: '',
      AGENTDECK_DAEMON_TOKEN: '',
      AGENTDECK_ZAI_API_KEY: '',
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => { output += c.toString(); });
  child.stderr?.on('data', (c: Buffer) => { output += c.toString(); });
  const daemon = { child, port, home, log: () => output };
  try {
    await waitFor('daemon /health', async () => {
      if (child.exitCode !== null) throw new Error(`daemon exited with ${child.exitCode}`);
      return (await health(port)) ? true : undefined;
    });
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${String(err)}\n--- daemon output ---\n${output.slice(-4000)}`);
  }
  return daemon;
}

async function stopDaemon(daemon: Daemon | undefined): Promise<void> {
  if (!daemon) return;
  const { child } = daemon;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(timer);
}

async function connect(port: number): Promise<{ frames: Frame[]; send: (f: unknown) => void; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Frame[] = [];
  ws.addEventListener('message', (ev) => {
    try { frames.push(JSON.parse(String(ev.data)) as Frame); } catch { /* binary frames are not part of this contract */ }
  });
  await new Promise<void>((ok, fail) => {
    ws.addEventListener('open', () => ok(), { once: true });
    ws.addEventListener('error', () => fail(new Error('WS connect failed')), { once: true });
  });
  return { frames, send: (f) => ws.send(JSON.stringify(f)), close: () => ws.close() };
}

function postHook(port: number, event: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hooks/${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

async function pollOpenCode(port: number, waitSec: number): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`http://127.0.0.1:${port}/opencode/commands?sid=${SID}&wait=${waitSec}`, {
    signal: AbortSignal.timeout((waitSec + 5) * 1000),
  });
  return ((await res.json()) as { commands: Array<Record<string, unknown>> }).commands;
}

function latestRow(frames: Frame[]): Record<string, unknown> | undefined {
  const list = frames.filter((f) => f.type === 'sessions_list').at(-1);
  return (list?.sessions as Array<Record<string, unknown>> | undefined)?.find((s) => s.id === ROW_ID);
}

describe.skipIf(DARWIN_BLOCKED)('daemon relay (two real CLI daemons)', () => {
  let hub: Daemon | undefined;
  let worker: Daemon | undefined;
  const homes: string[] = [];

  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`pnpm build\` before \`pnpm test:e2e\``);
    const hubHome = mkdtempSync(join(tmpdir(), 'agentdeck-relay-hub-'));
    const workerHome = mkdtempSync(join(tmpdir(), 'agentdeck-relay-worker-'));
    homes.push(hubHome, workerHome);
    hub = await startDaemon(await freePort(), hubHome);
    // The worker's opt-in: a relay.json naming the hub (what `agentdeck relay
    // set 127.0.0.1:<port>` writes). Loopback, so no token.
    mkdirSync(join(workerHome, '.agentdeck'), { recursive: true });
    writeFileSync(join(workerHome, '.agentdeck', 'relay.json'), JSON.stringify({ host: '127.0.0.1', port: hub.port }));
    worker = await startDaemon(await freePort(), workerHome);
  }, 60_000);

  afterAll(async () => {
    await stopDaemon(worker);
    await stopDaemon(hub);
    for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }, 30_000);

  it('the hub advertises the capability and the worker attaches', async () => {
    expect((await health(hub!.port))?.daemonRelay).toBe(true);
    const up = await waitFor('worker uplink connected', async () => {
      const u = (await health(worker!.port))?.relay?.uplink;
      return u?.connected ? u : undefined;
    });
    expect(up.target).toBe(`127.0.0.1:${hub!.port}`);
    await waitFor('hub sees one worker', async () =>
      ((await health(hub!.port))?.relay?.workers?.length === 1 ? true : undefined));
  });

  it('a session observed on the worker appears on the hub with its prompt', async () => {
    const client = await connect(hub!.port);
    try {
      await postHook(worker!.port, 'opencode_user_prompt_submit', { session_id: SID, cwd: '/tmp/agentdeck-relay-e2e', prompt: 'list files' });
      await postHook(worker!.port, 'opencode_permission_asked', { session_id: SID, permission_id: 'perm-1', title: 'Run ls' });
      const row = await waitFor('relayed awaiting row on the hub', () => {
        const r = latestRow(client.frames);
        return r?.requestId === REQUEST_ID ? r : undefined;
      });
      expect(row).toMatchObject({ state: 'awaiting_permission', question: 'Run ls', controlMode: 'observed', port: 0, agentType: 'opencode' });
    } finally {
      client.close();
    }
  });

  it('a deck decision and prompt on the hub reach the worker’s steering, not the hub’s', async () => {
    const client = await connect(hub!.port);
    try {
      await waitFor('hub roster with the relayed row', () => (latestRow(client.frames) ? true : undefined));
      client.send({ type: 'permission_decision', requestId: REQUEST_ID, decision: 'allow' });
      client.send({ type: 'session_command', sessionId: ROW_ID, command: { type: 'send_prompt', text: 'relay says hello' } });
      const received: Array<Record<string, unknown>> = [];
      await waitFor('both commands queued on the worker', async () => {
        received.push(...await pollOpenCode(worker!.port, 1));
        return received.length >= 2 ? true : undefined;
      });
      expect(received).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'permission_respond', permissionId: 'perm-1', response: 'allow' }),
        expect.objectContaining({ type: 'send_prompt', text: 'relay says hello' }),
      ]));
      expect(await pollOpenCode(hub!.port, 0)).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('the relayed row leaves the hub when the worker goes away', async () => {
    const client = await connect(hub!.port);
    try {
      await waitFor('roster with the row', () => (latestRow(client.frames) ? true : undefined));
      await stopDaemon(worker);
      worker = undefined;
      await waitFor('row removed', () => {
        const list = client.frames.filter((f) => f.type === 'sessions_list').at(-1);
        const ids = (list?.sessions as Array<{ id: string }> | undefined)?.map((s) => s.id) ?? [];
        return list && !ids.includes(ROW_ID) ? true : undefined;
      });
      expect((await health(hub!.port))?.relay?.workers).toEqual([]);
    } finally {
      client.close();
    }
  });
});
