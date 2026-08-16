import type { WsServer } from '../ws-server.js';
import type { BridgeEvent } from '../types.js';

/**
 * Context passed to device modules during initialization.
 */
export interface BridgeContext {
  port: number;
  authToken: string;
  projectName: string;
  wsServer: WsServer;
  broadcastSse?: (evt: BridgeEvent) => void;
  /**
   * Daemon is running loopback-only (`--loopback` / AGENTDECK_LOOPBACK_ONLY).
   * A module that survives that posture must still honour its promise: emit
   * nothing onto the LAN. Today only AdbModule consults it — `adb reverse`
   * is restricted to USB-transport devices, because the same command against
   * a TCP/mDNS adb device stands up a LAN-carried tunnel.
   */
  loopbackOnly?: boolean;
}

/**
 * Pluggable device module interface.
 * Modules wrap optional device integrations (mDNS, ADB, ESP32 serial, Pixoo, Timebox).
 */
export interface DeviceModule {
  readonly name: string;

  /**
   * Check whether this module should activate.
   * @param config 'auto' = detect, true = force on, false = force off
   */
  shouldActivate(config: 'auto' | boolean): Promise<boolean>;

  /** Start the module. Called only if shouldActivate returned true. */
  start(ctx: BridgeContext): Promise<void>;

  /** Stop the module and clean up resources. */
  stop(): Promise<void>;
}

/**
 * Every module in the registry, in `createDefaultModules` order.
 *
 * SSOT for both the config type below and `allModulesOff()`. It lives here — in
 * the dependency-free types module — rather than being derived by constructing
 * the registry, so the CLI can ask for "all off" without pulling esp32-serial,
 * the Pixoo bridge, and the BLE clients into `agentdeck --help`.
 *
 * `bridge/src/__tests__/module-registry.test.ts` gates it against the real
 * `createDefaultModules()`, so a module added there and forgotten here fails CI
 * rather than silently reappearing under a flag that promised to disable it.
 */
export const MODULE_NAMES = [
  'mdns',
  'broadcast',
  'adb',
  'serial',
  'pixoo',
  'timebox',
  'idotmatrix',
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

/**
 * Per-module configuration: 'auto' (detect), true (force on), false (force off).
 */
export type ModuleConfigs = Partial<Record<ModuleName, 'auto' | boolean>>;

/**
 * A `ModuleConfigs` record with every registered module forced off.
 *
 * Derived from `MODULE_NAMES` rather than written out as literal keys, because
 * an allow-list of literals drifts every time a module is added: the
 * hand-written `--local` records omitted `idotmatrix` and `broadcast`, and
 * `initModules` defaults an absent key to `'auto'` — so `agentdeck claude
 * --local`, documented as "Disable all device modules", still spawned the
 * iDotMatrix Python BLE client.
 */
export function allModulesOff(): ModuleConfigs {
  return Object.fromEntries(MODULE_NAMES.map((n) => [n, false])) as ModuleConfigs;
}
