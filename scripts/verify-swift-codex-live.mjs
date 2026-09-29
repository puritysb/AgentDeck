#!/usr/bin/env node
/** Live, opt-in HTTP/WS replay against an already running sandboxed macOS app.
 * Usage: node scripts/verify-swift-codex-live.mjs --port PORT --pid PID --app /path/AgentDeck.app
 * Does not launch agents, change config/trust, restart daemons or incur model calls.
 * Creates uniquely named synthetic sessions/timeline entries; removes its own roster rows.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    pid: { type: 'string' },
    app: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node scripts/verify-swift-codex-live.mjs --port PORT --pid PID --app /path/AgentDeck.app [--output report.json]',
  );
  process.exit(0);
}
assert.equal(process.platform, 'darwin', 'Requires the real macOS app');
const port = Number(values.port),
  pid = Number(values.pid);
assert(Number.isInteger(port) && port > 0 && port < 65536, 'Explicit registry-resolved --port required');
assert(Number.isInteger(pid) && pid > 1 && values.app, 'Expected --pid and --app required');
const app = resolve(values.app),
  binary = `${app}/Contents/MacOS/AgentDeck`;
const run = randomUUID();
const output = resolve(values.output ?? `diagnostics/swift-codex-live/${run}.json`);
const report = { startedAt: new Date().toISOString(), run, port, pid, app, checks: [], result: 'failed' };
const ids = { hook: randomUUID(), otel: randomUUID(), notify: randomUUID() };
const owned = new Set(Object.values(ids).map((id) => `codex:${id}`));
const base = `http://127.0.0.1:${port}`;
let ws,
  socketError,
  latestRows = [],
  frames = 0,
  ready = false;
let forbiddenWorking = new Set();
const violations = [];
const snapshot = (row) =>
  row && Object.fromEntries(['id', 'state', 'agentType', 'currentTool'].map((k) => [k, row[k]]));
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
async function identity() {
  const health = await request('/health');
  assert.equal(health.isSwift, true, 'Target must be Swift, not the Node daemon');
  assert.equal(health.pid, pid, 'Daemon owner changed; refusing to touch another process');
  return health;
}
async function hook(event, id, fields = {}) {
  await identity();
  return request(`/hooks/${event}`, { session_id: id, cwd: `/tmp/agentdeck-live-${run}-${id}`, ...fields });
}
async function otel(id, names, turn = 'live-turn') {
  await identity();
  return request('/otel/v1/traces', {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: names.map((name) => ({
              name,
              attributes: Object.entries({
                'thread.id': id,
                'turn.id': turn,
                cwd: `/tmp/agentdeck-live-${run}-${id}`,
                'tool.name': 'Read',
              }).map(([key, stringValue]) => ({ key, value: { stringValue } })),
            })),
          },
        ],
      },
    ],
  });
}
async function rows() {
  await identity();
  const status = await request('/status');
  assert(Array.isArray(status.sessions), 'Unreadable roster');
  if (socketError) throw socketError;
  assert.equal(violations.length, 0, `Late OTel changed a hook-owned row: ${JSON.stringify(violations)}`);
  return status.sessions;
}
async function expectRow(label, id, state, agentType) {
  const sid = `codex:${id}`,
    until = Date.now() + 10000;
  let observed;
  do {
    observed = (await rows()).find((r) => r.id === sid);
    const wire = latestRows.find((r) => r.id === sid);
    if (observed?.state === state && wire?.state === state && (!agentType || observed.agentType === agentType)) {
      report.checks.push({ label, passed: true, row: snapshot(observed) });
      console.log(`PASS ${label}`);
      return;
    }
    await delay(200);
  } while (Date.now() < until);
  throw new Error(`${label}: expected ${state}/${agentType ?? '*'}, got ${JSON.stringify(snapshot(observed))}`);
}
try {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe', timeout: 15000 });
  const entitlements = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  assert(
    /<key>com.apple.security.app-sandbox<\/key>\s*<true\s*\/>/.test(entitlements),
    'App Sandbox must remain enabled',
  );
  const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  assert.equal(command, binary, 'PID does not belong to the supplied app');
  report.binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  // Debug builds keep executable Swift code in this dylib.
  try {
    report.debugDylibSha256 = createHash('sha256')
      .update(readFileSync(`${app}/Contents/MacOS/AgentDeck.debug.dylib`))
      .digest('hex');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  report.sandboxed = true;
  const health = await identity();
  ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(health.pairingToken)}`);
  ws.addEventListener('message', ({ data }) => {
    try {
      const event = JSON.parse(data);
      if (event.type !== 'sessions_list') return;
      assert(Array.isArray(event.sessions), 'Malformed WS roster');
      frames++;
      latestRows = event.sessions.filter((r) => owned.has(r.id));
      for (const row of latestRows)
        if (forbiddenWorking.has(row.id) && row.state !== 'idle') violations.push(snapshot(row));
    } catch (error) {
      socketError = error;
    }
  });
  ws.addEventListener('error', () => {
    socketError = new Error('WebSocket failed');
  });
  ws.addEventListener('close', () => {
    if (ready) socketError = new Error('WebSocket closed during replay');
  });
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolveOpen();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('WebSocket connect failed'));
      },
      { once: true },
    );
  });
  ready = true;
  await hook('codex_session_start', ids.hook);
  await expectRow('SessionStart is idle', ids.hook, 'idle', 'codex-cli');
  await hook('codex_user_prompt_submit', ids.hook, { prompt: 'AgentDeck synthetic acceptance fixture' });
  await expectRow('Prompt starts work', ids.hook, 'processing');
  await hook('codex_session_start', ids.hook);
  await expectRow('Repeated SessionStart retains work', ids.hook, 'processing');
  await otel(ids.hook, ['turn/end']);
  await delay(1000);
  await expectRow('OTel end cannot stop hook-owned work', ids.hook, 'processing');
  await hook('codex_stop', ids.hook);
  await expectRow('Stop returns to idle', ids.hook, 'idle');
  forbiddenWorking.add(`codex:${ids.hook}`);
  await otel(ids.hook, ['turn/start', 'codex.tool.call', 'codex.tool.result', 'turn/end']);
  await expectRow('Late OTel batch retains idle', ids.hook, 'idle', 'codex-cli');

  await otel(ids.otel, ['turn/start'], 'first');
  await expectRow('OTel-only fallback starts', ids.otel, 'processing', 'codex-app');
  await otel(ids.otel, ['turn/start'], 'second');
  await otel(ids.otel, ['turn/end'], 'first');
  await delay(1000);
  await expectRow('Old OTel turn cannot end new turn', ids.otel, 'processing');
  await otel(ids.otel, ['turn/end'], 'second');
  await expectRow('Matching OTel end closes fallback', ids.otel, 'idle');

  await hook('codex_turn_complete', ids.notify);
  await delay(1000);
  assert(!(await rows()).some((r) => r.id === `codex:${ids.notify}`), 'Completion-only notify created a phantom row');
  report.checks.push({ label: 'Completion-only notify creates no phantom', passed: true });
  console.log('PASS Completion-only notify creates no phantom');
  await otel(ids.notify, ['turn/start']);
  await expectRow('Notify does not claim hook ownership', ids.notify, 'processing');
  await otel(ids.notify, ['turn/end']);
  await expectRow('Notify plus OTel closes', ids.notify, 'idle');

  // Real wall-clock expiry, without mutating the daemon clock or TTL. Catch
  // transient WS processing frames as well as a row promoted to interactive.
  const deadline = Date.now() + 85000;
  let expired = false;
  while (Date.now() < deadline) {
    const roster = await rows();
    const row = roster.find((r) => r.id === `codex:${ids.hook}`);
    if (!row && !latestRows.some((r) => r.id === `codex:${ids.hook}`)) {
      expired = true;
      break;
    }
    // HTTP and WS snapshots can observe the same eviction at different times.
    // An absent HTTP row is not a revival; wait for WS to catch up as well.
    if (row) assert.equal(row.state, 'idle', 'Late OTel revived terminal state');
    await delay(1000);
  }
  assert(expired, 'Hook row did not expire; late OTel may have promoted it to interactive');
  await otel(ids.hook, ['turn/start', 'codex.tool.call']);
  for (let i = 0; i < 5; i++) {
    await delay(1000);
    assert(!(await rows()).some((r) => r.id === `codex:${ids.hook}`), 'Late OTel resurrected evicted row');
    assert(!latestRows.some((r) => r.id === `codex:${ids.hook}`), 'WS resurrected evicted row');
  }
  report.checks.push({ label: 'Terminal expiry and post-eviction ownership', passed: true });
  console.log('PASS Terminal expiry and post-eviction ownership');
  forbiddenWorking.clear();
  await hook('codex_user_prompt_submit', ids.hook, { prompt: 'AgentDeck synthetic re-engagement fixture' });
  await expectRow('Real hook can re-engage after expiry', ids.hook, 'processing');
  await hook('codex_stop', ids.hook);
  await expectRow('Re-engaged hook stops', ids.hook, 'idle');
  report.result = 'passed';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(`FAIL ${error.message}`);
} finally {
  if (ready) {
    try {
      forbiddenWorking.clear();
      for (const sid of owned) await hook('SessionEnd', sid);
      const until = Date.now() + 10000;
      while ((await rows()).some((r) => owned.has(r.id))) {
        assert(Date.now() < until, 'Synthetic roster cleanup timed out');
        await delay(200);
      }
      report.cleanup = 'own roster rows removed; synthetic timeline evidence retained';
    } catch (error) {
      report.cleanup = error.message;
      report.result = 'failed';
      process.exitCode = 1;
    }
  }
  ready = false;
  ws?.close();
  report.websocketFrames = frames;
  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${output}`);
}
