#!/usr/bin/env node
/** Clean npm candidate acceptance. Build first; no installed app, real daemon,
 * hook configuration, credential, hardware or registry publication is changed.
 * The gh process below is a local protocol fixture, not live GitHub acceptance.
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Build with pnpm build, then pnpm test:packaged [--soak-seconds 60] [--keep-artifacts] [--report path].\nCreates four local tarballs and installs them into a temporary prefix. Never publishes or modifies the shared daemon.',
  );
  process.exit(0);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  assert(args[i + 1] && !args[i + 1].startsWith('--'), `${name} requires a value`);
  return args[i + 1];
}
const soakSeconds = Number(option('--soak-seconds', '60'));
assert(Number.isFinite(soakSeconds) && soakSeconds >= 0 && soakSeconds <= 3600, 'soak must be 0..3600 seconds');
assert(
  process.platform !== 'win32',
  'This POSIX package acceptance uses the installed shell hooks; run Windows runtime CI separately',
);
const reportPath = resolve(option('--report', join(root, 'diagnostics/release-acceptance/packaged-daemon.json')));
const work = await mkdtemp(join(tmpdir(), 'agentdeck-package-acceptance-'));
const packagesDir = join(work, 'packages');
const prefix = join(work, 'installed');
const home = join(work, 'home');
const data = join(home, '.agentdeck');
const fixtures = join(work, 'fixtures');
const pnpm = process.env.AGENTDECK_PNPM || 'pnpm';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let daemon;
const peers = new Set();
const report = {
  sourceCommit: '',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  startedAt: new Date().toISOString(),
  packages: [],
  checks: [],
  limits: [
    'gh API responses are local fixtures; no live GitHub run is claimed',
    'hooks are captured payload replay and installed shell snippets; no real agent turn is claimed',
    'registered devices are WebSocket peers; no physical rendering or transport acceptance is claimed',
    'Swift ownership, store signatures and publication are separate gates',
  ],
};
const cli = join(prefix, 'node_modules/@agentdeck/bridge/dist/cli.js');
const fixtureState = join(fixtures, 'ci.json');
const env = {
  ...process.env,
  PATH: `${fixtures}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CODEX_HOME: join(home, '.codex'),
  AGENTDECK_DATA_DIR: data,
  AGENTDECK_DAEMON_NO_SERIAL: '1',
  AGENTDECK_LOOPBACK_ONLY: '1',
  AGENTDECK_PORT: '',
  AGENTDECK_DAEMON_PORT: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  AGENTDECK_ZAI_API_KEY: '',
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  GH_CONFIG_DIR: join(home, '.gh'),
  AGENTDECK_CLAUDE_USAGE_RECOVERY: '0',
};

async function waitFor(label, probe, timeout = 20_000) {
  const until = Date.now() + timeout;
  do {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (daemon && (daemon.child.exitCode !== null || daemon.child.signalCode !== null)) {
      throw new Error(`Daemon exited during ${label}: ${daemon.output.slice(-4000)}`);
    }
    await delay(100);
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${label}`);
}
async function check(name, fn) {
  const start = Date.now();
  process.stdout.write(`${name} ... `);
  try {
    const evidence = await fn();
    report.checks.push({ name, passed: true, durationMs: Date.now() - start, evidence });
    console.log('passed');
  } catch (error) {
    report.checks.push({ name, passed: false, durationMs: Date.now() - start, error: String(error) });
    throw error;
  }
}
async function health(port = daemon.port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return await res.json();
  } catch {
    /* unavailable is never treated as healthy */
  }
}
async function freePort() {
  const server = createServer();
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => ok(port));
    });
  });
}
async function start(port) {
  assert(port < 9120 || port > 9139, 'Never enter the shared daemon port window');
  const child = spawn(
    process.execPath,
    [
      cli,
      'daemon',
      'start',
      '--foreground',
      '--local',
      '--loopback',
      '--no-build',
      '--port',
      String(port),
      '--port-window',
      `${port}-${port}`,
    ],
    {
      cwd: home,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  daemon = { child, port, output: '' };
  child.stdout.on('data', (b) => {
    daemon.output += b;
  });
  child.stderr.on('data', (b) => {
    daemon.output += b;
  });
  const h = await waitFor('installed daemon health', () => health(port));
  assert.equal(h.pid, child.pid);
  assert.equal(h.isSwift, false);
  assert.equal(h.port, port);
  assert.equal(h.mode, 'daemon');
  assert.match(h.build, /^[a-f0-9]{12}$/);
  return h;
}
async function stop() {
  if (!daemon) return;
  const child = daemon.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  // Supported local shutdown route, addressed to this test's exact child port.
  if ((await health(daemon.port))?.pid === child.pid) {
    await fetch(`http://127.0.0.1:${daemon.port}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } else child.kill('SIGTERM');
  let forced = false;
  const deadline = setTimeout(() => {
    forced = true;
    child.kill('SIGKILL');
  }, 10_000);
  await exited;
  clearTimeout(deadline);
  return { selfExited: !forced };
}
async function connect(query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/${query}`);
  const frames = [];
  const sizes = [];
  let parseErrors = 0;
  ws.addEventListener('message', (e) => {
    const raw = String(e.data);
    sizes.push(Buffer.byteLength(raw));
    try {
      frames.push(JSON.parse(raw));
    } catch {
      parseErrors++;
    }
    if (frames.length > 4000) frames.splice(0, 1000);
  });
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('WebSocket connect timeout')), 5000);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        ok();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        fail(new Error('WebSocket failed'));
      },
      { once: true },
    );
  });
  const peer = {
    ws,
    frames,
    sizes,
    errors: () => parseErrors,
    send: (msg) => ws.send(JSON.stringify(msg)),
    roster: () => frames.findLast((f) => f.type === 'sessions_list')?.sessions,
  };
  peers.add(peer);
  return peer;
}
async function hook(event, payload) {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/hooks/${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AgentDeck-Pid': String(process.pid) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, event);
  return response;
}
function row(peer, sid) {
  return peer.roster()?.find((r) => r.id.endsWith(sid));
}
const ciSession = {
  session_id: 'e982a0ae-a062-42c9-b174-4022f0e53228',
  cwd: '/workspace/package-ci',
  permission_mode: 'bypassPermissions',
};
async function ciInvocation(toolId, runId, phase) {
  await writeFile(
    fixtureState,
    JSON.stringify({
      status: 'completed',
      conclusion: phase === 'passed' ? 'success' : 'failure',
      html_url: `https://github.com/acceptance/fixture/actions/runs/${runId}`,
    }),
  );
  await hook('codex_user_prompt_submit', { ...ciSession, prompt: `package acceptance ${toolId}` });
  await hook('codex_tool_start', {
    ...ciSession,
    tool_name: 'Bash',
    tool_use_id: toolId,
    tool_input: { command: `gh run watch ${runId} --exit-status --repo acceptance/fixture`, run_in_background: true },
  });
  await hook('codex_tool_end', { ...ciSession, tool_name: 'Bash', tool_use_id: toolId });
  await hook('codex_stop', ciSession);
}

try {
  for (const dir of [packagesDir, prefix, home, data, fixtures]) await mkdir(dir, { recursive: true });
  report.sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  report.sourceDirty = Boolean(
    (await execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })).stdout.trim(),
  );
  // These three tools can otherwise consult real credentials/processes on a
  // developer Mac. gh only accepts the exact allow-listed fixture endpoint.
  await writeFile(
    join(fixtures, 'gh'),
    `#!${process.execPath}\nimport{readFileSync,appendFileSync}from'node:fs';\nconst a=process.argv.slice(2);if(a.join(' ')!=='api --hostname github.com repos/acceptance/fixture/actions/runs/42'&&a.join(' ')!=='api --hostname github.com repos/acceptance/fixture/actions/runs/43')process.exit(1);appendFileSync(${JSON.stringify(join(fixtures, 'gh-calls'))},a.join(' ')+'\\n');process.stdout.write(readFileSync(${JSON.stringify(fixtureState)},'utf8'));\n`,
  );
  for (const tool of ['security', 'claude', 'codex']) await writeFile(join(fixtures, tool), '#!/bin/sh\nexit 1\n');
  for (const tool of ['gh', 'security', 'claude', 'codex']) await chmod(join(fixtures, tool), 0o755);
  await check('pack coordinated candidate tarballs and install outside the workspace', async () => {
    const versions = [];
    for (const name of ['shared', 'hooks', 'bridge', 'setup']) {
      const packageJson = JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8'));
      versions.push(packageJson.version);
      await execute(pnpm, ['pack', '--pack-destination', packagesDir], {
        cwd: join(root, name),
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    }
    assert.equal(new Set(versions).size, 1, 'Candidate package versions must be coordinated');
    const tarballs = (await readdir(packagesDir)).filter((f) => f.endsWith('.tgz')).map((f) => join(packagesDir, f));
    assert.equal(tarballs.length, 4);
    for (const tarball of tarballs) {
      const entries = (await execute('tar', ['-tzf', tarball])).stdout;
      assert(!entries.includes('/__tests__/'), 'npm tarball must omit test payloads');
      assert(!entries.includes('__pycache__'), 'npm tarball must omit Python cache');
      assert(entries.includes('package/README.md'), 'Every package must ship its README');
      report.packages.push({
        tarball: tarball.split('/').at(-1),
        sha256: createHash('sha256')
          .update(await readFile(tarball))
          .digest('hex'),
      });
    }
    await execute('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', ...tarballs], {
      cwd: work,
      env: { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: join(work, 'npm-cache') },
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const name of ['shared', 'hooks', 'bridge', 'setup']) {
      const pkg = JSON.parse(await readFile(join(prefix, `node_modules/@agentdeck/${name}/package.json`), 'utf8'));
      assert.equal(pkg.version, versions[0]);
      assert(!JSON.stringify(pkg).includes('workspace:'), 'Packed package cannot depend on workspace links');
      Object.assign(
        report.packages.find((p) => p.tarball.startsWith(`agentdeck-${name}-`)),
        { name: pkg.name, version: pkg.version },
      );
    }
    return { version: versions[0], tarballs: tarballs.map((f) => f.split('/').at(-1)) };
  });
  await check('installed native binding works under the daemon executable', async () => {
    const result = JSON.parse(
      (await execute(process.execPath, [cli, 'diag', 'native', '--json'], { cwd: home, env, timeout: 20_000 })).stdout,
    );
    assert.equal(result.ok, true);
    assert.equal(result.betterSqlite3.status, 'ready');
    return result.runtime;
  });
  let dashboard;
  await check('installed daemon identity and isolated posture', async () => {
    let port;
    do {
      port = await freePort();
    } while (port >= 9120 && port <= 9139);
    const h = await start(port);
    dashboard = await connect();
    await waitFor('initial roster', () => dashboard.roster());
    return { port, pid: h.pid, build: h.build, version: h.version, isSwift: h.isSwift };
  });
  await check('installed Claude hook snippet discovers only the temporary daemon', async () => {
    const installed = await import(pathToFileURL(join(prefix, 'node_modules/@agentdeck/hooks/dist/install.js')));
    const sid = 'package-hook-snippet';
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      await new Promise((ok, fail) => {
        const child = spawn('sh', ['-c', installed.buildHookCommand(event)], {
          cwd: home,
          env,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          fail(new Error('Hook snippet timeout'));
        }, 15_000);
        child.on('error', fail);
        child.on('exit', (code) => {
          clearTimeout(timer);
          code === 0 ? ok() : fail(new Error(`Hook exit ${code}`));
        });
        child.stdin.end(
          JSON.stringify({
            session_id: sid,
            cwd: '/workspace/package-hooks',
            hook_event_name: event,
            prompt: 'PACKAGED_HOOK_RECEIPT',
          }),
        );
      });
    }
    await waitFor('hook timeline delivery', () =>
      dashboard.frames.some((f) => f.type === 'timeline_event' && f.entry?.raw === 'PACKAGED_HOOK_RECEIPT'),
    );
    return { discoveredVia: 'temporary HOME/.agentdeck/daemon.json', events: 3 };
  });
  await check('background CI failure, explicit clear, repair and passed rerun', async () => {
    await hook('codex_session_start', ciSession);
    await ciInvocation('failed-watch', 42, 'failed');
    await waitFor(
      'failed CI evidence',
      () => row(dashboard, ciSession.session_id)?.waitingOn?.phase === 'failed',
      40_000,
    );
    const failed = row(dashboard, ciSession.session_id).waitingOn;
    assert.equal(failed.agentWaiting, false);
    assert.equal(failed.runId, 42);
    assert.equal(failed.evidence, 'github');
    await hook('codex_user_prompt_submit', { ...ciSession, prompt: 'repair the failing check' });
    await waitFor('explicit null CI clear', () => row(dashboard, ciSession.session_id)?.waitingOn === null);
    await hook('codex_tool_start', {
      ...ciSession,
      tool_name: 'Bash',
      tool_use_id: 'repair',
      tool_input: { command: 'pnpm test' },
    });
    await hook('codex_tool_end', { ...ciSession, tool_name: 'Bash', tool_use_id: 'repair' });
    await ciInvocation('passed-watch', 43, 'passed');
    await waitFor(
      'passed CI evidence',
      () => row(dashboard, ciSession.session_id)?.waitingOn?.phase === 'passed',
      45_000,
    );
    const passed = row(dashboard, ciSession.session_id).waitingOn;
    assert.equal(passed.runId, 43);
    assert(dashboard.frames.some((f) => f.type === 'timeline_event' && f.entry?.raw === 'CI failed'));
    assert(dashboard.frames.some((f) => f.type === 'timeline_event' && f.entry?.raw === 'CI passed'));
    return {
      failedRun: 42,
      passedRun: 43,
      evidence: passed.evidence,
      actualGhFixtureCalls: (await readFile(join(fixtures, 'gh-calls'), 'utf8')).trim().split('\n').length,
    };
  });
  await check('captured real Hermes child and cancelled-turn hooks survive package replay', async () => {
    const delegated = JSON.parse(
      await readFile(join(root, 'bridge/src/__tests__/fixtures/hermes-live-child.json'), 'utf8'),
    );
    const lifecycle = JSON.parse(
      await readFile(join(root, 'bridge/src/__tests__/fixtures/hermes-live-lifecycle.json'), 'utf8'),
    );
    const before = dashboard.frames.length;
    for (const capture of [delegated, lifecycle]) {
      for (const event of capture.events) {
        const response = await hook(event.event, { ...event.payload, pid: process.pid });
        assert.equal((await response.json()).received, true);
        if (event.event === 'hermes_session_start') {
          await waitFor('captured Hermes start roster', () => row(dashboard, event.payload.session_id));
        }
      }
    }
    await waitFor('captured parent reply', () =>
      dashboard.frames
        .slice(before)
        .some((f) => f.type === 'timeline_event' && f.entry?.raw === 'AGENTDECK_LOCAL_CAPTURE_DONE'),
    );
    const frames = dashboard.frames.slice(before);
    const parentId = delegated.events[0].payload.session_id;
    const parentRows = frames
      .filter((f) => f.type === 'sessions_list')
      .flatMap((f) => f.sessions)
      .filter((r) => r.id.includes(parentId));
    assert.equal(new Set(parentRows.map((r) => r.id)).size, 1);
    const replies = frames.filter(
      (f) => f.type === 'timeline_event' && f.entry?.raw === 'AGENTDECK_LOCAL_CAPTURE_DONE',
    );
    assert.equal(replies.length, 1);
    const cancelled = lifecycle.events.filter((e) => e.event === 'hermes_stop' && e.payload.interrupted === true);
    await waitFor(
      'captured cancelled turn ends',
      () =>
        dashboard.frames
          .slice(before)
          .filter(
            (f) =>
              f.type === 'timeline_event' &&
              f.entry?.agentType === 'hermes' &&
              f.entry?.type === 'chat_end' &&
              f.entry.raw.startsWith('Interrupted'),
          ).length === cancelled.length,
    );
    for (const event of lifecycle.events.filter((e) => e.event === 'hermes_session_start')) {
      await hook('hermes_session_end', event.payload);
    }
    return {
      capturedSource: delegated.source.upstreamCommit,
      exportedHooks: delegated.events.length + lifecycle.events.length,
      parentReplies: replies.length,
      cancelledTurns: cancelled.length,
    };
  });
  await check('crowded Hermes conversations retain independent identity and read-only capability', async () => {
    const expected = [];
    for (let i = 0; i < 12; i++) {
      const sid = `hermes-${(i + 1).toString(16).padStart(8, '0')}${'0'.repeat(24)}`;
      const label = `Hermes (${i % 2 ? 'api_server' : 'cli'}) · profile ${i + 1}`;
      const payload = {
        session_id: sid,
        cwd: '',
        project_name: label,
        platform: i % 2 ? 'api_server' : 'cli',
        model: 'acceptance-fixture',
        pid: process.pid,
      };
      await hook('hermes_session_start', payload);
      await hook('hermes_user_prompt_submit', { ...payload, prompt: `CROWDED_PROFILE_${i + 1}` });
      expected.push({ sid, label });
    }
    const rows = await waitFor('12 separate working Hermes roster rows', () => {
      const rows = dashboard.roster()?.filter((r) => r.agentType === 'hermes');
      // Session-start broadcasts the twelfth idle row before the following
      // prompt's processing update reaches the dashboard WebSocket.
      return rows?.length === 12 && rows.every((row) => row.state === 'processing') ? rows : undefined;
    });
    assert.equal(new Set(rows.map((r) => r.id)).size, 12);
    for (const { sid, label } of expected) {
      const r = rows.find((r) => r.id === `observed:hermes:${sid}`);
      assert(r, sid);
      assert.equal(r.projectName, label);
      assert.equal(r.state, 'processing');
      assert.equal(r.controlMode, 'observed');
      assert.equal(r.liveAnswerable, false);
    }
    return {
      conversations: rows.length,
      states: ['processing'],
      privateHomePaths: false,
      limits: 'Fixture labels; actual profile naming is separately tested by observer captures',
    };
  });
  await check('device roster registration, compact frames and disconnect recovery', async () => {
    const android = await connect();
    android.send({
      type: 'client_register',
      clientType: 'android-dashboard',
      devices: [{ id: 'acceptance-tablet', name: 'Acceptance Tablet' }],
    });
    const eink = await connect();
    eink.send({
      type: 'client_register',
      clientType: 'eink-device',
      devices: [{ id: 'acceptance-reader', name: 'Acceptance Reader' }],
    });
    const ulanzi = await connect();
    ulanzi.send({ type: 'client_register', clientType: 'ulanzi-plugin' });
    const board = await connect('?clientType=esp32');
    board.send({ type: 'device_info', board: 'ips_10', version: 'acceptance', wifiConnected: true, capabilities: [] });
    await waitFor('volunteered device roster health', async () => {
      const h = await health();
      return h?.modules?.androidDashboards?.devices?.length &&
        h?.modules?.einkDevices?.devices?.length &&
        h?.modules?.d200h?.connected &&
        h?.modules?.esp32Wifi?.devices?.length
        ? h.modules
        : undefined;
    });
    await hook('hermes_tool_start', {
      session_id: 'hermes-00000001000000000000000000000000',
      tool_name: 'terminal',
      pid: process.pid,
    });
    const compact = await waitFor('compact board roster', () => {
      const frame = board.frames.findLast((f) => f.type === 'sessions_list');
      return frame?.total >= 12 && frame.sessions.length > 0 && frame.rosterRotating === true
        ? frame.sessions
        : undefined;
    });
    assert.equal(board.errors(), 0);
    assert.equal(new Set(compact.map((r) => r.id)).size, compact.length);
    const config = await readFile(join(root, 'esp32/src/config.h'), 'utf8');
    const smallestFirmwareGuard = Math.min(
      ...[...config.matchAll(/PROTOCOL_MAX_MSG_BYTES\s*=\s*(\d+)/g)].map((m) => Number(m[1])),
    );
    assert(Number.isFinite(smallestFirmwareGuard));
    assert(
      board.sizes.every((n) => n <= smallestFirmwareGuard),
      'Board frame exceeds smallest ESP32 inbound JSON allocation guard',
    );
    android.ws.close();
    eink.ws.close();
    ulanzi.ws.close();
    board.ws.close();
    await waitFor('disconnected devices leave health roster', async () => {
      const modules = (await health())?.modules;
      return modules && !modules.androidDashboards && !modules.einkDevices && !modules.d200h;
    });
    // The WiFi board intentionally retains its last snapshot for reboot
    // comparison; reconnect must update that identity rather than duplicate it.
    const returning = await connect('?clientType=esp32');
    returning.send({
      type: 'device_info',
      board: 'ips_10',
      version: 'acceptance-return',
      wifiConnected: true,
      capabilities: [],
    });
    await waitFor('same board reconnect replaces retained snapshot', async () => {
      const devices = (await health())?.modules?.esp32Wifi?.devices;
      return devices?.length === 1 && devices[0].version === 'acceptance-return';
    });
    return {
      registrations: 4,
      compactRows: compact.length,
      maxBoardFrameBytes: Math.max(...board.sizes),
      boardSnapshotRetainedForRebootComparison: true,
      reconnectedBoardIdentities: 1,
    };
  });
  await check('packaged daemon soak keeps responding and emits valid JSON', async () => {
    const until = Date.now() + soakSeconds * 1000;
    let probes = 0;
    let worstHealthMs = 0;
    do {
      const started = Date.now();
      const h = await health();
      assert.equal(h?.pid, daemon.child.pid);
      worstHealthMs = Math.max(worstHealthMs, Date.now() - started);
      probes++;
      assert.equal(dashboard.errors(), 0);
      await delay(Math.min(1000, Math.max(0, until - Date.now())));
    } while (Date.now() < until);
    return { seconds: soakSeconds, probes, worstHealthMs, parseErrors: dashboard.errors() };
  });
  await check('restart preserves timeline and credentials without stale Hermes rows', async () => {
    const token = await readFile(join(data, 'auth-token'), 'utf8');
    const oldPid = daemon.child.pid;
    const port = daemon.port;
    for (const peer of peers) peer.ws.close();
    assert.equal((await stop())?.selfExited, true, 'Shutdown must finish before force-kill fallback');
    assert.equal(await health(port), undefined);
    const before = JSON.parse(await readFile(join(data, 'timeline.json'), 'utf8'));
    assert(before.some((e) => e.raw === 'PACKAGED_HOOK_RECEIPT'));
    const h = await start(port);
    assert.notEqual(h.pid, oldPid);
    assert.equal(await readFile(join(data, 'auth-token'), 'utf8'), token);
    const peer = await connect();
    const history = await waitFor('replayed history', () =>
      peer.frames.find(
        (f) => f.type === 'timeline_history' && f.entries?.some((e) => e.raw === 'PACKAGED_HOOK_RECEIPT'),
      ),
    );
    await waitFor('restarted roster', () => peer.roster());
    assert.equal(peer.roster().filter((r) => r.agentType === 'hermes').length, 0);
    return { historyRows: history.entries.length, credentialRetained: true, oldPid, newPid: h.pid };
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const peer of peers) peer.ws.close();
  await stop();
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true });
  // Reports deliberately omit health credentials, hook command text and logs.
  if (args.includes('--keep-artifacts')) report.artifactRoot = work;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!args.includes('--keep-artifacts')) await rm(work, { recursive: true, force: true });
  console.log(`Acceptance report: ${reportPath}`);
}
