import { describe, expect, it, vi } from 'vitest';
import { pixooAutoDiscoverFrom } from '../pixoo/pixoo-settings.js';

// Mocked rather than exercised over the wire: the real sweep probes every host
// on each local /24, which is both slow and dependent on the runner's network
// interfaces. What is under test is which of the two steps runs, not either
// step's own behaviour.
const { discoverDevicesMock, getDeviceConfigMock } = vi.hoisted(() => ({
  discoverDevicesMock: vi.fn(async () => [{ name: 'Pixoo64', ip: '10.0.0.5' }]),
  getDeviceConfigMock: vi.fn(async () => null),
}));
vi.mock('../pixoo/pixoo-client.js', () => ({
  discoverDevices: discoverDevicesMock,
  getDeviceConfig: getDeviceConfigMock,
}));

const { discoverPixoo } = await import('../pixoo/pixoo-discover.js');

/**
 * Pixoo auto-discovery used to be on by default, which meant every daemon start
 * on a machine with no Pixoo configured did two unannounced things: a POST to
 * `app.divoom-gz.com` and an HTTP probe of all 254 hosts on the local /24. On a
 * corporate segment that is third-party egress plus what an IDS reads as a
 * horizontal port scan — from every developer's machine, on every start.
 *
 * The direction of this default is the whole point, so it is pinned here.
 */
describe('pixooAutoDiscoverFrom', () => {
  it('is OFF when the setting is absent', () => {
    expect(pixooAutoDiscoverFrom({})).toBe(false);
  });

  it('is OFF for anything that is not an explicit true', () => {
    // Explicit-opt-in, not truthiness: a stray string must not arm a LAN sweep.
    for (const value of [false, null, undefined, 0, 1, 'true', 'yes', {}]) {
      expect(pixooAutoDiscoverFrom({ pixooAutoDiscover: value }), String(value)).toBe(false);
    }
  });

  it('is ON only when explicitly opted in', () => {
    expect(pixooAutoDiscoverFrom({ pixooAutoDiscover: true })).toBe(true);
  });
});

describe('discoverPixoo cloud opt-out', () => {
  it('queries the Divoom cloud by default', () => {
    discoverDevicesMock.mockClear();
    return discoverPixoo().then(() => {
      expect(discoverDevicesMock).toHaveBeenCalledTimes(1);
    });
  });

  it('never touches the cloud when cloud is false', async () => {
    // The cloud lookup and the subnet sweep are different disclosures — one
    // leaves the network, one does not — so `agentdeck pixoo scan --no-cloud`
    // must be able to take the second without the first.
    discoverDevicesMock.mockClear();
    await discoverPixoo({ cloud: false });
    expect(discoverDevicesMock).not.toHaveBeenCalled();
  });
});
