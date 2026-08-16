/**
 * Daemon network posture — how much of the LAN the daemon is allowed to touch.
 *
 * Two independent axes, deliberately not folded into one flag:
 *
 * - **`--local`** answers "may this daemon drive hardware?". It turns every
 *   device module off, USB serial included. The daemon still binds `0.0.0.0`,
 *   so a paired phone/tablet companion on the LAN keeps working.
 * - **`--loopback` / `AGENTDECK_LOOPBACK_ONLY=1`** answers "may this daemon be
 *   seen or heard on the LAN at all?". It binds `127.0.0.1` *and* silences
 *   everything the daemon emits onto the network — mDNS advertisement, the
 *   2-second UDP beacon, the Pixoo subnet sweep, and the BLE scans. USB
 *   serial survives, because a board on a cable is not a network peer — and
 *   by the same test so does the ADB reverse tunnel for USB-attached devices:
 *   `adb reverse` over a cable terminates on the host's own loopback, so it
 *   works under a `127.0.0.1` bind and puts nothing on the LAN. Network adb
 *   transports (`adb connect <ip>`, wireless debugging) fail that test and are
 *   excluded by the module itself (`isNetworkAdbTransport`, threaded via
 *   `BridgeContext.loopbackOnly`) — the config value stays `'auto'` here.
 *
 * Until now the env var did exactly one thing — pick the bind address — while
 * the daemon carried on advertising `_agentdeck._tcp`, broadcasting every two
 * seconds, and sweeping the /24 for Pixoo devices. On a corporate segment that
 * is the worst of both worlds: the noise without the function, and a horizontal
 * scan from every developer's machine for a service nobody on that segment can
 * reach. Loopback now means loopback.
 */

import { allModulesOff, type ModuleConfigs } from './modules/types.js';

export interface DaemonPosture {
  /** Bind 127.0.0.1 only, and emit nothing onto the LAN. */
  loopbackOnly: boolean;
  /** Every device module off, USB serial included. */
  noDeviceModules: boolean;
}

export interface PostureFlags {
  /** `daemon start --local` */
  local?: boolean;
  /** `daemon start --loopback` */
  loopback?: boolean;
}

/** True when the fleet-wide env switch is set (MDM/profile-settable). */
export function isLoopbackOnlyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTDECK_LOOPBACK_ONLY === '1';
}

/**
 * Resolve the posture from CLI flags plus the environment. Pure — takes `env`
 * so tests can drive it without mutating the real process environment.
 */
export function resolveDaemonPosture(
  flags: PostureFlags = {},
  env: NodeJS.ProcessEnv = process.env,
): DaemonPosture {
  return {
    loopbackOnly: !!flags.loopback || isLoopbackOnlyEnv(env),
    noDeviceModules: !!flags.local,
  };
}

/**
 * Module configuration for a daemon running under `posture`.
 *
 * The two restricted branches are built from `allModulesOff()` and then add
 * back only what the posture permits, so a module added later is off by default
 * under both — the safe direction. `serialMode` is threaded through rather than
 * hard-coded because `AGENTDECK_DAEMON_NO_SERIAL=1` is a separate diagnostic
 * gate that must keep working in every posture.
 */
export function daemonModuleConfigs(
  posture: DaemonPosture,
  serialMode: 'auto' | false,
): ModuleConfigs {
  if (posture.noDeviceModules) return allModulesOff();
  if (posture.loopbackOnly) {
    // Everything the daemon would put on the wire is off. A USB-attached board
    // is not a network peer, so serial keeps its normal mode — and ADB reverse
    // passes the same test: the tunnel rides the USB cable into the host's own
    // loopback, which is exactly the interface this posture binds.
    return { ...allModulesOff(), serial: serialMode, adb: 'auto' };
  }
  return {
    mdns: true,
    broadcast: true,
    adb: 'auto',
    serial: serialMode,
    pixoo: 'auto',
    timebox: 'auto',
    idotmatrix: 'auto',
  };
}

/** Bind address implied by the posture. */
export function bindHostFor(posture: DaemonPosture): string {
  return posture.loopbackOnly ? '127.0.0.1' : '0.0.0.0';
}

/**
 * One startup line naming what is actually off. The old log promised "LAN
 * devices cannot connect", which was true of inbound traffic and said nothing
 * about what the daemon still emitted — so an admin reading it had no way to
 * know the subnet sweep was still running.
 */
export function describeDaemonPosture(posture: DaemonPosture, port: number): string {
  if (posture.loopbackOnly) {
    const usb = posture.noDeviceModules
      ? ', USB serial, ADB reverse are all off.'
      : ' are all off; USB serial and ADB reverse (USB-attached devices only) stay on.';
    return `[agentdeck] Loopback-only posture — bound to 127.0.0.1:${port}. `
      + `mDNS advertisement, UDP discovery beacon, Pixoo LAN sweep, BLE scans${usb} `
      + `LAN devices (companion apps, ESP32/WiFi boards) cannot connect.`;
  }
  if (posture.noDeviceModules) {
    return `[agentdeck] Listening on all interfaces (:${port}) with every device module off `
      + `(--local: no mDNS, no UDP beacon, no LAN sweep, no BLE, no ADB, no serial). `
      + `LAN requests still require the pairing token (~/.agentdeck/auth-token).`;
  }
  return `[agentdeck] Daemon listening on all interfaces (:${port}) — LAN requests require the pairing token `
    + `(~/.agentdeck/auth-token). Set AGENTDECK_LOOPBACK_ONLY=1 (or pass --loopback) for a loopback-only bind `
    + `with LAN discovery and device scans disabled.`;
}
