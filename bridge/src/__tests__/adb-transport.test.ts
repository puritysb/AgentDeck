import { describe, expect, it } from 'vitest';
import { isNetworkAdbTransport } from '../adb-reverse.js';

describe('isNetworkAdbTransport', () => {
  // The loopback posture keeps ADB reverse on the claim that the tunnel rides
  // USB into the host's own loopback. That claim is only true for USB
  // transports — `adb reverse` against a TCP/mDNS device stands up a
  // LAN-carried tunnel, which would let a network peer reach a 127.0.0.1-bound
  // daemon. This predicate is the whole enforcement.

  it('flags adb-over-TCP serials (adb connect <ip>:<port>)', () => {
    expect(isNetworkAdbTransport('192.168.0.42:5555')).toBe(true);
    expect(isNetworkAdbTransport('10.0.0.7:37021')).toBe(true);
  });

  it('flags wireless-debugging mDNS instance names', () => {
    expect(isNetworkAdbTransport('adb-R3CN30ABCDE-Xq7f2M._adb-tls-connect._tcp')).toBe(true);
  });

  it('passes USB serials through', () => {
    expect(isNetworkAdbTransport('R3CN30ABCDE')).toBe(false);
    expect(isNetworkAdbTransport('0A241JEC212345')).toBe(false);
  });

  it('does not flag the local emulator', () => {
    // The emulator console is host-local; excluding it would be a capability
    // removal with no LAN traffic to justify it.
    expect(isNetworkAdbTransport('emulator-5554')).toBe(false);
  });
});
