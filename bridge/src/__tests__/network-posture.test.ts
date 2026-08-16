import { describe, expect, it } from 'vitest';
import {
  bindHostFor,
  daemonModuleConfigs,
  describeDaemonPosture,
  isLoopbackOnlyEnv,
  resolveDaemonPosture,
} from '../network-posture.js';
import { MODULE_NAMES, allModulesOff } from '../modules/types.js';
import { createDefaultModules } from '../modules/index.js';
import type { AgentType } from '../types.js';

describe('module registry SSOT', () => {
  it('MODULE_NAMES matches the modules createDefaultModules actually registers', () => {
    // The drift gate for the hand-listed names in modules/types.ts. A module
    // added to the registry and forgotten there would silently come back as
    // 'auto' under every flag that promises "all modules off".
    const registered = createDefaultModules('daemon' as AgentType).map((m) => m.name);
    expect([...MODULE_NAMES].sort()).toEqual([...registered].sort());
  });

  it('allModulesOff() switches off every registered module', () => {
    const off = allModulesOff();
    for (const name of createDefaultModules('daemon' as AgentType).map((m) => m.name)) {
      expect(off[name as keyof typeof off], `${name} must be explicitly false`).toBe(false);
    }
  });

  it('covers the two modules the hand-written --local records used to omit', () => {
    // initModules() defaults an absent key to 'auto', so an omitted key was not
    // "off" — it was "on". idotmatrix's auto path spawns the Python BLE client.
    const off = allModulesOff();
    expect(off.idotmatrix).toBe(false);
    expect(off.broadcast).toBe(false);
  });
});

describe('resolveDaemonPosture', () => {
  it('defaults to the open posture', () => {
    const p = resolveDaemonPosture({}, {});
    expect(p).toEqual({ loopbackOnly: false, noDeviceModules: false });
    expect(bindHostFor(p)).toBe('0.0.0.0');
  });

  it('reads the env switch', () => {
    expect(isLoopbackOnlyEnv({ AGENTDECK_LOOPBACK_ONLY: '1' })).toBe(true);
    expect(isLoopbackOnlyEnv({ AGENTDECK_LOOPBACK_ONLY: 'true' })).toBe(false);
    expect(isLoopbackOnlyEnv({})).toBe(false);
    expect(resolveDaemonPosture({}, { AGENTDECK_LOOPBACK_ONLY: '1' }).loopbackOnly).toBe(true);
  });

  it('treats --loopback and the env var as the same switch', () => {
    expect(resolveDaemonPosture({ loopback: true }, {})).toEqual(
      resolveDaemonPosture({}, { AGENTDECK_LOOPBACK_ONLY: '1' }),
    );
  });

  it('keeps --local and --loopback independent', () => {
    expect(resolveDaemonPosture({ local: true }, {})).toEqual({
      loopbackOnly: false,
      noDeviceModules: true,
    });
    expect(bindHostFor(resolveDaemonPosture({ local: true }, {}))).toBe('0.0.0.0');
  });
});

describe('daemonModuleConfigs', () => {
  const open = { loopbackOnly: false, noDeviceModules: false };
  const loopback = { loopbackOnly: true, noDeviceModules: false };
  const local = { loopbackOnly: false, noDeviceModules: true };

  it('leaves everything enabled in the default posture', () => {
    const c = daemonModuleConfigs(open, 'auto');
    expect(c.mdns).toBe(true);
    expect(c.broadcast).toBe(true);
    expect(c.pixoo).toBe('auto');
    expect(c.idotmatrix).toBe('auto');
    expect(c.serial).toBe('auto');
  });

  it('loopback silences every module that touches the network', () => {
    // This is the regression the flag was one line deep for: binding 127.0.0.1
    // while still advertising mDNS, beaconing every 2s, sweeping the /24 for
    // Pixoo devices and scanning BLE — the noise without the function.
    const c = daemonModuleConfigs(loopback, 'auto');
    expect(c.mdns).toBe(false);
    expect(c.broadcast).toBe(false);
    expect(c.pixoo).toBe(false);
    expect(c.timebox).toBe(false);
    expect(c.idotmatrix).toBe(false);
  });

  it('loopback keeps USB serial — a board on a cable is not a network peer', () => {
    expect(daemonModuleConfigs(loopback, 'auto').serial).toBe('auto');
  });

  it('loopback keeps ADB reverse — the tunnel rides USB into the host loopback', () => {
    // `adb reverse` forwards the device's localhost to the host's 127.0.0.1
    // over the cable, so it works under a loopback bind and emits nothing onto
    // the LAN — the same test USB serial passes. Turning it off here silently
    // killed every USB-tethered Android dashboard for no security gain.
    expect(daemonModuleConfigs(loopback, 'auto').adb).toBe('auto');
  });

  it('loopback still honours the AGENTDECK_DAEMON_NO_SERIAL diagnostic gate', () => {
    expect(daemonModuleConfigs(loopback, false).serial).toBe(false);
  });

  it('--local turns off every module, serial included', () => {
    const c = daemonModuleConfigs(local, 'auto');
    for (const name of MODULE_NAMES) expect(c[name], name).toBe(false);
  });

  it('--local wins over loopback when both are set', () => {
    const both = { loopbackOnly: true, noDeviceModules: true };
    expect(daemonModuleConfigs(both, 'auto').serial).toBe(false);
  });

  it('a module added later defaults to off in both restricted postures', () => {
    // Guards the shape, not a specific module: both branches are built from
    // allModulesOff() and add back only what the posture permits, so the
    // failure mode of forgetting a new module is "off", never "scanning".
    const usbChannels = ['serial', 'adb'];
    for (const posture of [loopback, local]) {
      const c = daemonModuleConfigs(posture, 'auto') as Record<string, unknown>;
      const enabled = Object.entries(c).filter(([, v]) => v !== false).map(([k]) => k);
      expect(enabled.every((k) => usbChannels.includes(k))).toBe(true);
    }
  });
});

describe('describeDaemonPosture', () => {
  it('names what is off, not just the bind address', () => {
    const line = describeDaemonPosture({ loopbackOnly: true, noDeviceModules: false }, 9120);
    expect(line).toContain('127.0.0.1:9120');
    for (const claim of ['mDNS', 'UDP', 'sweep', 'BLE']) {
      expect(line, `posture line must mention ${claim}`).toContain(claim);
    }
    // The USB channels survive loopback, and the line must say so — an admin
    // reading "ADB reverse off" while a tethered dashboard is clearly alive
    // would (rightly) stop trusting the rest of the line.
    expect(line).toContain('USB serial and ADB reverse (USB-attached devices only) stay on');
  });

  it('folds the USB channels into the off-list when --local is also set', () => {
    const line = describeDaemonPosture({ loopbackOnly: true, noDeviceModules: true }, 9120);
    expect(line).toContain('USB serial, ADB reverse are all off');
    expect(line).not.toContain('stay on');
  });

  it('points at the switch when the daemon is wide open', () => {
    const line = describeDaemonPosture({ loopbackOnly: false, noDeviceModules: false }, 9120);
    expect(line).toContain('AGENTDECK_LOOPBACK_ONLY=1');
  });
});
