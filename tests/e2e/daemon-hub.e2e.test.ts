/**
 * Daemon hub end-to-end — the real CLI daemon, driven from outside.
 *
 * Every other daemon test either calls the gate/registry helpers as pure
 * functions or boots the per-session `HookServer`. Nothing started the process
 * a user actually runs (`agentdeck daemon start`), so the route table inside
 * `startDaemon()` — hook ingestion, the state stream, timeline persistence,
 * shutdown cleanup — was only ever verified by deploying to a Mac and watching.
 *
 * This suite spawns `bridge/dist/cli.js daemon start --foreground` as a child
 * process and treats it as a black box:
 *
 * - `HOME` and the data dir are a fresh temp directory, so the daemon cannot
 *   read the developer's `~/.claude`, `~/.agentdeck` or credentials.
 * - `--local --loopback` and `AGENTDECK_DAEMON_NO_SERIAL=1` turn off every
 *   device module and every LAN emission (mDNS, UDP beacon, sweep, BLE, ADB,
 *   serial) and bind 127.0.0.1 only — no firewall, Local Network or Bluetooth
 *   prompt can fire, and nothing reaches real hardware.
 * - `--port-window` puts it outside 9120-9139, so the singleton guard never
 *   asks a live daemon on this machine to stand down.
 *
 * It runs on Linux CI (`pnpm test:e2e`, a step in ci.yml's `test` job). On macOS it is
 * opt-in (`AGENTDECK_E2E_ALLOW_DARWIN=1`): the darwin usage poller reads the
 * login Keychain through `security`, which can raise a Keychain dialog.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHookCommand } from '../../hooks/src/install.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'bridge/dist/cli.js');
const DARWIN_BLOCKED = process.platform === 'darwin' && process.env.AGENTDECK_E2E_ALLOW_DARWIN !== '1';
const POSIX = process.platform !== 'win32';

interface Daemon {
  child: ChildProcess;
  port: number;
  log: () => string;
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

let home = '';
let dataDir = '';

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

async function health(port: number): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function startDaemon(port: number): Promise<Daemon> {
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
      AGENTDECK_DATA_DIR: dataDir,
      AGENTDECK_DAEMON_NO_SERIAL: '1',
      AGENTDECK_LOOPBACK_ONLY: '1',
      // Never inherit a real credential or port from the developer's shell.
      CLAUDE_CODE_OAUTH_TOKEN: '',
      AGENTDECK_PORT: '',
      AGENTDECK_DAEMON_PORT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => { output += c.toString(); });
  child.stderr?.on('data', (c: Buffer) => { output += c.toString(); });
  const daemon = { child, port, log: () => output };
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

/**
 * SIGTERM, as launchd/systemd/`daemon stop` send it. A clean daemon shutdown
 * ends in a deliberate self-SIGKILL (`exitProcessNow`), so the exit signal says
 * nothing; what matters is that it went away on its own, before our fallback.
 */
async function stopDaemon(daemon: Daemon): Promise<{ selfExited: boolean }> {
  const { child } = daemon;
  if (child.exitCode !== null || child.signalCode !== null) return { selfExited: true };
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  let forced = false;
  child.kill('SIGTERM');
  const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10_000);
  await exited;
  clearTimeout(timer);
  return { selfExited: !forced };
}

/** A dashboard client: collects every frame the hub pushes. */
async function connect(port: number): Promise<{ frames: Frame[]; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Frame[] = [];
  ws.addEventListener('message', (ev) => {
    try { frames.push(JSON.parse(String(ev.data)) as Frame); } catch { /* binary frames are not part of this contract */ }
  });
  await new Promise<void>((ok, fail) => {
    ws.addEventListener('open', () => ok(), { once: true });
    ws.addEventListener('error', () => fail(new Error('WS connect failed')), { once: true });
  });
  return { frames, close: () => ws.close() };
}

