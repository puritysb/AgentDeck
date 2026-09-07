import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveGatewayHealth } from '@agentdeck/shared';

const VECTORS = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../shared/gateway-health-vectors.json', import.meta.url)), 'utf8'));

describe('resolveGatewayHealth (shared vectors)', () => {
  it('reads every measured payload shape the same way the Swift daemon does', () => {
    for (const c of VECTORS.cases) {
      const got = resolveGatewayHealth(c.payload);
      expect({ known: got.known, hasError: got.hasError, reason: got.reason }, c.name)
        .toEqual({ known: c.expect.known, hasError: c.expect.hasError, reason: c.expect.reason });
      if (c.expect.detail !== undefined) expect(got.detail, c.name).toBe(c.expect.detail);
    }
  });

  // The regression: `!(payload.ok)` turned every frame without a usable `ok`
  // into an error, and the OpenClaw creature went SICK until the next good
  // frame — up to 5 minutes on OpenClaw's 300 s health-monitor interval.
  it('never claims an error from a frame that did not say', () => {
    for (const payload of [undefined, null, {}, { uptime: 1 }, { ok: 'yes' }, { ok: null }, { checks: [] }, { status: '' }]) {
      const v = resolveGatewayHealth(payload);
      expect(v.known, JSON.stringify(payload)).toBe(false);
      expect(v.hasError, JSON.stringify(payload)).toBe(false);
    }
  });

  it('keeps the caller on its previous value when the frame is unreadable', () => {
    // How the daemons use it: unknown must not move the flag in either direction.
    for (const previous of [true, false]) {
      const v = resolveGatewayHealth({ uptime: 1 });
      const next = v.known ? v.hasError : previous;
      expect(next).toBe(previous);
    }
  });
});
