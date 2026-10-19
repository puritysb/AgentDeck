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
 * - `AGENTDECK_DAEMON_NO_GATEWAY=1` and `AGENTDECK_CODEX_LIVE_USAGE=0` keep it
 *   off the developer's own agent tools: no OpenClaw Gateway probe or
 *   `openclaw doctor`, and no `codex app-server` spawn. Both CLIs would run
 *   with `HOME` pointing here, and OpenClaw's installs kept writing into it
 *   after the daemon was gone, failing the cleanup with ENOTEMPTY.
 * - `--port-window` puts it outside 9120-9139, so the singleton guard never
 *   asks a live daemon on this machine to stand down.
 *
 * It runs on Linux CI (`pnpm test:e2e`, a step in ci.yml's `test` job). On macOS it is
 * opt-in (`AGENTDECK_E2E_ALLOW_DARWIN=1`): the darwin usage poller reads the
 * login Keychain through `security`, which can raise a Keychain dialog.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHookCommand } from '../../hooks/src/install.js';
import { buildCodexApprovalHoldCommand } from '../../hooks/src/codex-install.js';

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
      AGENTDECK_DAEMON_NO_GATEWAY: '1',
      AGENTDECK_CODEX_LIVE_USAGE: '0',
      // Never inherit a real credential or port from the developer's shell.
      CLAUDE_CODE_OAUTH_TOKEN: '',
      AGENTDECK_PORT: '',
      AGENTDECK_DAEMON_PORT: '',
      AGENTDECK_ZAI_API_KEY: '',
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      // Never compile or start the Foundation Models helper (vitest.setup.ts says why).
      AGENTDECK_FM_HELPER: join(home, 'no-fm-helper'),
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

