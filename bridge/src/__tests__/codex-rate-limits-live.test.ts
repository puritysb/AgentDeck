import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseLiveCodexRateLimits,
  pickFresherCodexRateLimits,
  shouldQueryCodexRateLimitsLive,
  queryCodexRateLimitsLive,
  codexSpawnPlan,
  __resetCodexRateLimitsLiveForTest,
} from '../codex-rate-limits-live.js';

// The exact `account/rateLimits/read` result observed from codex-cli 0.146.0 on
// 2026-08-05, at the moment the weekly quota was exhausted — the reading the
// passive rollout path structurally cannot produce.
const liveResult = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1786459585 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'plus',
    rateLimitReachedType: 'rate_limit_reached',
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
};

describe('parseLiveCodexRateLimits', () => {
  it('maps the app-server shape onto the wire shape', () => {
    const parsed = parseLiveCodexRateLimits(liveResult, '2026-08-05T12:00:00.000Z');
    expect(parsed).not.toBeNull();
    expect(parsed!.primary).toEqual({
      usedPercent: 100,
      windowMinutes: 10080,
      resetsAt: new Date(1786459585 * 1000).toISOString(),
    });
    expect(parsed!.secondary).toBeUndefined();
    expect(parsed!.planType).toBe('plus');
    expect(parsed!.limitId).toBe('codex');
    expect(parsed!.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' });
    // Stamped with the query instant, not a rollout timestamp — that is what
    // makes a live answer read as fresh downstream.
    expect(parsed!.capturedAt).toBe('2026-08-05T12:00:00.000Z');
  });

  it('accepts the rollout spelling of the window length', () => {
    const parsed = parseLiveCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 8, windowMinutes: 300 } } },
      '2026-08-05T12:00:00.000Z',
    );
    expect(parsed!.primary).toEqual({ usedPercent: 8, windowMinutes: 300, resetsAt: undefined });
  });

  it('clamps out-of-range percentages', () => {
    const parsed = parseLiveCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 143, windowDurationMins: 300 } } },
      '2026-08-05T12:00:00.000Z',
    );
    expect(parsed!.primary!.usedPercent).toBe(100);
  });

  it('returns null when the result carries no usable limits', () => {
    expect(parseLiveCodexRateLimits(null, 'x')).toBeNull();
    expect(parseLiveCodexRateLimits({}, 'x')).toBeNull();
    expect(parseLiveCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, 'x')).toBeNull();
  });
});

describe('pickFresherCodexRateLimits', () => {
  const at = (iso: string, usedPercent: number) => ({
    primary: { usedPercent, windowMinutes: 10080 },
    capturedAt: iso,
  });

  it('prefers the newer capture', () => {
    const passive = at('2026-08-04T18:38:42.076Z', 94);
    const live = at('2026-08-05T12:18:00.000Z', 100);
    expect(pickFresherCodexRateLimits(passive, live)).toBe(live);
  });

  it('keeps a passive reading that is newer than the cached live one', () => {
    const passive = at('2026-08-05T13:00:00.000Z', 3);
    const live = at('2026-08-05T12:18:00.000Z', 100);
    expect(pickFresherCodexRateLimits(passive, live)).toBe(passive);
  });

  it('handles either side being absent', () => {
    const live = at('2026-08-05T12:18:00.000Z', 100);
    expect(pickFresherCodexRateLimits(null, live)).toBe(live);
    expect(pickFresherCodexRateLimits(live, null)).toBe(live);
    expect(pickFresherCodexRateLimits(null, null)).toBeNull();
  });

  it('lets a stamped snapshot beat an unstamped one', () => {
    const unstamped = { primary: { usedPercent: 94, windowMinutes: 10080 } };
    const live = at('2026-08-05T12:18:00.000Z', 100);
    expect(pickFresherCodexRateLimits(unstamped, live)).toBe(live);
  });
});

