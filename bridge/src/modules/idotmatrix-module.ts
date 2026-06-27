import type { BridgeContext, DeviceModule } from './types.js';
import {
  loadIDotMatrixDevices,
  isIDotMatrixAutoDiscoverEnabled,
} from '../idotmatrix/idotmatrix-settings.js';
import { startIDotMatrixSync, stopIDotMatrixSync } from '../idotmatrix/idotmatrix-daemon-sync.js';
import { autoDiscoverIDotMatrix } from '../idotmatrix/idotmatrix-discover.js';

export class IDotMatrixModule implements DeviceModule {
  readonly name = 'idotmatrix';

  async shouldActivate(config: 'auto' | boolean): Promise<boolean> {
    if (config === false) return false;
    if (config === true) return true;
    // Activate when a device is configured OR auto-discovery may find one.
    return loadIDotMatrixDevices().length > 0 || isIDotMatrixAutoDiscoverEnabled();
  }

  async start(ctx: BridgeContext): Promise<void> {
    // Start sync for any already-configured device immediately, then run a
    // background BLE scan if none is configured. Discovery is non-blocking so
    // daemon startup isn't delayed by the ~8s scan; when it adds a device we
    // re-invoke startIDotMatrixSync (no-op if already running) to pick it up.
    startIDotMatrixSync(ctx.port);
    if (loadIDotMatrixDevices().length === 0 && isIDotMatrixAutoDiscoverEnabled()) {
      void autoDiscoverIDotMatrix().then((added) => {
        if (added > 0) startIDotMatrixSync(ctx.port);
      });
    }
  }

  async stop(): Promise<void> {
    stopIDotMatrixSync();
  }

  statusSnapshot(): Record<string, unknown> {
    const devices = loadIDotMatrixDevices();
    return {
      configuredDeviceCount: devices.length,
      devices: devices.map((d) => ({
        id: d.address,
        transport: 'ble',
        address: d.address,
        name: d.name ?? 'iDotMatrix',
        brightness: d.brightness ?? 100,
      })),
    };
  }
}
