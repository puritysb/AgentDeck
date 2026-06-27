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
 * Per-module configuration: 'auto' (detect), true (force on), false (force off).
 */
export interface ModuleConfigs {
  mdns?: 'auto' | boolean;
  adb?: 'auto' | boolean;
  serial?: 'auto' | boolean;
  pixoo?: 'auto' | boolean;
  timebox?: 'auto' | boolean;
  idotmatrix?: 'auto' | boolean;
  d200h?: 'auto' | boolean;
  trmnl?: 'auto' | boolean;
}
