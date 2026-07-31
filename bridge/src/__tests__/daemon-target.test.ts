import { describe, it, expect, vi } from 'vitest';
import {
  parseHostHint,
  isLoopbackHost,
  formatHostForUrl,
  resolveDaemonTarget,
  deriveRemoteAttachOpts,
  warnRemoteOnce,
} from '../session-registry.js';
import { logError } from '../logger.js';

// Only the default-warn dedup test observes logError; everything else in this
// file injects its own `warn` dep.
vi.mock('../logger.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../logger.js')>();
  return { ...mod, logError: vi.fn() };
});

describe('daemon-target helpers', () => {
  describe('isLoopbackHost', () => {
    it('treats loopback forms as local', () => {
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('localhost')).toBe(true);
    });
    it('treats LAN/remote hosts as non-local', () => {
      expect(isLoopbackHost('192.168.1.42')).toBe(false);
      expect(isLoopbackHost('mac.local')).toBe(false);
    });
  });

  describe('formatHostForUrl', () => {
    it('brackets bare IPv6 literals', () => {
      expect(formatHostForUrl('fe80::1')).toBe('[fe80::1]');
      expect(formatHostForUrl('::1')).toBe('[::1]');
    });
    it('leaves IPv4 and already-bracketed hosts untouched', () => {
      expect(formatHostForUrl('192.168.1.42')).toBe('192.168.1.42');
      expect(formatHostForUrl('[::1]')).toBe('[::1]');
      expect(formatHostForUrl('mac.local')).toBe('mac.local');
    });
  });

  describe('parseHostHint', () => {
    it('defaults the port to 9120 when none is given', () => {
      expect(parseHostHint('192.168.1.42')).toEqual({ host: '192.168.1.42', port: 9120 });
      expect(parseHostHint('mac.local')).toEqual({ host: 'mac.local', port: 9120 });
    });
    it('parses host:port', () => {
      expect(parseHostHint('192.168.1.42:9125')).toEqual({ host: '192.168.1.42', port: 9125 });
    });
    it('does not mistake bare IPv6 for host:port', () => {
      expect(parseHostHint('fe80::1')).toEqual({ host: 'fe80::1', port: 9120 });
    });
    it('parses bracketed IPv6 with and without a port', () => {
      expect(parseHostHint('[fe80::1]:9130')).toEqual({ host: 'fe80::1', port: 9130 });
      expect(parseHostHint('[::1]')).toEqual({ host: '::1', port: 9120 });
    });
  });

  describe('resolveDaemonTarget precedence + opt-in gate', () => {
    const daemonHealth = { mode: 'daemon', pairingToken: 'tok-123', sameSocketControl: true };
    const makeDeps = (over: Partial<Parameters<typeof resolveDaemonTarget>[1]> = {}) => ({
      findLocal: vi.fn(async () => null),
      probeHealth: vi.fn(async () => daemonHealth as Record<string, unknown>),
      discover: vi.fn(async () => [{ host: 'lan.local', port: 9120, token: 'mdns-tok', sameSocketControl: true }]),
      warn: vi.fn(),
      ...over,
    });

    it('prefers a local daemon and never consults remote paths', async () => {
      const deps = makeDeps({ findLocal: vi.fn(async () => ({ port: 9123, httpPort: 9133, sameSocketControl: true })) });
      const target = await resolveDaemonTarget({ remote: true, hostHint: 'mainnode.lan' }, deps);
      expect(target).toEqual({ host: '127.0.0.1', port: 9123, httpPort: 9133, sameSocketControl: true });
      expect(deps.probeHealth).not.toHaveBeenCalled();
      expect(deps.discover).not.toHaveBeenCalled();
    });

    // Under remote intent even a LOOPBACK daemon must advertise the capability:
    // an ssh -L forward of a remote daemon is indistinguishable from a genuine
    // local one by IP, and accepting an incapable one silently produced a plain
    // registration (acked but never listable/focusable) instead of a refusal.
    it('refuses (null + warn) an incapable loopback daemon under --remote-daemon with no host hint', async () => {
      const deps = makeDeps({ findLocal: vi.fn(async () => ({ port: 9120, sameSocketControl: false })) });
      const target = await resolveDaemonTarget({ remote: true }, deps);
      expect(target).toBeNull();
      expect(deps.warn).toHaveBeenCalledWith('local:127.0.0.1:9120', expect.stringContaining('does not support remote attach'));
      // No mDNS roaming: a deliberately-built tunnel must fail loudly, not
      // silently attach to some other LAN daemon.
      expect(deps.probeHealth).not.toHaveBeenCalled();
      expect(deps.discover).not.toHaveBeenCalled();
    });

    it('falls through to a capable named host when the loopback daemon is incapable', async () => {
      const deps = makeDeps({ findLocal: vi.fn(async () => ({ port: 9120, sameSocketControl: false })) });
      const target = await resolveDaemonTarget({ remote: true, hostHint: 'mainnode.lan:9125' }, deps);
      expect(target).toEqual({ host: 'mainnode.lan', port: 9125, token: 'tok-123', sameSocketControl: true });
      expect(deps.probeHealth).toHaveBeenCalledWith('mainnode.lan', 9125);
      expect(deps.discover).not.toHaveBeenCalled();
    });

    it('refuses an ssh -L tunnel to an incapable daemon named via --daemon-host 127.0.0.1', async () => {
      // The tunnel occupies the loopback daemon port, so findLocal and the
      // explicit hint both reach the same incapable (pre-remediation / Swift)
      // daemon: the fallthrough must end in the explicit-host refusal, not a
      // plain local attach.
      const deps = makeDeps({
        findLocal: vi.fn(async () => ({ port: 9120, sameSocketControl: false })),
        probeHealth: vi.fn(async () => ({ mode: 'daemon', pairingToken: 'tok-old' })),
      });
      const target = await resolveDaemonTarget({ remote: true, hostHint: '127.0.0.1' }, deps);
      expect(target).toBeNull();
      expect(deps.warn).toHaveBeenCalledWith('127.0.0.1:9120', expect.stringContaining('does not support remote attach'));
      expect(deps.discover).not.toHaveBeenCalled();
    });

    it('still returns an incapable local daemon without the switch (local default untouched)', async () => {
      const deps = makeDeps({ findLocal: vi.fn(async () => ({ port: 9120, sameSocketControl: false })) });
      const target = await resolveDaemonTarget({ remote: false }, deps);
      expect(target).toEqual({ host: '127.0.0.1', port: 9120, httpPort: undefined, sameSocketControl: false });
      expect(deps.warn).not.toHaveBeenCalled();
    });

    it('warnRemoteOnce logs a given key at most once (resolver re-runs on every backoff)', () => {
      // Keys must be unique to this test: the module-level dedup Set has no reset.
      warnRemoteOnce('test-dedup:once', 'test-dedup first');
      warnRemoteOnce('test-dedup:once', 'test-dedup second');
      warnRemoteOnce('test-dedup:other', 'test-dedup third');
      // Filter to this test's own messages so an unrelated default-warn user
      // elsewhere in the file can't break this assertion.
      const mine = vi.mocked(logError).mock.calls.map((c) => c[0]).filter((m) => String(m).startsWith('test-dedup'));
      expect(mine).toEqual(['test-dedup first', 'test-dedup third']);
    });

    it('ignores an explicit host without --remote-daemon: the switch gates BOTH remote paths', async () => {
      const deps = makeDeps();
      expect(await resolveDaemonTarget({ hostHint: 'mainnode.lan:9125' }, deps)).toBeNull();
      expect(await resolveDaemonTarget({ remote: false, hostHint: 'mainnode.lan:9125' }, deps)).toBeNull();
      // Nothing left the machine: neither the probe nor mDNS ever ran.
      expect(deps.probeHealth).not.toHaveBeenCalled();
      expect(deps.discover).not.toHaveBeenCalled();
    });

    it('resolves an explicit host with --remote-daemon, without touching mDNS', async () => {
      const deps = makeDeps();
      const target = await resolveDaemonTarget({ remote: true, hostHint: 'mainnode.lan:9125' }, deps);
      expect(target).toEqual({ host: 'mainnode.lan', port: 9125, token: 'tok-123', sameSocketControl: true });
      expect(deps.probeHealth).toHaveBeenCalledWith('mainnode.lan', 9125);
      expect(deps.discover).not.toHaveBeenCalled();
    });

    it('returns null for an unreachable explicit host without falling through to mDNS', async () => {
      const deps = makeDeps({ probeHealth: vi.fn(async () => null) });
      const target = await resolveDaemonTarget({ remote: true, hostHint: 'dead.host' }, deps);
      expect(target).toBeNull();
      // A named-but-dead node surfaces failure; it never silently browses the LAN.
      expect(deps.discover).not.toHaveBeenCalled();
    });

    it('refuses (null + warn) an explicit remote daemon lacking sameSocketControl', async () => {
      const deps = makeDeps({
        probeHealth: vi.fn(async () => ({ mode: 'daemon', pairingToken: 'tok-swift' })),
      });
      const target = await resolveDaemonTarget({ remote: true, hostHint: 'macmini.lan' }, deps);
      expect(target).toBeNull();
      expect(deps.warn).toHaveBeenCalledWith('macmini.lan:9120', expect.stringContaining('does not support remote attach'));
      expect(deps.discover).not.toHaveBeenCalled();
    });

    it('runs mDNS discovery ONLY when the --remote-daemon switch is set', async () => {
      const deps = makeDeps();
      const target = await resolveDaemonTarget({ remote: true }, deps);
      expect(target).toEqual({ host: 'lan.local', port: 9120, token: 'mdns-tok', sameSocketControl: true });
      expect(deps.discover).toHaveBeenCalledTimes(1);
    });

    it('never leaves the machine with no opt-in (no host, no switch)', async () => {
      const deps = makeDeps();
      expect(await resolveDaemonTarget(undefined, deps)).toBeNull();
      expect(await resolveDaemonTarget({}, deps)).toBeNull();
      expect(await resolveDaemonTarget({ remote: false }, deps)).toBeNull();
      // The security-relevant guarantee: no ambient state ever reaches the LAN.
      expect(deps.probeHealth).not.toHaveBeenCalled();
      expect(deps.discover).not.toHaveBeenCalled();
    });
  });

  describe('deriveRemoteAttachOpts (shared CLI/index derivation)', () => {
    it('is inert with no flags and no env', () => {
      expect(deriveRemoteAttachOpts({}, {} as NodeJS.ProcessEnv))
        .toEqual({ remote: false, hostHint: undefined, ignoredHostHint: false });
    });

    it('flags a host given without the switch as ignored', () => {
      expect(deriveRemoteAttachOpts({ daemonHost: 'mainnode.lan' }, {} as NodeJS.ProcessEnv))
        .toEqual({ remote: false, hostHint: 'mainnode.lan', ignoredHostHint: true });
      expect(deriveRemoteAttachOpts({}, { AGENTDECK_DAEMON_HOST: 'x' } as unknown as NodeJS.ProcessEnv).ignoredHostHint).toBe(true);
      expect(deriveRemoteAttachOpts({}, { AGENTDECK_REMOTE_DAEMON_HOST: 'x' } as unknown as NodeJS.ProcessEnv).ignoredHostHint).toBe(true);
    });

    it('does not warn when the opt-in arrives via env alone', () => {
      const r = deriveRemoteAttachOpts({ daemonHost: 'mainnode.lan' }, { AGENTDECK_REMOTE_DAEMON: '1' } as unknown as NodeJS.ProcessEnv);
      expect(r).toEqual({ remote: true, hostHint: 'mainnode.lan', ignoredHostHint: false });
    });

    it('honors env host aliases in precedence order', () => {
      const env = { AGENTDECK_DAEMON_HOST: 'a', AGENTDECK_REMOTE_DAEMON_HOST: 'b' } as unknown as NodeJS.ProcessEnv;
      expect(deriveRemoteAttachOpts({ remoteDaemon: true }, env).hostHint).toBe('a');
      expect(deriveRemoteAttachOpts({ remoteDaemon: true, daemonHost: 'flag' }, env).hostHint).toBe('flag');
    });
  });
});
