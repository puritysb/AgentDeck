/**
 * ESP32 layout switch (`POST /esp32/orientation`, `agentdeck esp32 orientation`).
 *
 * The T-Display-S3-Pro persists the requested layout in NVS and restarts into
 * portrait Pocket or the landscape Focus Strip; `auto` follows the camera
 * shield. Delivery prefers the board's live USB serial link (a board on USB
 * parks its WiFi radio, so the WebSocket is usually gone) and falls back to
 * its WiFi socket. The frame is fire-and-forget: the board's next
 * `device_info` reports `layout`/`layoutSetting`, which is the read-back.
 */
import type { SetOrientationEvent } from '@agentdeck/shared';

export const ESP32_LAYOUTS = ['auto', 'portrait', 'landscape'] as const;
export type Esp32Layout = (typeof ESP32_LAYOUTS)[number];

export class OrientationRequestError extends Error {}

export function parseEsp32Layout(value: unknown): Esp32Layout {
  if (typeof value === 'string' && (ESP32_LAYOUTS as readonly string[]).includes(value)) {
    return value as Esp32Layout;
  }
  throw new OrientationRequestError(`layout must be one of ${ESP32_LAYOUTS.join(', ')}`);
}

export function buildSetOrientationEvent(layout: Esp32Layout): SetOrientationEvent {
  // `landscape` keeps boards that only read the legacy bool on the same side;
  // `auto` has no bool equivalent, so it is omitted rather than guessed.
  return layout === 'auto'
    ? { type: 'set_orientation', layout }
    : { type: 'set_orientation', layout, landscape: layout === 'landscape' };
}

export interface OrientationDeliveryDeps {
  /** Live serial port for a board id or port path, if attached. */
  serialPortFor(target: string): string | undefined;
  sendSerial(port: string, event: SetOrientationEvent): boolean;
  /** Sends over the board's WiFi socket; throws when no unique online match. */
  sendWifi(target: string, event: SetOrientationEvent): string;
}

export function deliverOrientation(
  target: string,
  layout: Esp32Layout,
  deps: OrientationDeliveryDeps,
): { ok: true; target: string; layout: Esp32Layout; transport: 'serial' | 'wifi'; via: string } {
  if (!target) throw new OrientationRequestError('target is required');
  const event = buildSetOrientationEvent(layout);
  const port = deps.serialPortFor(target);
  if (port && deps.sendSerial(port, event)) {
    return { ok: true, target, layout, transport: 'serial', via: port };
  }
  const key = deps.sendWifi(target, event);
  return { ok: true, target, layout, transport: 'wifi', via: key };
}