function postHook(port: number, event: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hooks/${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AgentDeck-Pid': String(process.pid) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

function states(frames: Frame[]): string[] {
  return frames.filter((f) => f.type === 'state_update').map((f) => String(f.state));
}

function nonLoopbackAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

const LAN_ADDRESS = nonLoopbackAddress();

const SESSION = {
  session_id: 'e2e-session-0001',
  cwd: '/tmp/agentdeck-e2e-project',
  transcript_path: '/tmp/agentdeck-e2e-project/none.jsonl',
};

describe.skipIf(DARWIN_BLOCKED)('daemon hub (real CLI process)', () => {
  let daemon: Daemon;

  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`pnpm build\` before \`pnpm test:e2e\``);
    home = mkdtempSync(join(tmpdir(), 'agentdeck-e2e-'));
    // The default data dir, not a separate one: the installed hook snippet
    // discovers the daemon through `$HOME/.agentdeck/daemon.json`, and that
    // discovery is part of what this suite proves.
    dataDir = join(home, '.agentdeck');
    daemon = await startDaemon(await freePort());
  }, 30_000);

  afterAll(async () => {
    if (daemon) await stopDaemon(daemon);
    if (home) rmSync(home, { recursive: true, force: true });
  }, 20_000);

  it('announces itself on /health and in daemon.json, from the temp data dir only', async () => {
    const h = await health(daemon.port);
    expect(h).toMatchObject({ status: 'ok', mode: 'daemon', port: daemon.port });
    expect(typeof h?.build).toBe('string');

    const info = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as { port: number; pid: number };
    expect(info).toMatchObject({ port: daemon.port, pid: daemon.child.pid });
    expect(existsSync(join(dataDir, 'auth-token'))).toBe(true);
    expect(daemon.log()).toMatch(/Loopback-only posture/);
  });

  it.runIf(LAN_ADDRESS)('binds loopback only: the same port is closed on a LAN address', async () => {
    const reached = await fetch(`http://${LAN_ADDRESS}:${daemon.port}/health`, { signal: AbortSignal.timeout(1_500) })
      .then(() => true, () => false);
    expect(reached).toBe(false);
  });

  it('turns Claude hook events into the state stream and the persisted timeline', async () => {
    const client = await connect(daemon.port);
    try {
      await waitFor('initial state_update', () => (states(client.frames).length ? true : undefined));

      await expect((await postHook(daemon.port, 'SessionStart', { ...SESSION, hook_event_name: 'SessionStart', source: 'startup' })).json())
        .resolves.toEqual({ received: true });
      await postHook(daemon.port, 'UserPromptSubmit', { ...SESSION, hook_event_name: 'UserPromptSubmit', prompt: 'e2e: say hello' });
      await waitFor('processing state', () => (states(client.frames).includes('processing') ? true : undefined));

      await postHook(daemon.port, 'Stop', { ...SESSION, hook_event_name: 'Stop' });
      await waitFor('idle after processing', () => {
        const s = states(client.frames);
        return s.lastIndexOf('idle') > s.indexOf('processing') ? true : undefined;
      });

      const processing = client.frames.find((f) => f.type === 'state_update' && f.state === 'processing');
      expect(processing?.projectName).toBe('agentdeck-e2e-project');

      // The turn reaches the timeline as a chat_start/chat_end pair, live and on disk.
      await waitFor('chat_end on the wire', () =>
        client.frames.some((f) => f.type === 'timeline_event' && JSON.stringify(f).includes('chat_end')) ? true : undefined);
      const persisted = await waitFor('timeline.json with the turn', () => {
        try {
          const entries = JSON.parse(readFileSync(join(dataDir, 'timeline.json'), 'utf8')) as Array<Record<string, unknown>>;
          return entries.some((e) => e.type === 'chat_end' && e.sessionId === SESSION.session_id) ? entries : undefined;
        } catch {
          return undefined;
        }
      });
      expect(persisted.find((e) => e.type === 'chat_start')).toMatchObject({
        raw: 'e2e: say hello', sessionId: SESSION.session_id, agentType: 'claude-code',
      });
    } finally {
      client.close();
    }
  });

  it('answers the request-response hooks (PreToolUse, Stop) promptly when no device can approve', async () => {
    // Both hooks block Claude's TUI while they wait. With no approval-capable
    // device connected the daemon must hand the decision straight back
    // (empty body = Claude's own permission flow), never hold the 25 s window.
    for (const event of ['PreToolUse', 'Stop'] as const) {
      const started = Date.now();
      const res = await postHook(daemon.port, event, {
        ...SESSION, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  });

  it.runIf(POSIX)('accepts events from the installed hook snippet, which finds the daemon via daemon.json', async () => {
    // The exact shell text `agentdeck`'s installer writes into
    // ~/.claude/settings.json, run the way Claude runs it: `sh -c`, payload on
    // stdin, no AGENTDECK_PORT, so the port must come from daemon.json + /health.
    const client = await connect(daemon.port);
    try {
      const payload = JSON.stringify({ ...SESSION, session_id: 'e2e-session-0002', hook_event_name: 'UserPromptSubmit', prompt: 'via snippet' });
      const run = spawnSync('sh', ['-c', buildHookCommand('UserPromptSubmit')], {
        input: payload,
        env: { PATH: process.env.PATH ?? '', HOME: home },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(run.status).toBe(0);
      await waitFor('snippet prompt on the timeline', () =>
        client.frames.some((f) => f.type === 'timeline_event' && JSON.stringify(f).includes('via snippet')) ? true : undefined);

      // Stop is request-response: the snippet prints the daemon's body (empty here).
      const stop = spawnSync('sh', ['-c', buildHookCommand('Stop')], {
        input: JSON.stringify({ ...SESSION, session_id: 'e2e-session-0002', hook_event_name: 'Stop' }),
        env: { PATH: process.env.PATH ?? '', HOME: home },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe('');
    } finally {
      client.close();
    }
  });

  it('shuts down cleanly and replays the persisted timeline after a restart', async () => {
    expect(await stopDaemon(daemon)).toEqual({ selfExited: true });
    // A clean exit withdraws the discovery record, so hooks stop targeting a dead port.
    expect(existsSync(join(dataDir, 'daemon.json'))).toBe(false);
    expect(await health(daemon.port)).toBeUndefined();

    daemon = await startDaemon(daemon.port);
    const client = await connect(daemon.port);
    try {
      const history = await waitFor('timeline_history replay', () =>
        client.frames.find((f) => f.type === 'timeline_history' && Array.isArray(f.entries) && f.entries.length > 0));
      const entries = history.entries as Array<Record<string, unknown>>;
      expect(entries.some((e) => e.type === 'chat_start' && e.raw === 'e2e: say hello')).toBe(true);
    } finally {
      client.close();
    }
  }, 40_000);
});
