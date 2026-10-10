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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
      AGENTDECK_ZAI_API_KEY: '',
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
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
