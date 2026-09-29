import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  negotiateSurface,
  CLAUDE_TOOL_EVENTS_CAPABILITY,
  parseHttpSurfaceIdentity,
  pullOtaResponseStatus,
  SURFACE_SERVER_VERSION,
  SurfaceProtocolError,
  surfaceAllowsEvent,
  validateSurfaceQueryTuple,
  usesPortableReaderProjection,
} from '../surface-protocol.js';

const pocketHeaders = (overrides: Record<string, string> = {}): Record<string, string> => ({
  'agentdeck-surface-protocol': '1',
  'agentdeck-surface-profile': 'portable-reader/v1',
  'agentdeck-client-id': 'io.pocketdaily.reader',
  'agentdeck-client-version': '1.4.1-pocket',
  'agentdeck-product-id': 'io.pocketdaily.reader',
  'agentdeck-capabilities': 'feed.pull,feed.conditional,outbox.push,glance.read,ota.feed,device.telemetry,future.unknown',
  'agentdeck-board': 'xteink_x3',
  'agentdeck-update-channel': 'stable',
  ...overrides,
});

describe('Surface Protocol HTTP identity', () => {
  it('keeps a headerless request in legacy baseline mode', () => {
    expect(parseHttpSurfaceIdentity({})).toBeUndefined();
  });

  it('accepts Pocket Daily and intersects away unknown capabilities', () => {
    expect(parseHttpSurfaceIdentity(pocketHeaders(), 'feed.pull')).toMatchObject({
      protocol: 1,
      profile: 'portable-reader/v1',
      productId: 'io.pocketdaily.reader',
      board: 'xteink_x3',
      updateChannel: 'stable',
      capabilities: ['feed.pull', 'feed.conditional', 'outbox.push', 'glance.read', 'ota.feed', 'device.telemetry'],
    });
  });

  it('fails closed on partial identity, wrong major/profile, and missing route capability', () => {
    expect(() => parseHttpSurfaceIdentity({ 'agentdeck-surface-protocol': '1' })).toThrowError(
      expect.objectContaining({ status: 400, code: 'surface_identity_incomplete' }),
    );
    expect(() => parseHttpSurfaceIdentity(pocketHeaders({ 'agentdeck-surface-protocol': '2' }))).toThrowError(
      expect.objectContaining({ status: 426, code: 'surface_protocol_unsupported' }),
    );
    expect(() => parseHttpSurfaceIdentity(pocketHeaders({ 'agentdeck-surface-profile': 'dashboard-live/v1' }))).toThrowError(
      expect.objectContaining({ status: 406, code: 'surface_profile_route_mismatch' }),
    );
    expect(() => parseHttpSurfaceIdentity(pocketHeaders({ 'agentdeck-capabilities': 'feed.pull' }), 'outbox.push')).toThrowError(
      expect.objectContaining({ status: 403, code: 'surface_capability_required' }),
    );
  });

  it('rejects cross-product, cross-board, and cross-channel identities', () => {
    for (const [header, value, code] of [
      ['agentdeck-product-id', 'dev.agentdeck.dashboard-firmware', 'surface_product_board_mismatch'],
      ['agentdeck-board', 'xteink_x4_wrong', 'surface_product_board_mismatch'],
      ['agentdeck-update-channel', 'beta', 'surface_product_channel_mismatch'],
    ] as const) {
      expect(() => parseHttpSurfaceIdentity(pocketHeaders({ [header]: value }))).toThrowError(
        expect.objectContaining({ status: 409, code }),
      );
    }
  });

  it('requires repeated query tuple members to match instead of overriding headers', () => {
    const identity = parseHttpSurfaceIdentity(pocketHeaders(), 'ota.feed')!;
    expect(() => validateSurfaceQueryTuple(identity, new URLSearchParams({
      productId: 'io.pocketdaily.reader', board: 'xteink_x3', updateChannel: 'stable',
    }))).not.toThrow();
    expect(() => validateSurfaceQueryTuple(identity, new URLSearchParams({
      productId: 'io.pocketdaily.reader', board: 'xteink_x4', updateChannel: 'stable',
    }))).toThrowError(expect.objectContaining({ status: 409, code: 'surface_query_identity_mismatch' }));
  });

  it('activates the same projection from headers without removing the legacy query', () => {
    const identity = parseHttpSurfaceIdentity(pocketHeaders(), 'feed.pull');
    expect(usesPortableReaderProjection(identity, new URLSearchParams())).toBe(true);
    expect(usesPortableReaderProjection(undefined, new URLSearchParams('surface=pocket-reader'))).toBe(true);
    expect(usesPortableReaderProjection(undefined, new URLSearchParams())).toBe(false);
  });

  it('keeps legacy partial OTA resumable and grants 206 only by capability', () => {
    const legacy = parseHttpSurfaceIdentity(pocketHeaders(), 'ota.feed');
    const partial = parseHttpSurfaceIdentity(pocketHeaders({
      'agentdeck-capabilities': 'ota.feed,ota.resume-206',
    }), 'ota.feed');

    expect(pullOtaResponseStatus(230_959, legacy)).toBe(200);
    expect(pullOtaResponseStatus(230_959, partial)).toBe(206);
    expect(pullOtaResponseStatus(0, partial)).toBe(200);
  });
});

