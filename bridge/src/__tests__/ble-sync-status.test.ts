import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBleLinkTracker, mergeBleLinkSnapshots } from '../ble-sync-status.js';
import { parseStatusLine, BLE_STATUS_LINE_PREFIX } from '../ble-sync-spawn.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('parseStatusLine', () => {
  it('parses an AGENTDECK_STATUS line', () => {
    const line = `${BLE_STATUS_LINE_PREFIX}{"connected":true,"phase":"streaming","hasFrame":true,"dimmed":false,"error":null}`;
    expect(parseStatusLine(line)).toEqual({
      connected: true,
      phase: 'streaming',
      hasFrame: true,
      dimmed: false,
      error: null,
    });
  });

  it('rejects a non-status line and malformed JSON', () => {
    expect(parseStatusLine('Frame sent (abc @ 100%)')).toBeNull();
    expect(parseStatusLine(`${BLE_STATUS_LINE_PREFIX}{not json`)).toBeNull();
    // An array is valid JSON but not a status payload.
    expect(parseStatusLine(`${BLE_STATUS_LINE_PREFIX}[1,2]`)).toBeNull();
  });
});

describe('createBleLinkTracker', () => {
  it('reports "sync not started" before anything is spawned', () => {
    const t = createBleLinkTracker();
    const s = t.snapshot(1);
    expect(s.connected).toBe(false);
    expect(s.statusReason).toBe('sync not started');
  });

  it('reports no device when nothing is configured', () => {
    const t = createBleLinkTracker();
    t.noteSpawn();
    expect(t.snapshot(0).statusReason).toBe('no device configured');
  });

  it('goes connected on a streaming status line — the regression this fixes', () => {
    const t = createBleLinkTracker();
    t.noteSpawn();
    // Before the status-line contract existed the supervisor had nothing to fold
    // in here, so a happily streaming panel reported connected:false forever and
    // every dashboard drew it as disconnected.
    t.applyStatusLine({ connected: true, phase: 'streaming', hasFrame: true, dimmed: false, error: null });
    const s = t.snapshot(1);
    expect(s.connected).toBe(true);
    expect(s.hasFrame).toBe(true);
    expect(s.statusReason).toBe('connected');
    expect(s.lastPushAtMs).not.toBeNull();
  });

  it('distinguishes host-display pause from a dead link', () => {
    const t = createBleLinkTracker();
    t.noteSpawn();
    t.applyStatusLine({ connected: true, phase: 'streaming', hasFrame: true, dimmed: true, error: null });
    const s = t.snapshot(1);
    expect(s.connected).toBe(true);
    expect(s.displayDimmed).toBe(true);
    expect(s.statusReason).toBe('paused: host display asleep');
  });

  it('keeps hasFrame sticky across a disconnect and surfaces the error', () => {
    const t = createBleLinkTracker();
    t.noteSpawn();
    t.applyStatusLine({ connected: true, phase: 'streaming', hasFrame: true, dimmed: false, error: null });
    t.applyStatusLine({ connected: false, phase: 'disconnected', hasFrame: true, dimmed: false, error: 'BLE link lost' });
    const s = t.snapshot(1);
    expect(s.connected).toBe(false);
    expect(s.hasFrame).toBe(true);
    expect(s.lastError).toBe('BLE link lost');
    expect(s.statusReason).toBe('BLE link lost');
  });

  it('clears a stale error once the client recovers', () => {
    const t = createBleLinkTracker();
    t.noteSpawn();
    t.applyStatusLine({ connected: false, phase: 'error', hasFrame: false, dimmed: false, error: 'BLE connection error: timeout' });
    t.applyStatusLine({ connected: true, phase: 'connected', hasFrame: false, dimmed: false, error: null });
    const s = t.snapshot(1);
    expect(s.lastError).toBeNull();
    expect(s.statusReason).toBe('connected');
  });

  it('reports the backoff window after an exit, then falls back to connecting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T00:00:00Z'));
    const t = createBleLinkTracker();
    t.noteSpawn();
    // A bare exit with no captured output must still explain itself.
    t.noteExit(null, Date.now() + 5_000);
    expect(t.snapshot(1).statusReason).toBe('retrying (backed off)');
    vi.advanceTimersByTime(6_000);
    expect(t.snapshot(1).statusReason).toBe('connecting…');
  });

  it('surfaces a missing BLE runtime instead of an unexplained disconnect', () => {
    const t = createBleLinkTracker();
    t.noteUnavailable('BLE sync unavailable: venv missing');
    expect(t.snapshot(1).statusReason).toBe('BLE sync unavailable: venv missing');
  });

  it('a respawn clears the connected flag until the child reports again', () => {
    const t = createBleLinkTracker();
    t.noteSpawn();
    t.applyStatusLine({ connected: true, phase: 'streaming', hasFrame: true, dimmed: true, error: null });
    t.noteSpawn();
    const s = t.snapshot(1);
    expect(s.connected).toBe(false);
    expect(s.displayDimmed).toBe(false);
  });
});

describe('mergeBleLinkSnapshots', () => {
  const snap = (over: Partial<ReturnType<ReturnType<typeof createBleLinkTracker>['snapshot']>>) => ({
    connected: true,
    hasFrame: true,
    displayDimmed: false,
    statusReason: 'connected',
    lastError: null,
    lastPushAtMs: 1000,
    ...over,
  });

  it('is connected only when every panel is', () => {
    expect(mergeBleLinkSnapshots([snap({}), snap({})], 2).connected).toBe(true);
    const mixed = mergeBleLinkSnapshots(
      [snap({}), snap({ connected: false, statusReason: 'BLE link lost', lastError: 'BLE link lost' })],
      2,
    );
    expect(mixed.connected).toBe(false);
    expect(mixed.statusReason).toBe('BLE link lost');
  });

  it('reports no-device state when there are no trackers yet', () => {
    const merged = mergeBleLinkSnapshots([], 0);
    expect(merged.connected).toBe(false);
    expect(merged.statusReason).toBe('no device configured');
  });

  it('takes the newest push time across panels', () => {
    const merged = mergeBleLinkSnapshots([snap({ lastPushAtMs: 10 }), snap({ lastPushAtMs: 99 })], 2);
    expect(merged.lastPushAtMs).toBe(99);
  });
});
