import type { BridgeContext, DeviceModule } from './types.js';
import {
  loadIDotMatrixDevices,
  isIDotMatrixAutoDiscoverEnabled,
} from '../idotmatrix/idotmatrix-settings.js';
import {
  idotMatrixLinkSnapshot,
  startIDotMatrixSync,
  stopIDotMatrixSync,
} from '../idotmatrix/idotmatrix-daemon-sync.js';
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
    // Await the child's OFFLINE-frame farewell so the panel doesn't freeze on its
    // last dashboard frame when the daemon exits.
    await stopIDotMatrixSync(true);
  }

  statusSnapshot(): Record<string, unknown> {
    const devices = loadIDotMatrixDevices();
    // The live link fields come from the spawned sync client's status lines;
    // without them every consumer of `BLEMatrixHealth.connected` drew a
    // streaming panel as disconnected. Same shape the Swift daemon emits.
    const link = idotMatrixLinkSnapshot(devices.length);
    return {
      configuredDeviceCount: devices.length,
      connected: link.connected,
      deviceName: devices[0]?.name ?? devices[0]?.address ?? null,
      statusReason: link.statusReason,
      displayDimmed: link.displayDimmed,
      hasFrame: link.hasFrame,
      lastError: link.lastError,
      lastPushAtMs: link.lastPushAtMs,
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