describe('Surface Protocol WebSocket negotiation', () => {
  it('keeps Claude tool history opt-in for dashboard clients', () => {
    const result = negotiateSurface({
      protocol: 1,
      clientId: 'push-2',
      clientVersion: '0.1.0',
      productId: 'push-2',
      profiles: [{ id: 'dashboard-live/v1', capabilities: ['timeline.read', CLAUDE_TOOL_EVENTS_CAPABILITY] }],
    });
    expect(result.capabilities).toEqual(['timeline.read', CLAUDE_TOOL_EVENTS_CAPABILITY]);
  });

  it('selects portable-reader/v1 and returns only the capability intersection', () => {
    const result = negotiateSurface({
      protocol: 1,
      clientId: 'io.pocketdaily.reader',
      clientVersion: '1.4.1-pocket',
      productId: 'io.pocketdaily.reader',
      profiles: [{
        id: 'portable-reader/v1',
        capabilities: ['feed.pull', 'ota.feed', 'inbox.ws', 'future.unknown'],
      }],
    });
    expect(result.welcome).toMatchObject({
      type: 'surface_welcome',
      protocol: 1,
      profile: 'portable-reader/v1',
      capabilities: ['feed.pull', 'ota.feed'],
    });
    expect(result.welcome.serverVersion).toBe(SURFACE_SERVER_VERSION);
  });

  it('keeps the checked welcome fixture derived from runtime negotiation', () => {
    const fixture = JSON.parse(readFileSync(new URL(
      '../../../schemas/surface-protocol/v1/fixtures/portable-reader/surface-welcome.json', import.meta.url,
    ), 'utf8'));
    const result = negotiateSurface({
      protocol: 1,
      clientId: 'io.pocketdaily.reader',
      clientVersion: '1.4.1-pocket',
      productId: 'io.pocketdaily.reader',
      profiles: [{ id: 'portable-reader/v1', capabilities: fixture.capabilities }],
    });
    expect(result.welcome).toEqual(fixture);
  });

  it('does not negotiate inbox.ws before the runtime contract exists', () => {
    const result = negotiateSurface({
      protocol: 1,
      clientId: 'io.pocketdaily.reader',
      clientVersion: '1.4.1-pocket',
      productId: 'io.pocketdaily.reader',
      profiles: [{ id: 'portable-reader/v1', capabilities: ['inbox.ws'] }],
    });
    expect(result.capabilities).toEqual([]);
  });

  it('negotiates licensed learning-pack delivery for portable readers', () => {
    const result = negotiateSurface({
      protocol: 1,
      clientId: 'io.pocketdaily.reader',
      clientVersion: '1.4.1-pocket',
      productId: 'io.pocketdaily.reader',
      profiles: [{
        id: 'portable-reader/v1',
        capabilities: ['learning.pack.read', 'learning.pack.update'],
      }],
    });
    expect(result.capabilities).toEqual(['learning.pack.read', 'learning.pack.update']);
  });

  it('negotiates automatic font-pack delivery for portable readers', () => {
    const result = negotiateSurface({
      protocol: 1,
      clientId: 'io.pocketdaily.reader',
      clientVersion: '1.4.1-pocket',
      productId: 'io.pocketdaily.reader',
      profiles: [{
        id: 'portable-reader/v1',
        capabilities: ['font.pack.read', 'font.pack.update'],
      }],
    });
    expect(result.capabilities).toEqual(['font.pack.read', 'font.pack.update']);
  });

  it('bounds portable WebSocket traffic to welcome and liveness events', () => {
    expect(surfaceAllowsEvent('portable-reader/v1', 'surface_welcome')).toBe(true);
    expect(surfaceAllowsEvent('portable-reader/v1', 'connection')).toBe(true);
    expect(surfaceAllowsEvent('portable-reader/v1', 'state_update')).toBe(false);
    expect(surfaceAllowsEvent('portable-reader/v1', 'usage')).toBe(false);
    expect(surfaceAllowsEvent('portable-reader/v1', 'timeline_history')).toBe(false);
  });

  it('rejects unknown majors, profiles, and unregistered portable products', () => {
    const base = {
      clientId: 'io.pocketdaily.reader', clientVersion: '1.4.1-pocket', productId: 'io.pocketdaily.reader',
    };
    expect(() => negotiateSurface({ ...base, protocol: 2, profiles: [] })).toThrow(SurfaceProtocolError);
    expect(() => negotiateSurface({ ...base, protocol: 1, profiles: [{ id: 'unknown/v1', capabilities: [] }] }))
      .toThrowError(expect.objectContaining({ status: 406 }));
    expect(() => negotiateSurface({
      ...base, productId: 'com.example.unregistered', protocol: 1,
      profiles: [{ id: 'portable-reader/v1', capabilities: ['feed.pull'] }],
    })).toThrowError(expect.objectContaining({ status: 422 }));
  });
});