describe('shouldQueryCodexRateLimitsLive', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');

  it('queries when the passive snapshot has gone quiet', () => {
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: 0,
        consecutiveFailures: 0,
        passiveCapturedAtMs: now - 17 * 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it('skips while Codex is mid-turn (the rollout is writing fresh readings)', () => {
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: 0,
        consecutiveFailures: 0,
        passiveCapturedAtMs: now - 30 * 1000,
      }),
    ).toBe(false);
  });

  it('honours the minimum interval between spawns', () => {
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: now - 60 * 1000,
        consecutiveFailures: 0,
        passiveCapturedAtMs: 0,
      }),
    ).toBe(false);
  });

  it('backs off hard after repeated misses (no Codex CLI installed)', () => {
    const input = {
      nowMs: now,
      lastAttemptMs: now - 6 * 60 * 1000,
      consecutiveFailures: 3,
      passiveCapturedAtMs: 0,
    };
    expect(shouldQueryCodexRateLimitsLive(input)).toBe(false);
    expect(shouldQueryCodexRateLimitsLive({ ...input, lastAttemptMs: now - 31 * 60 * 1000 })).toBe(true);
  });
});

describe('codexSpawnPlan', () => {
  it('runs a plain binary directly on posix', () => {
    expect(codexSpawnPlan('codex', 'darwin')).toEqual({ command: 'codex', shell: false });
    expect(codexSpawnPlan('/usr/local/bin/codex', 'linux')).toEqual({
      command: '/usr/local/bin/codex',
      shell: false,
    });
  });

  it('asks for a shell on Windows .cmd/.bat shims, which spawn refuses to run bare', () => {
    expect(codexSpawnPlan('codex.cmd', 'win32')).toEqual({ command: 'codex.cmd', shell: true });
    expect(codexSpawnPlan('CODEX.BAT', 'win32')).toEqual({ command: 'CODEX.BAT', shell: true });
  });

  it('quotes a shim path with spaces, since the shell re-parses the command line', () => {
    expect(codexSpawnPlan('C:\\Program Files\\nodejs\\codex.cmd', 'win32')).toEqual({
      command: '"C:\\Program Files\\nodejs\\codex.cmd"',
      shell: true,
    });
  });

  it('leaves a real Windows executable alone — the shell is only for the shims', () => {
    expect(codexSpawnPlan('C:\\tools\\codex.exe', 'win32')).toEqual({
      command: 'C:\\tools\\codex.exe',
      shell: false,
    });
  });

  it('never asks for a shell on posix, even for a file that happens to end in .cmd', () => {
    expect(codexSpawnPlan('/opt/codex.cmd', 'darwin')).toEqual({
      command: '/opt/codex.cmd',
      shell: false,
    });
  });
});

describe('queryCodexRateLimitsLive', () => {
  let dir: string;

  beforeEach(() => {
    __resetCodexRateLimitsLiveForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a stand-in app-server that speaks the same stdio JSON-RPC framing. */
  const fakeServer = (body: string): string => {
    const file = path.join(dir, `server-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(file, body);
    return file;
  };

  it('reads the rate limits out of the JSON-RPC stream', async () => {
    const server = fakeServer(`
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ id: msg.id, result: { codexHome: '/tmp' } }) + '\\n');
            // An unsolicited notification lands between the two replies.
            process.stdout.write(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }) + '\\n');
          } else if (msg.method === 'account/rateLimits/read') {
            process.stdout.write(JSON.stringify({ id: msg.id, result: ${JSON.stringify(liveResult)} }) + '\\n');
          }
        }
      });
      setTimeout(() => {}, 60000);
    `);
    const rl = await queryCodexRateLimitsLive({
      binary: process.execPath,
      args: [server],
      timeoutMs: 10000,
    });
    expect(rl).not.toBeNull();
    expect(rl!.primary).toEqual({
      usedPercent: 100,
      windowMinutes: 10080,
      resetsAt: new Date(1786459585 * 1000).toISOString(),
    });
    expect(Date.parse(rl!.capturedAt!)).toBeGreaterThan(0);
  });

  it('resolves null when the server never answers, without hanging', async () => {
    const server = fakeServer(`setTimeout(() => {}, 60000);`);
    const started = Date.now();
    const rl = await queryCodexRateLimitsLive({
      binary: process.execPath,
      args: [server],
      timeoutMs: 300,
    });
    expect(rl).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('resolves null when the binary does not exist', async () => {
    const rl = await queryCodexRateLimitsLive({
      binary: path.join(dir, 'definitely-not-a-binary'),
      timeoutMs: 2000,
    });
    expect(rl).toBeNull();
  });

  it('resolves null when the server exits before replying', async () => {
    const server = fakeServer(`process.exit(1);`);
    const rl = await queryCodexRateLimitsLive({
      binary: process.execPath,
      args: [server],
      timeoutMs: 5000,
    });
    expect(rl).toBeNull();
  });
});
