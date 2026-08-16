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
    expect(c.adb).toBe(false);
  });

  it('loopback keeps USB serial — a board on a cable is not a network peer', () => {
    expect(daemonModuleConfigs(loopback, 'auto').serial).toBe('auto');
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
    for (const posture of [loopback, local]) {
      const c = daemonModuleConfigs(posture, 'auto') as Record<string, unknown>;
      const enabled = Object.entries(c).filter(([, v]) => v !== false).map(([k]) => k);
      expect(enabled.every((k) => k === 'serial')).toBe(true);
    }
  });
});

describe('describeDaemonPosture', () => {
  it('names what is off, not just the bind address', () => {
    const line = describeDaemonPosture({ loopbackOnly: true, noDeviceModules: false }, 9120);
    expect(line).toContain('127.0.0.1:9120');
    for (const claim of ['mDNS', 'UDP', 'sweep', 'BLE', 'ADB']) {
      expect(line, `posture line must mention ${claim}`).toContain(claim);
    }
  });

  it('points at the switch when the daemon is wide open', () => {
    const line = describeDaemonPosture({ loopbackOnly: false, noDeviceModules: false }, 9120);
    expect(line).toContain('AGENTDECK_LOOPBACK_ONLY=1');
  });
});
