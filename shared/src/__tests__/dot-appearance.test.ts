import { expect, it } from 'vitest';
import { DOT_APPEARANCE_RULES as R, defaultDotRGBA, validDotAppearance, compactDotAppearance } from '../dot-appearance.js';
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