/** A dashboard client (or, with `?clientType=esp32`, a board): collects every frame the hub pushes. */
async function connect(port: number, path = ''): Promise<{ frames: Frame[]; send: (msg: Record<string, unknown>) => void; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const frames: Frame[] = [];
  ws.addEventListener('message', (ev) => {
    try { frames.push(JSON.parse(String(ev.data)) as Frame); } catch { /* binary frames are not part of this contract */ }
  });
  await new Promise<void>((ok, fail) => {
    ws.addEventListener('open', () => ok(), { once: true });
    ws.addEventListener('error', () => fail(new Error('WS connect failed')), { once: true });
  });
  return { frames, send: (msg) => ws.send(JSON.stringify(msg)), close: () => ws.close() };
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
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }, 20_000);

  it('announces itself on /health and in daemon.json, from the temp data dir only', async () => {
    const h = await health(daemon.port);
    expect(h).toMatchObject({ status: 'ok', mode: 'daemon', port: daemon.port, isSwift: false });
    expect(typeof h?.build).toBe('string');

    const info = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as { port: number; pid: number };
    expect(info).toMatchObject({ port: daemon.port, pid: daemon.child.pid });
    expect(existsSync(join(dataDir, 'auth-token'))).toBe(true);
    expect(daemon.log()).toMatch(/Loopback-only posture/);
  });

  it('requires a local bearer token for credential edits, preserves settings and never returns or logs keys', async () => {
    const url = `http://127.0.0.1:${daemon.port}/integrations/zai`;
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect((await fetch(url, { method, signal: AbortSignal.timeout(2000) })).status).toBe(403);
      expect((await fetch(url, { method, headers: { Authorization: 'Bearer wrong-token' }, signal: AbortSignal.timeout(2000) })).status).toBe(403);
    }
    const headers = { Authorization: `Bearer ${(await health(daemon.port))?.pairingToken}`,
      'Content-Type': 'application/json' };
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ unrelated: 'preserved' }));
    // PAYG skips provider I/O: this is a route/key-custody test, never a live account request.
    const fakeKey = 'sk-pay-route-test-only';
    const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ apiKey: fakeKey }),
      signal: AbortSignal.timeout(15000) });
    expect(saved.status).toBe(200);
    const reply = await saved.text();
    expect(JSON.parse(reply)).toMatchObject({ configured: true, source: 'daemon-settings', editable: true, authFailed: false, verified: true });
    expect(reply).not.toContain(fakeKey);
    expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))).toEqual({ unrelated: 'preserved', zaiApiKey: fakeKey });
    if (POSIX) expect(statSync(join(dataDir, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(await (await fetch(url, { headers })).text()).not.toContain(fakeKey);
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ apiKey: 'invalid key' }) })).status).toBe(400);
    expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))).toEqual({ unrelated: 'preserved' });
    expect(daemon.log()).not.toContain(fakeKey);
  });

  it('keeps ESP32 WiFi credentials behind loopback and the token, applies them live and never returns the password', async () => {
    const url = `http://127.0.0.1:${daemon.port}/esp32/wifi`;
    const file = join(home, '.agentdeck', 'wifi-config.json');
    const password = 'e2e-route-password';
    for (const method of ['GET', 'POST']) {
      const refused = await fetch(url, { method, signal: AbortSignal.timeout(2000) });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ ok: false, error: 'local-token-required' });
    }
    const headers = { Authorization: `Bearer ${(await health(daemon.port))?.pairingToken}`,
      'Content-Type': 'application/json' };
    // `--local`: no serial channel, so no boards, but the credentials are still kept.
    expect(await (await fetch(url, { headers })).json())
      .toEqual({ ok: true, configured: false, ssid: '', autoProvision: false, serial: false, boards: [] });
    const short = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ssid: 'E2E-Net', password: 'short' }) });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ ok: false, error: 'password-too-short' });
    // A body the route will not read is answered, not reset, and saves nothing:
    // one over the 4 KiB limit, and bytes that are not UTF-8.
    const oversized = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ ssid: 'E2E-Big', password: 'x'.repeat(8 * 1024) }), signal: AbortSignal.timeout(5000) });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toEqual({ ok: false, error: 'invalid-body' });
    const garbled = await fetch(url, { method: 'POST', headers,
      body: Buffer.from('{"ssid":"E2E-\xff","password":"e2e-garbled-password"}', 'latin1'), signal: AbortSignal.timeout(5000) });
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toEqual({ ok: false, error: 'invalid-body' });
    expect(existsSync(file)).toBe(false);

    const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ssid: 'E2E-Net', password }) });
    expect(saved.status).toBe(200);
    const savedReply = await saved.text();
    expect(JSON.parse(savedReply)).toEqual({ ok: true, saved: true, autoProvision: true, boards: [] });
    expect(savedReply).not.toContain(password);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ssid: 'E2E-Net', password, autoProvision: true });
    if (POSIX) expect(statSync(file).mode & 0o777).toBe(0o600);
    const status = await (await fetch(url, { headers })).text();
    expect(JSON.parse(status)).toMatchObject({ ok: true, configured: true, ssid: 'E2E-Net', autoProvision: true });
    expect(status).not.toContain(password);

    // `agentdeck wifi-setup` goes through the running daemon (token from its
    // loopback /health) instead of writing a file the daemon reads at startup.
    const cliPassword = 'e2e-cli-password';
    const cli = spawnSync(process.execPath, [CLI, 'wifi-setup', '--ssid', 'E2E-CLI', '--password', cliPassword], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENTDECK_DATA_DIR: dataDir,
        AGENTDECK_PORT: '', AGENTDECK_DAEMON_PORT: '' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stderr).toContain(`WiFi config saved by the daemon on port ${daemon.port}`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ssid: 'E2E-CLI', password: cliPassword, autoProvision: true });
    expect(daemon.log()).not.toContain(password);
    expect(daemon.log()).not.toContain(cliPassword);
  });

  it('answers a web page on this machine as a LAN peer, and a local program as before', async () => {
    // DNS rebinding: a page whose own host name now resolves to 127.0.0.1
    // reads the daemon same-origin, and its Host header names the page. fetch
    // will not send a chosen Host, so this one goes through node:http.
    const rebound = await new Promise<{ status: number; body: string }>((ok, fail) => {
      const req = request({ host: '127.0.0.1', port: daemon.port, path: '/health',
        headers: { Host: `rebind.example:${daemon.port}` } }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', fail);
      req.end();
    });
    expect(rebound.status).toBe(200);
    expect(JSON.parse(rebound.body)).toMatchObject({ authRequired: true });
    expect(rebound.body).not.toContain('pairingToken');

    // A cross-origin text/plain POST needs no CORS preflight.
    const posted = await fetch(`http://127.0.0.1:${daemon.port}/hooks/SessionStart`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: JSON.stringify({ ...SESSION, session_id: 'e2e-web-page-0001' }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(posted.status).toBe(401);

    // A WebSocket has no CORS at all; it gets the close code a LAN peer gets.
    // Node's WebSocket (undici) takes `headers`; the DOM typings do not.
    const PageWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
    const code = await new Promise<number>((ok) => {
      const ws = new PageWebSocket(`ws://127.0.0.1:${daemon.port}`, { headers: { Origin: 'https://evil.example' } });
      ws.addEventListener('close', (ev) => ok(ev.code), { once: true });
    });
    expect(code).toBe(4001);
    expect(daemon.log()).toMatch(/is a web page, not a local program/);

    // A local program sends no Origin and names 127.0.0.1, so nothing changes.
    expect(typeof (await health(daemon.port))?.pairingToken).toBe('string');
    (await connect(daemon.port)).close();
  });

  it.runIf(LAN_ADDRESS)('binds loopback only: the same port is closed on a LAN address', async () => {
    const reached = await fetch(`http://${LAN_ADDRESS}:${daemon.port}/health`, { signal: AbortSignal.timeout(1_500) })
      .then(() => true, () => false);
    expect(reached).toBe(false);
  });

  it('keeps a background CI wait through Stop and sends explicit null on re-invocation', async () => {
    const client = await connect(daemon.port);
    const session = { ...SESSION, session_id: 'e982a0ae-a062-42c9-b174-4022f0e53228', permission_mode: 'bypassPermissions' };
    const row = () => client.frames.filter(f => f.type === 'sessions_list').reverse()
      .flatMap(f => f.sessions as Array<{ id: string; waitingOn?: unknown; activity?: string }>)
      .find(r => r.id.includes(session.session_id));
    try {
      await postHook(daemon.port, 'codex_session_start', session);
      await postHook(daemon.port, 'codex_user_prompt_submit', { ...session, prompt: 'check CI' });
      await postHook(daemon.port, 'codex_tool_start', { ...session, tool_name: 'Bash', tool_use_id: 'ci-tool',
        tool_input: { command: 'gh run watch 42', run_in_background: true } });
      await postHook(daemon.port, 'codex_tool_end', { ...session, tool_name: 'Bash', tool_use_id: 'ci-tool' });
      await postHook(daemon.port, 'codex_stop', session);
      await waitFor('CI wait roster after Stop', () => row()?.waitingOn ? true : undefined);
      expect(row()?.activity).toBe('CI wait');
      expect(row()?.waitingOn).toMatchObject({ phase: 'unknown', evidence: 'tool_input', agentWaiting: true });
      expect(JSON.stringify(row()?.waitingOn)).not.toContain('gh run');
      client.frames.length = 0;
      await postHook(daemon.port, 'codex_user_prompt_submit', { ...session, prompt: 'CI finished; continue' });
      await waitFor('explicit CI clear', () => row()?.waitingOn === null ? true : undefined);
      await postHook(daemon.port, 'codex_session_end', session);
    } finally { client.close(); }
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
      expect(persisted.find((e) => e.type === 'chat_start' && e.sessionId === SESSION.session_id)).toMatchObject({
        raw: 'e2e: say hello', sessionId: SESSION.session_id, agentType: 'claude-code',
      });
    } finally {
      client.close();
    }
  });

  it('answers a board asking for a session by the cut id it holds, even after a long reply', async () => {
    // A board holds session ids cut to 31 bytes and matches a reply against
    // the id it asked with; a reply under the resolved id, or one whose
    // newest row was a long reply too big for the frame budget, left the
    // knob's History view empty. A Codex session, since its roster row needs
    // no live process behind the hook.
    const session = { ...SESSION, session_id: 'e2eb0a4d-5f0e-4c6b-9d1a-7e2f40c0ffee', permission_mode: 'bypassPermissions' };
    const dashboard = await connect(daemon.port);
    const board = await connect(daemon.port, '/?clientType=esp32');
    try {
      await postHook(daemon.port, 'codex_session_start', session);
      await postHook(daemon.port, 'codex_user_prompt_submit', { ...session, prompt: 'e2e: summarise the run' });
      await postHook(daemon.port, 'codex_stop', { ...session, last_assistant_message: '완료된 단계 '.repeat(600) });
      await waitFor('the reply on the wire', () => dashboard.frames.find((f) => f.type === 'timeline_event'
        && (f.entry as Record<string, unknown>)?.sessionId === session.session_id
        && (f.entry as Record<string, unknown>)?.type === 'chat_response'))
        .catch((err: unknown) => { throw new Error(`${String(err)}\n${daemon.log().slice(-3000)}`); });

      // The id the board holds is whatever its own roster carried, cut to fit.
      const boardId = await waitFor('the session in the board\'s roster', () => {
        for (const f of board.frames) {
          if (f.type !== 'sessions_list' || !Array.isArray(f.sessions)) continue;
          for (const listed of f.sessions as Array<{ id?: unknown }>) {
            const id = typeof listed.id === 'string' ? listed.id : '';
            if (id.length === 31 && `observed:codex:${session.session_id}`.startsWith(id)) return id;
          }
        }
        return undefined;
      });
      board.send({ type: 'query_session_timeline', sessionId: boardId });
      const history = await waitFor('the board\'s History reply', () => board.frames.find(
        (f) => f.type === 'timeline_history' && f.sessionId === boardId)) as { entries: Array<Record<string, unknown>> };
      expect(Buffer.byteLength(JSON.stringify(history), 'utf8')).toBeLessThan(4096);
      const turn = history.entries.filter((e) => e.type === 'chat_start' || e.type === 'chat_response');
      expect(turn.map((e) => e.type)).toEqual(['chat_start', 'chat_response']);
      expect(Buffer.byteLength(String(turn[1].detail ?? ''), 'utf8')).toBeLessThanOrEqual(199);
    } finally {
      board.close();
      dashboard.close();
    }
  });

  it("closes a long Claude turn against its prompt and keeps the turn in a plain client's Detail view", async () => {
    // Claude's per-tool hook rows (up to two per tool call) reach only a
    // surface that negotiated `timeline.tool-events.read`. They used to count
    // toward the 24-row read the Stop and SessionEnd paths make, so a turn of
    // a dozen tool calls lost its prompt row: the reply went out without
    // `startedAt`, a turn with no reply text got no closing row, and a session
    // ending mid-turn was not closed at its SessionEnd. A plain client's
    // Detail query also took the last 16 rows before dropping them.
    const done = { ...SESSION, session_id: 'e2e-long-turn-0001', permission_mode: 'bypassPermissions' };
    const quit = { ...SESSION, session_id: 'e2e-long-turn-0002', permission_mode: 'bypassPermissions' };
    const quiet = { ...SESSION, session_id: 'e2e-long-turn-0003', permission_mode: 'bypassPermissions' };
    const client = await connect(daemon.port);
    const rows = (sid: string) => client.frames
      .filter((f) => f.type === 'timeline_event')
      .map((f) => f.entry as Record<string, unknown>)
      .filter((e) => e && e.sessionId === sid);
    const longTurn = async (session: typeof done) => {
      await postHook(daemon.port, 'SessionStart', { ...session, hook_event_name: 'SessionStart', source: 'startup' });
      await postHook(daemon.port, 'UserPromptSubmit', { ...session, hook_event_name: 'UserPromptSubmit', prompt: 'e2e: run fifteen steps' });
      // Distinct tool names, as a real turn mixes tools: exact dedup folds a
      // repeat of the same name within 8 s.
      for (let i = 0; i < 15; i++) {
        const tool = { tool_name: `mcp__e2e__step_${i}`, tool_use_id: `toolu_${session.session_id}_${i}`, tool_input: { path: `/tmp/agentdeck-e2e-project/f${i}` } };
        await postHook(daemon.port, 'PreToolUse', { ...session, hook_event_name: 'PreToolUse', ...tool });
        await postHook(daemon.port, 'PostToolUse', { ...session, hook_event_name: 'PostToolUse', ...tool, tool_response: 'ok' });
      }
    };
    try {
      await longTurn(done);
      await postHook(daemon.port, 'Stop', { ...done, hook_event_name: 'Stop', last_assistant_message: 'All fifteen steps ran.' });
      const reply = await waitFor('the reply on the wire', () => rows(done.session_id).find((e) => e.type === 'chat_response'))
        .catch((err: unknown) => { throw new Error(`${String(err)}\n${daemon.log().slice(-3000)}`); });
      const prompt = rows(done.session_id).find((e) => e.type === 'chat_start');
      expect(prompt).toBeDefined();
      expect(reply.startedAt).toBe(prompt!.startedAt ?? prompt!.ts);
      expect(rows(done.session_id).some((e) => e.toolEvent === true)).toBe(false);

      client.send({ type: 'query_session_timeline', sessionId: done.session_id });
      const detail = await waitFor('the Detail reply', () => client.frames.find(
        (f) => f.type === 'timeline_history' && f.sessionId === done.session_id)) as { entries: Array<Record<string, unknown>> };
      expect(detail.entries.filter((e) => e.type === 'chat_start' || e.type === 'chat_response').map((e) => e.type))
        .toEqual(['chat_start', 'chat_response']);
      expect(detail.entries.some((e) => e.toolEvent === true)).toBe(false);

      // No reply text (the transcript path names no file): the Stop closes the
      // turn with a chat_end instead.
      await longTurn(quiet);
      await postHook(daemon.port, 'Stop', { ...quiet, hook_event_name: 'Stop' });
      const completed = await waitFor('the reply-less close', () => rows(quiet.session_id).find((e) => e.type === 'chat_end'))
        .catch((err: unknown) => { throw new Error(`${String(err)}\n${daemon.log().slice(-3000)}`); });
      const quietPrompt = rows(quiet.session_id).find((e) => e.type === 'chat_start');
      expect(String(completed.raw)).toMatch(/^Completed · /);
      expect(completed.startedAt).toBe(quietPrompt!.startedAt ?? quietPrompt!.ts);

      await longTurn(quit);
      await postHook(daemon.port, 'SessionEnd', { ...quit, hook_event_name: 'SessionEnd', reason: 'exit' });
      const closed = await waitFor('the interrupted close', () => rows(quit.session_id).find((e) => e.type === 'chat_end'))
        .catch((err: unknown) => { throw new Error(`${String(err)}\n${daemon.log().slice(-3000)}`); });
      const quitPrompt = rows(quit.session_id).find((e) => e.type === 'chat_start');
      expect(String(closed.raw)).toMatch(/^Interrupted · /);
      expect(closed.startedAt).toBe(quitPrompt!.startedAt ?? quitPrompt!.ts);
      for (const session of [done, quiet]) {
        await postHook(daemon.port, 'SessionEnd', { ...session, hook_event_name: 'SessionEnd', reason: 'exit' });
      }
    } finally {
      client.close();
    }
  });

  it('replays real Hermes CI tool callbacks through HTTP and clears the exact foreground wait', async () => {
    const capture = JSON.parse(readFileSync(join(ROOT, 'bridge/src/__tests__/fixtures/hermes-live-ci.json'), 'utf8'));
    const client = await connect(daemon.port);
    const sid = capture.events[0].payload.session_id;
    const observedId = `observed:hermes:${sid}`;
    try {
      for (const hook of capture.events) {
        const from = client.frames.length;
        const response = await postHook(daemon.port, hook.event, { ...hook.payload, pid: daemon.child.pid });
        expect(response.status).toBe(200);
        if (hook.event === 'hermes_tool_start' || hook.event === 'hermes_tool_end') {
          const row = await waitFor('Hermes CI wait projection', () => {
            for (const frame of client.frames.slice(from)) {
              if (frame.type !== 'sessions_list') continue;
              const session = (frame.sessions as Record<string, unknown>[]).find(s => s.id === observedId);
              if (session && (hook.event === 'hermes_tool_start' ? session.waitingOn != null : session.waitingOn === null)) return session;
            }
            return undefined;
          });
          if (hook.event === 'hermes_tool_start') expect(row.waitingOn).toMatchObject({
            kind: 'ci', provider: 'github-actions', repo: 'example/project', runId: 4242, phase: 'unknown', agentWaiting: true,
          });
          else expect(row.waitingOn).toBeNull();
        }
      }
      await waitFor('Hermes CI finalized row retirement', () => {
        const latest = client.frames.filter(f => f.type === 'sessions_list').at(-1);
        return latest && !(latest.sessions as Record<string, unknown>[]).some(s => s.id === observedId) ? true : undefined;
      });
      const scheduled = client.frames.filter(f => f.type === 'timeline_event')
        .map(f => f.entry as Record<string, unknown>).filter(e => e.sessionId === sid && e.type === 'scheduled');
      expect(scheduled.some(e => e.raw === 'CI wait requested' && e.agentType === 'hermes')).toBe(true);
      expect(scheduled.some(e => e.raw === 'CI wait ended · result unconfirmed')).toBe(true);
      expect(JSON.stringify(client.frames)).not.toContain('fixture-private-invocation');
      const page = await (await fetch(`http://127.0.0.1:${daemon.port}/apme/tasks?session=${encodeURIComponent(sid)}`,
        { signal: AbortSignal.timeout(2000) })).json() as { tasks: Array<{ id: string }> };
      expect(page.tasks).toHaveLength(1);
      const detail = await (await fetch(`http://127.0.0.1:${daemon.port}/apme/tasks/${page.tasks[0].id}`,
        { signal: AbortSignal.timeout(2000) })).json() as {
          turns: Array<{ end_source: string; response: string; model_id: string }>;
          sample: { events: Array<{ kind: string; evidence?: string; phase?: string }> };
        };
      expect(detail.turns).toHaveLength(1);
      expect(detail.turns[0]).toMatchObject({ end_source: 'stop', response: 'HERMES_CI_COMPLETE', model_id: 'agentdeck-ci-fixture' });
      expect(detail.sample.events.filter(e => e.kind === 'relation' && e.evidence === 'ci_wait_foreground').map(e => e.phase))
        .toEqual(['open', 'closed']);

    } finally { client.close(); }
  });
  it('replays a real Hermes delegated turn through HTTP without a child roster row', async () => {
    const capture = JSON.parse(readFileSync(join(ROOT, 'bridge/src/__tests__/fixtures/hermes-live-child.json'), 'utf8'));
    const client = await connect(daemon.port);
    const sid = capture.events[0].payload.session_id;
    try {
      for (const hook of capture.events) {
        const response = await postHook(daemon.port, hook.event, { ...hook.payload, pid: daemon.child.pid });
        expect(response.status).toBe(200);
        if (hook.event === 'hermes_session_start') {
          await waitFor('delegated parent roster', () => client.frames.some(f =>
            f.type === 'sessions_list' && (f.sessions as Array<{ id: string }>).some(r =>
              r.id === `observed:hermes:${sid}`)) ? true : undefined);
        }
      }
      await waitFor('delegated parent response', () => client.frames.some(f =>
        f.type === 'timeline_event' && (f.entry as Record<string, unknown>)?.raw === 'AGENTDECK_LOCAL_CAPTURE_DONE') ? true : undefined);
      const rosters = client.frames.filter(f => f.type === 'sessions_list')
        .flatMap(f => f.sessions as Array<{ id: string; agentType?: string }>);
      const hermesIds = new Set(rosters.filter(r => r.agentType === 'hermes').map(r => r.id));
      expect([...hermesIds]).toEqual([`observed:hermes:${sid}`]);
      const replies = client.frames.filter(f => f.type === 'timeline_event')
        .map(f => f.entry as Record<string, unknown>)
        .filter(e => e.agentType === 'hermes' && e.type === 'chat_response');
      expect(replies.filter(e => e.raw === 'AGENTDECK_LOCAL_CAPTURE_DONE')).toHaveLength(1);
    } finally { client.close(); }
  });

  it('replays real Hermes CLI/Gateway captures without calling cancelled turns completed', async () => {
    const capture = JSON.parse(readFileSync(join(ROOT, 'bridge/src/__tests__/fixtures/hermes-live-lifecycle.json'), 'utf8'));
    const client = await connect(daemon.port);
    try {
      for (const hook of capture.events) {
        // The capture's scrubbed PID is not a live process on this test host.
        const payload = { ...hook.payload, pid: daemon.child.pid };
        const response = await postHook(daemon.port, hook.event, payload);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ received: true });
      }
      const cancelled = capture.events.filter((e: { event: string; payload: { interrupted?: boolean } }) =>
        e.event === 'hermes_stop' && e.payload.interrupted === true);
      expect(cancelled).toHaveLength(3);
      await waitFor('all cancelled Hermes turns on the wire', () => {
        const rows = client.frames.filter(f => f.type === 'timeline_event')
          .map(f => f.entry as Record<string, unknown>)
          .filter(e => e.agentType === 'hermes' && e.type === 'chat_end' && String(e.raw).startsWith('Interrupted'));
        return rows.length >= 3 ? rows : undefined;
      });
      const ends = client.frames.filter(f => f.type === 'timeline_event')
        .map(f => f.entry as Record<string, unknown>)
        .filter(e => e.agentType === 'hermes' && e.type === 'chat_end');
      expect(ends.some(e => String(e.raw).startsWith('Completed'))).toBe(false);
      const replies = client.frames.filter(f => f.type === 'timeline_event')
        .map(f => f.entry as Record<string, unknown>)
        .filter(e => e.agentType === 'hermes' && e.type === 'chat_response');
      expect(replies.map(e => e.raw)).toEqual(expect.arrayContaining([
        'GATEWAY_ONE', 'GATEWAY_TWO', 'CLI_ONE', 'CLI_TWO', 'CLI_AFTER_RESET', 'GATEWAY_TOOL_OK',
      ]));
      for (const hook of capture.events.filter((e: { event: string }) => e.event === 'hermes_session_start')) {
        await postHook(daemon.port, 'hermes_session_end', hook.payload);
      }
    } finally {
      client.close();
    }
  });

  it('stamps an observed OpenCode turn with the model and endpoint its stop names', async () => {
    // The OpenCode observer (v5) payload: `model` / `model_provider` are the
    // assistant message's modelID / providerID. `local`, not the `alibaba`
    // the model id alone reads as, proves the provider crossed the wire.
    const sid = 'ses_e2e_opencode_model';
    const base = { session_id: sid, cwd: '/tmp/agentdeck-e2e-opencode' };
    const hooks: Array<[string, Record<string, unknown>]> = [
      ['opencode_session_start', base],
      ['opencode_user_prompt_submit', { ...base, prompt: 'Name the capital of France.' }],
      ['opencode_stop', { ...base, last_assistant_message: 'Paris.',
        model: 'mlx-community/Qwen3.6-35B-A3B-4bit', model_provider: 'mlx' }],
    ];
    for (const [event, body] of hooks) expect((await postHook(daemon.port, event, body)).status).toBe(200);
    const turns = await waitFor('OpenCode turn identity', async () => {
      const page = await (await fetch(`http://127.0.0.1:${daemon.port}/apme/tasks?session=${encodeURIComponent(sid)}`,
        { signal: AbortSignal.timeout(2000) })).json() as { tasks?: Array<{ id: string }> };
      const id = page.tasks?.[0]?.id;
      if (!id) return undefined;
      const detail = await (await fetch(`http://127.0.0.1:${daemon.port}/apme/tasks/${id}`,
        { signal: AbortSignal.timeout(2000) })).json() as { turns: Array<Record<string, unknown>> };
      return detail.turns[0]?.model_id ? detail.turns : undefined;
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      end_source: 'stop', response: 'Paris.', model_id: 'mlx-community/Qwen3.6-35B-A3B-4bit', provider: 'local',
    });
  });

  it('ingests a Codex turn delivered to both its codex_* hooks and the generic hooks once, as Codex (#490)', async () => {
    // Verbatim codex-cli 0.160.1 payloads (paths scrubbed). Codex runs every
    // hook command configured for an event, so a Claude-shaped AgentDeck
    // command it also runs re-delivers the same event to /hooks/<Event>. The
    // generic copy was read as Claude Code: rows under the Claude icon, keyed
    // by the Codex thread.
    const vectors = (JSON.parse(readFileSync(join(ROOT, 'shared/hook-harness-vectors.json'), 'utf8')) as {
      vectors: Array<{ name: string; payload: Record<string, unknown> }>;
    }).vectors;
    const captured = (prefix: string) => {
      const v = vectors.find((x) => x.name.startsWith(prefix));
      if (!v) throw new Error(`missing vector ${prefix}`);
      return v.payload;
    };
    const start = captured('Codex SessionStart (codex-cli 0.160.1');
    const prompt = captured('Codex UserPromptSubmit (captured)');
    const stop = captured('Codex Stop (captured)');
    const thread = String(stop.session_id);
    // A second, real Codex thread whose turn ends with the same words.
    const other = '01a12890-0000-7000-8000-00000000e2e2';
    const otherTurn = '01a12890-0000-7000-8000-00000000e2e3';
    const client = await connect(daemon.port);
    try {
      await postHook(daemon.port, 'codex_session_start', start);
      await postHook(daemon.port, 'SessionStart', start);
      await postHook(daemon.port, 'UserPromptSubmit', prompt);
      await postHook(daemon.port, 'codex_user_prompt_submit', prompt);
      // The generic Stop first: it is the copy that used to close the turn
      // under the Claude icon. Codex discards a command hook's output, and the
      // Claude-shaped command echoes this body — it must be empty.
      const generic = await postHook(daemon.port, 'Stop', stop);
      expect(await generic.text()).toBe('');
      await postHook(daemon.port, 'codex_stop', stop);
      await postHook(daemon.port, 'codex_session_start', { ...start, session_id: other });
      await postHook(daemon.port, 'codex_user_prompt_submit', { ...prompt, session_id: other, turn_id: otherTurn });
      await postHook(daemon.port, 'codex_stop', { ...stop, session_id: other, turn_id: otherTurn });

      const rows = () => client.frames
        .filter((f) => f.type === 'timeline_event')
        .map((f) => f.entry as Record<string, unknown>)
        .filter((e) => e && (e.sessionId === thread || e.sessionId === other));
      await waitFor('both replies on the wire', () =>
        rows().filter((e) => e.type === 'chat_response').length >= 2 ? true : undefined).catch((err: unknown) => {
        throw new Error(`${String(err)}\nrows: ${JSON.stringify(rows().map((e) => [e.type, e.agentType, e.sessionId, e.raw]))}\n${daemon.log().slice(-3000)}`);
      });
      await new Promise((r) => setTimeout(r, 500));

      const mine = rows().filter((e) => e.sessionId === thread);
      expect(mine.filter((e) => e.type === 'chat_start')).toHaveLength(1);
      expect(mine.filter((e) => e.type === 'chat_response')).toHaveLength(1);
      expect(rows().filter((e) => e.sessionId === other && e.type === 'chat_response')).toHaveLength(1);
      expect(rows().map((e) => e.agentType).filter((t) => t !== 'codex-cli')).toEqual([]);
      const claudeRows = client.frames
        .filter((f) => f.type === 'sessions_list')
        .flatMap((f) => f.sessions as Array<{ id: string; agentType?: string }>)
        .filter((r) => r.agentType === 'claude-code' && (r.id.includes(thread) || r.id.includes(other)));
      expect(claudeRows).toEqual([]);
    } finally {
      client.close();
    }
  });

  /** Every turn APME archived for one session, oldest first. */
  async function apmeTurns(sid: string): Promise<Array<{ prompt: string; response: string | null; end_source: string | null }>> {
    const page = await (await fetch(`http://127.0.0.1:${daemon.port}/apme/tasks?session=${encodeURIComponent(sid)}`,
      { signal: AbortSignal.timeout(2000) })).json() as { tasks: Array<{ id: string }> };
    const turns = [];
    for (const task of page.tasks) {
      const detail = await (await fetch(`http://127.0.0.1:${daemon.port}/apme/tasks/${task.id}`,
        { signal: AbortSignal.timeout(2000) })).json() as {
          turns: Array<{ prompt: string; response: string | null; end_source: string | null; turn_index: number }>;
        };
      turns.push(...detail.turns);
    }
    return turns.sort((a, b) => (a as { turn_index: number }).turn_index - (b as { turn_index: number }).turn_index);
  }

  const NOTIFICATION = '<task-notification>\n<task-id>e2e-bg</task-id>\n<status>completed</status>\n</task-notification>';

  it('lands a Stop reply on the turn a task notification opened, which the timeline drops', async () => {
    // The daemon used to route the reply with its timeline's open-turn test,
    // and the timeline drops this prompt — so the reply went to the PREVIOUS
    // turn, which already had one, and was lost.
    const s = { ...SESSION, session_id: 'e2e-session-notify' };
    await postHook(daemon.port, 'UserPromptSubmit', { ...s, hook_event_name: 'UserPromptSubmit', prompt: 'e2e: first' });
    await postHook(daemon.port, 'Stop', { ...s, hook_event_name: 'Stop', last_assistant_message: 'FIRST_REPLY' });
    await postHook(daemon.port, 'UserPromptSubmit', { ...s, hook_event_name: 'UserPromptSubmit', prompt: NOTIFICATION });
    await postHook(daemon.port, 'Stop', { ...s, hook_event_name: 'Stop', last_assistant_message: 'NOTIFICATION_REPLY' });

    const turns = await waitFor('both turns closed', async () => {
      const t = await apmeTurns(s.session_id);
      return t.length === 2 && t.every((x) => x.end_source === 'stop') ? t : undefined;
    });
    expect(turns.map((t) => t.response)).toEqual(['FIRST_REPLY', 'NOTIFICATION_REPLY']);
  });

  it('closes a running turn a queued message displaced as `injected`, reading the real transcript', async () => {
    const transcript = join(home, 'injected-transcript.jsonl');
    const s = { ...SESSION, session_id: 'e2e-session-inject', transcript_path: transcript };
    writeFileSync(transcript, '');
    await postHook(daemon.port, 'UserPromptSubmit', { ...s, hook_event_name: 'UserPromptSubmit', prompt: 'e2e: long task' });
    // The turn is mid-run: tool calls written, no end_turn yet.
    writeFileSync(transcript, `${JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] },
    })}\n`);
    await postHook(daemon.port, 'UserPromptSubmit', { ...s, hook_event_name: 'UserPromptSubmit', prompt: NOTIFICATION });
    await postHook(daemon.port, 'Stop', { ...s, hook_event_name: 'Stop', last_assistant_message: 'LONG_TASK_DONE' });

    const turns = await waitFor('the run\'s Stop', async () => {
      const t = await apmeTurns(s.session_id);
      return t.length === 2 && t[1].end_source === 'stop' ? t : undefined;
    });
    expect(turns.map((t) => [t.end_source, t.response])).toEqual([['injected', null], ['stop', 'LONG_TASK_DONE']]);
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

  it.runIf(POSIX)('holds a Codex approval for a device decision, from a deck key too, and releases it when the turn ends', async () => {
    const vectors = JSON.parse(readFileSync(join(ROOT, 'shared/codex-approval-hold-vectors.json'), 'utf8')) as {
      capturedPermissionRequest: Record<string, unknown>;
      capturedQuestion: string;
      decisions: Array<{ decision: string; body: unknown }>;
    };
    const permission = vectors.capturedPermissionRequest;
    const thread = String(permission.session_id);
    const rowId = `observed:codex:${thread}`;
    const base = {
      session_id: thread, transcript_path: permission.transcript_path, cwd: permission.cwd,
      model: permission.model, permission_mode: permission.permission_mode,
    };
    const body = (decision: string) => vectors.decisions.find((d) => d.decision === decision)?.body;
    // The installed hold command, run the way Codex runs it: `sh -c`, the
    // payload on stdin, and only the daemon's decision on stdout.
    const runHold = (turnId: string) => new Promise<{ code: number | null; stdout: string }>((ok, fail) => {
      const child = spawn('sh', ['-c', buildCodexApprovalHoldCommand(process.platform)], {
        env: { ...process.env, HOME: home, AGENTDECK_PORT: String(daemon.port) },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
      child.once('error', fail);
      child.once('exit', (code) => ok({ code, stdout }));
      child.stdin?.end(JSON.stringify({ ...permission, turn_id: turnId }));
    });
    const row = (frames: Frame[]) => {
      const list = frames.filter((f) => f.type === 'sessions_list').at(-1);
      return (list?.sessions as Array<Record<string, unknown>> | undefined)?.find((r) => r.id === rowId);
    };
    const turns = [
      '01a14c63-9500-7e71-b111-00000000e201', '01a14c63-9500-7e71-b111-00000000e202', '01a14c63-9500-7e71-b111-00000000e203',
      '01a14c63-9500-7e71-b111-00000000e204', '01a14c63-9500-7e71-b111-00000000e205',
    ];
    // No device connected: the hold must not stall the terminal at all, and
    // the prompt still reaches the row as display-only (no button).
    await postHook(daemon.port, 'codex_session_start', { ...base, hook_event_name: 'SessionStart', source: 'startup' });
    await postHook(daemon.port, 'codex_user_prompt_submit', { ...base, turn_id: turns[0], hook_event_name: 'UserPromptSubmit', prompt: 'approval unattended' });
    const started = Date.now();
    expect(await runHold(turns[0])).toEqual({ code: 0, stdout: '' });
    expect(Date.now() - started).toBeLessThan(5_000);
    const client = await connect(daemon.port);
    try {
      const unattended = await waitFor('display-only prompt', () => {
        const r = row(client.frames);
        return r?.state === 'awaiting_permission' ? r : undefined;
      });
      expect(unattended.requestId).toBeUndefined();
      for (const [index, decision] of (['allow', 'deny'] as const).entries()) {
        await postHook(daemon.port, 'codex_user_prompt_submit', { ...base, turn_id: turns[index], hook_event_name: 'UserPromptSubmit', prompt: `approval ${decision}` });
        const answered = runHold(turns[index]);
        const held = await waitFor(`held approval (${decision})`, () => {
          const r = row(client.frames);
          return typeof r?.requestId === 'string' ? r : undefined;
        });
        expect(held).toMatchObject({ state: 'awaiting_permission', question: vectors.capturedQuestion, agentType: 'codex-cli' });
        client.send({ type: 'permission_decision', requestId: held.requestId, decision });
        const out = await answered;
        expect(out.code).toBe(0);
        expect(JSON.parse(out.stdout)).toEqual(body(decision));
        await waitFor(`prompt cleared after ${decision}`, () => {
          const r = row(client.frames);
          return r && !r.requestId && r.state !== 'awaiting_permission' ? true : undefined;
        });
      }
      // The Stream Deck's Allow / Deny keys send an option press on the
      // session inside session_command, echoing the question they show — no
      // permission_decision. The Deny pressed against another prompt (the
      // hold it was drawn for has been replaced) must answer nothing, so the
      // decision that reaches Codex is the Allow that names this one.
      await postHook(daemon.port, 'codex_user_prompt_submit', { ...base, turn_id: turns[3], hook_event_name: 'UserPromptSubmit', prompt: 'approval by deck key' });
      const keyed = runHold(turns[3]);
      const keyHeld = await waitFor('held approval (deck key)', () => {
        const r = row(client.frames);
        return typeof r?.requestId === 'string' ? r : undefined;
      });
      const press = (index: number, question: unknown) =>
        client.send({ type: 'session_command', sessionId: rowId, command: { type: 'select_option', index, question } });
      press(1, 'Approve Bash: rm -rf build');
      press(0, keyHeld.question);
      const keyOut = await keyed;
      expect(keyOut.code).toBe(0);
      expect(JSON.parse(keyOut.stdout)).toEqual(body('allow'));
      await waitFor('prompt cleared after the deck key', () => {
        const r = row(client.frames);
        return r && !r.requestId && r.state !== 'awaiting_permission' ? true : undefined;
      });
      // A multi-up panel names the session on a bare select_option, its id
      // cut to the 31 characters a firmware buffer holds.
      await postHook(daemon.port, 'codex_user_prompt_submit', { ...base, turn_id: turns[4], hook_event_name: 'UserPromptSubmit', prompt: 'approval by panel' });
      const paneled = runHold(turns[4]);
      await waitFor('held approval (panel)', () => (typeof row(client.frames)?.requestId === 'string' ? true : undefined));
      client.send({ type: 'select_option', sessionId: rowId.slice(0, 31), index: 1 });
      const panelOut = await paneled;
      expect(panelOut.code).toBe(0);
      expect(JSON.parse(panelOut.stdout)).toEqual(body('deny'));
      await waitFor('prompt cleared after the panel press', () => {
        const r = row(client.frames);
        return r && !r.requestId && r.state !== 'awaiting_permission' ? true : undefined;
      });
      // Ctrl+C under a hold ends the turn it waited in: released with nothing
      // printed, and the prompt goes with the turn instead of lingering.
      await postHook(daemon.port, 'codex_user_prompt_submit', { ...base, turn_id: turns[2], hook_event_name: 'UserPromptSubmit', prompt: 'approval interrupted' });
      const interrupted = runHold(turns[2]);
      await waitFor('held approval (interrupt)', () => (typeof row(client.frames)?.requestId === 'string' ? true : undefined));
      await postHook(daemon.port, 'codex_interrupt', { ...base, turn_id: turns[2], hook_event_name: 'Interrupt' });
      const out = await interrupted;
      expect(out).toEqual({ code: 0, stdout: '' });
      await waitFor('prompt cleared after the interrupt', () => {
        const r = row(client.frames);
        return r && !r.requestId && r.state !== 'awaiting_permission' ? true : undefined;
      });
    } finally {
      client.close();
    }
  });

  it.runIf(POSIX)('accepts events from the installed hook snippet, which finds the daemon via daemon.json', async () => {
    // The exact shell text `agentdeck`'s installer writes into
    // ~/.claude/settings.json, run the way Claude runs it: `sh -c`, payload on
    // stdin, no AGENTDECK_PORT, so the port must come from daemon.json + /health.
    const client = await connect(daemon.port);
    try {
      // A slow discovery probe can fall back to 9120. Never let this fixture
      // reach the developer's real daemon, even when the snippet test fails.
      const bin = join(home, 'guarded-bin');
      const blocked = join(home, 'blocked-hook-destination');
      mkdirSync(bin, { recursive: true });
      const realCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();
      expect(realCurl).toMatch(/^\//);
      writeFileSync(join(bin, 'curl'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    http://127.0.0.1:$AGENTDECK_TEST_PORT/*) ;;
    http://*|https://*) printf '%s\\n' "$arg" >> "$AGENTDECK_TEST_BLOCKED"; exit 86 ;;
  esac
done
exec "$AGENTDECK_TEST_CURL" "$@"
`, { mode: 0o700 });
      const hookEnv = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home,
        AGENTDECK_TEST_PORT: String(daemon.port), AGENTDECK_TEST_CURL: realCurl, AGENTDECK_TEST_BLOCKED: blocked };
      expect(spawnSync(join(bin, 'curl'), ['http://127.0.0.1:1/health'], { env: hookEnv }).status).toBe(86);
      rmSync(blocked);
      const payload = JSON.stringify({ ...SESSION, session_id: 'e2e-session-0002', hook_event_name: 'UserPromptSubmit', prompt: 'via snippet' });
      const run = spawnSync('sh', ['-c', buildHookCommand('UserPromptSubmit')], {
        input: payload,
        env: hookEnv,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(run.status).toBe(0);
      expect(existsSync(blocked), 'hook discovery tried a port outside the isolated daemon').toBe(false);
      await waitFor('snippet prompt on the timeline', () =>
        client.frames.some((f) => f.type === 'timeline_event' && JSON.stringify(f).includes('via snippet')) ? true : undefined);

      // Stop is request-response: the snippet prints the daemon's body (empty here).
      const stop = spawnSync('sh', ['-c', buildHookCommand('Stop')], {
        input: JSON.stringify({ ...SESSION, session_id: 'e2e-session-0002', hook_event_name: 'Stop' }),
        env: hookEnv,
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(stop.status).toBe(0);
      expect(existsSync(blocked), 'Stop tried a port outside the isolated daemon').toBe(false);
      expect(stop.stdout).toBe('');
    } finally {
      client.close();
    }
  });

  it('never reaches for an OpenClaw Gateway on this machine', async () => {
    // The startup line is written after the probes start, so even a filtered
    // run reads it only once the gate has been decided.
    const probe = await waitFor('the startup line',
      () => /Daemon running \(build [^)]*\)\. Gateway probe (\w+)/.exec(daemon.log())?.[1]);
    expect(probe).toBe('off');
    // Where a Gateway does run (a developer's machine), every test above ran
    // well past the first tick at which the probe would have found it.
    expect(daemon.log()).not.toMatch(/OpenClaw Gateway detected/);
    expect(existsSync(join(home, '.openclaw'))).toBe(false);
  });

  it('shuts down cleanly and replays the persisted timeline after a restart', async () => {
    const hermes = { session_id: `hermes-${'f'.repeat(32)}`, pid: daemon.child.pid, prompt: 'restart recovery check' };
    await postHook(daemon.port, 'hermes_user_prompt_submit', hermes);
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
      const roster = await waitFor('post-restart roster', () => client.frames.find(f => f.type === 'sessions_list'));
      expect((roster.sessions as Array<{ agentType?: string }>).some(s => s.agentType === 'hermes')).toBe(false);
      // History is retained, but an orphan Stop cannot restore old working state.
      expect(await (await postHook(daemon.port, 'hermes_stop', hermes)).json()).toMatchObject({ received: false });
      expect(await (await postHook(daemon.port, 'hermes_tool_start', {
        ...hermes, pid: daemon.child.pid, tool_name: 'terminal',
      })).json()).toMatchObject({ received: true });
      await postHook(daemon.port, 'hermes_session_end', hermes);
    } finally {
      client.close();
    }
  }, 40_000);
});
