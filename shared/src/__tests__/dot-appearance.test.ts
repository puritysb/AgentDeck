import { expect, it } from 'vitest';
import { DOT_APPEARANCE_RULES as R, defaultDotRGBA, validDotAppearance, compactDotAppearance, DOT_HABITAT_RULES as H, dotHabitatOffset } from '../dot-appearance.js';
import { dotSurfaceSnapshot, dotDeckPresentation } from '../dot-deck.js';
it('rejects malformed character payloads without replacing the default identity', () => {
  const a = { version:R.version,id:'a'.repeat(64),rgba:Buffer.from(defaultDotRGBA()).toString('base64') };
  expect(validDotAppearance(a)).toBe(true);
  expect(validDotAppearance({...a,version:2})).toBe(false);
  expect(validDotAppearance({...a,rgba:a.rgba.slice(1)})).toBe(false);
  expect(validDotAppearance({...a,png:'<svg/>'})).toBe(false);
  expect(compactDotAppearance({...a,png:'<svg/>'})).toBeNull();
});
it('bounds compact monotonic validity to actual report age and expiry, including legacy unknown expiry', () => {
  const now=1800000000000;
  const s={configured:true,hosting:true,reportState:'working',reportedAt:now,expiresAt:null};
  expect(dotSurfaceSnapshot(s,null,null,now).validForMs).toBeGreaterThan(0);
  expect(dotSurfaceSnapshot({...s,expiresAt:now+500},null,null,now).validForMs).toBe(500);
  expect(dotSurfaceSnapshot({...s,reportedAt:now+1},null,null,now).code).toBe(7);
  expect(dotSurfaceSnapshot({...s,hosting:false},null,null,now).code).toBe(1);
  expect(dotDeckPresentation(s,now+1000000).label).toBe('OLD REPORT');
});

it('describes missing reports without asserting a connection or global idle', () => {
  expect(dotDeckPresentation({configured:true,hosting:true,reportState:null,reportedAt:null,expiresAt:null}).label).toBe('AWAITING ACTIVITY');
});

it('distinguishes missing authorization and clears working on revocation without guessing legacy state', () => {
  const now = 1800000000000;
  const dot = { configured: true, hosting: true, reportState: 'working', reportedAt: now, expiresAt: null };
  expect(dotSurfaceSnapshot({...dot, authorized:false}, null, null, now).code).toBe(8);
  expect(dotSurfaceSnapshot({...dot, authorized:false}, null, null, now).validForMs).toBe(0);
  expect(dotSurfaceSnapshot({...dot, authorized:true}, null, null, now).code).toBe(2);
  expect(dotSurfaceSnapshot(dot, null, null, now).code).toBe(2);
  expect(dotDeckPresentation({...dot, authorized:false, hosting:false}, now).label).toBe('HOST STOPPED');
});

it('keeps the buoyant orb in its upper-water pocket and closes its current loop', () => {
  for (let seconds = 0; seconds <= H.periodSeconds; seconds += 0.125) {
    const p = dotHabitatOffset(seconds, true, true);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
    expect(H.homeY + p.y * H.travelY).toBeLessThan(0.3);
    expect(H.homeX + p.x * H.travelX).toBeGreaterThan(0.5);
    const next = dotHabitatOffset(seconds + H.periodSeconds, true, true);
    expect(next.x).toBeCloseTo(p.x, 10);
    expect(next.y).toBeCloseTo(p.y, 10);
  }
  for (const seconds of [0, 3, 99, NaN, Infinity]) {
    expect(dotHabitatOffset(seconds, false, true)).toEqual({ x: 0, y: 0 });
    expect(dotHabitatOffset(seconds, true, false)).toEqual({ x: 0, y: 0 });
  }
});
