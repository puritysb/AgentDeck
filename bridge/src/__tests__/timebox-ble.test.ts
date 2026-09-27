import { describe, expect, it } from 'vitest';
import { deviceId, type TimeboxDevice } from '../timebox/timebox-settings.js';
import { renderFrame } from '../pixoo/pixoo-renderer.js';
import { paintTimeboxOffline } from '../pixoo/micro-glyphs.js';
import { State } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';

describe('Timebox device identity', () => {
  // Timebox Mini is BLE-only (the legacy SPP variant was removed); deviceId is
  // the BLE address used as the stable key for sync_ble.py.
  it('uses the BLE address as the device id', () => {
    const d: TimeboxDevice = { address: '7CF31CA8-84EE-36BB-52AB-CC5515910C34', name: 'x' };
    expect(deviceId(d)).toBe('7CF31CA8-84EE-36BB-52AB-CC5515910C34');
  });
});

describe('micro layout (Timebox 11×11)', () => {
  const claudeSession = (state: string): SessionInfo[] =>
    [{ id: 's1', alive: true, agentType: 'claude-code', state } as unknown as SessionInfo];
  const codexSession = (state: string): SessionInfo[] =>
    [{ id: 'cx1', alive: true, agentType: 'codex-cli', state } as unknown as SessionInfo];
  const openCodeSession = (state: string): SessionInfo[] =>
    [{ id: 'oc1', alive: true, agentType: 'opencode', state } as unknown as SessionInfo];
  const openClawSession = (state: string): SessionInfo[] =>
    [{ id: 'gw1', alive: true, agentType: 'openclaw', state } as unknown as SessionInfo];
  const antigravitySession = (state: string): SessionInfo[] =>
    [{ id: 'ag1', alive: true, agentType: 'antigravity', state } as unknown as SessionInfo];
  const pixel = (buf: Uint8Array, x: number, y: number) => {
    const i = (y * 11 + x) * 3;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };

  it('returns a size²·3 RGB buffer', () => {
    const buf = renderFrame(null, null, [], 1000, 32, 'micro');
    expect(buf.length).toBe(32 * 32 * 3);
  });

  it('draws a bright dominant creature for a processing session', () => {
    const buf = renderFrame(
      { state: State.PROCESSING, agentType: 'claude-code' } as never,
      null, claudeSession('processing'), 1000, 32, 'micro',
    );
    let bright = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] > 120) bright++;
    expect(bright).toBeGreaterThan(50); // a sizeable creature, not just a status field
  });

  it('degrades parent-linked subagents to fixed perimeter companions', () => {
    const buf = renderFrame(
      { state: State.PROCESSING, agentType: 'claude-code' } as never,
      null,
      claudeSession('processing'),
      1_000,
      11,
      'micro',
      { s1: { activeCount: 2 } },
    );

    expect(pixel(buf, 0, 0)).toEqual([0, 229, 255]);
    expect(pixel(buf, 10, 0)).toEqual([0, 229, 255]);
  });

  it('shows the device-native standby tide when no session exists', () => {
    const buf = renderFrame(null, null, [], 1000, 11, 'micro');
    expect(pixel(buf, 5, 6)).not.toEqual([2, 6, 10]);
    expect(pixel(buf, 5, 5)).toEqual([2, 6, 10]);
    // Idle status uses a dim continuous frame with brighter corners.
    expect(pixel(buf, 0, 0)[1]).toBeGreaterThan(pixel(buf, 0, 0)[0]);
    expect(pixel(buf, 5, 0)[1]).toBeGreaterThan(pixel(buf, 5, 0)[0]);
    expect(pixel(buf, 10, 10)[1]).toBeGreaterThan(pixel(buf, 10, 10)[0]);
  });

  it('provides a static dark farewell badge for a stopped daemon', () => {
    const badge = new Uint8Array(11 * 11 * 3);
    paintTimeboxOffline(badge);
    expect(pixel(badge, 0, 0)).toEqual([0, 48, 56]);
    expect(pixel(badge, 5, 5)).toEqual([68, 88, 92]);
    const lit = Array.from({ length: 121 }, (_, i) => {
      const p = pixel(badge, i % 11, Math.floor(i / 11));
      return p.some((v, channel) => v !== [2, 6, 10][channel]);
    }).filter(Boolean).length;
    expect(lit).toBeLessThan(50);
  });

  it('does not mistake a live empty roster for daemon offline', () => {
    const empty = renderFrame(
      { state: State.DISCONNECTED } as never, null, [], 1000, 11, 'micro',
    );
    const badge = new Uint8Array(11 * 11 * 3);
    paintTimeboxOffline(badge);
    expect(empty).not.toEqual(badge);
    expect(pixel(empty, 5, 6)).not.toEqual([2, 6, 10]);
  });

  it('keeps gateway errors on a red perimeter rail without tinting identity', () => {
    const buf = renderFrame(
      { gatewayHasError: true } as never, null, [], 1000, 11, 'micro',
    );
    expect(pixel(buf, 0, 0)[0]).toBeGreaterThan(pixel(buf, 0, 0)[1]);
    expect(pixel(buf, 0, 0)[0]).toBeGreaterThan(pixel(buf, 0, 0)[2]);
    expect(pixel(buf, 5, 5)).toEqual([2, 6, 10]);
  });

  it.each([
    ['claude-code', claudeSession('idle'), 'warm'],
    ['codex-cli', codexSession('idle'), 'cool'],
    ['opencode', openCodeSession('idle'), 'neutral'],
    ['openclaw', openClawSession('idle'), 'red'],
  ] as const)('maps %s to its shaded official mark and product color', (agentType, sessions, tone) => {
    const buf = renderFrame(
      { state: State.IDLE, agentType } as never,
      null, sessions, 1000, 11, 'micro',
    );
    const interior = Array.from({ length: 9 * 9 }, (_, i) => pixel(buf, i % 9 + 1, Math.floor(i / 9) + 1));
    const vivid = interior.filter((p) => Math.max(...p) > 180);
    expect(vivid.length).toBeGreaterThan(4);
    if (tone === 'cool') expect(vivid.some((p) => p[2] > p[0] * 1.8)).toBe(true);
    else if (tone === 'neutral') expect(vivid.some((p) => Math.abs(p[0] - p[2]) < 3)).toBe(true);
    else expect(vivid.some((p) => p[0] > p[1] * 1.8)).toBe(true);
  });

  it('preserves OpenCode negative space and OpenClaw teal eyes', () => {
    const openCode = renderFrame(
      { state: State.IDLE, agentType: 'opencode' } as never,
      null, openCodeSession('idle'), 1000, 11, 'micro',
    );
    const openClaw = renderFrame(
      { state: State.IDLE, agentType: 'openclaw' } as never,
      null, openClawSession('idle'), 1000, 11, 'micro',
    );
    expect(pixel(openCode, 5, 5)).toEqual([2, 6, 10]);
    expect(pixel(openClaw, 4, 4)).toEqual([0, 211, 188]);
    expect(pixel(openClaw, 7, 4)).toEqual([0, 211, 188]);
  });

  it('renders the generated Antigravity mark as a multicolor open arc', () => {
    const buf = renderFrame(
      { state: State.IDLE, agentType: 'antigravity' } as never,
      null, antigravitySession('idle'), 1000, 11, 'micro',
    );
    const colors = new Set<string>();
    for (let y = 1; y <= 9; y++) for (let x = 1; x <= 9; x++) {
      const p = pixel(buf, x, y);
      if (p.some((v, i) => v !== [2, 6, 10][i])) colors.add(p.join(','));
    }
    expect(colors.size).toBeGreaterThan(3);
    expect(pixel(buf, 5, 8)).toEqual([2, 6, 10]);
  });
});
