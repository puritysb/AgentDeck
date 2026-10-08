import { describe, expect, it, vi } from 'vitest';
import {
  buildSetOrientationEvent,
  deliverOrientation,
  OrientationRequestError,
  parseEsp32Layout,
} from '../esp32-orientation.js';

describe('esp32 orientation', () => {
  it('accepts only the three layouts', () => {
    expect(parseEsp32Layout('portrait')).toBe('portrait');
    expect(parseEsp32Layout('auto')).toBe('auto');
    expect(() => parseEsp32Layout('vertical')).toThrow(OrientationRequestError);
    expect(() => parseEsp32Layout(undefined)).toThrow(OrientationRequestError);
  });

  it('carries the legacy bool for explicit sides but not for auto', () => {
    expect(buildSetOrientationEvent('landscape')).toEqual({ type: 'set_orientation', layout: 'landscape', landscape: true });
    expect(buildSetOrientationEvent('portrait')).toEqual({ type: 'set_orientation', layout: 'portrait', landscape: false });
    expect(buildSetOrientationEvent('auto')).toEqual({ type: 'set_orientation', layout: 'auto' });
  });

  it('prefers the live serial link over WiFi', () => {
    const sendWifi = vi.fn(() => 'wifi-key');
    const sendSerial = vi.fn(() => true);
    const result = deliverOrientation('t_display_pro', 'portrait', {
      serialPortFor: () => '/dev/cu.usbmodem1',
      sendSerial,
      sendWifi,
    });
    expect(result).toMatchObject({ transport: 'serial', via: '/dev/cu.usbmodem1' });
    expect(sendSerial).toHaveBeenCalledWith('/dev/cu.usbmodem1', expect.objectContaining({ layout: 'portrait' }));
    expect(sendWifi).not.toHaveBeenCalled();
  });

  it('falls back to WiFi when serial is absent or the write fails', () => {
    const sendWifi = vi.fn(() => 'wifi-key');
    expect(deliverOrientation('t_display_pro', 'landscape', {
      serialPortFor: () => undefined, sendSerial: () => true, sendWifi,
    })).toMatchObject({ transport: 'wifi', via: 'wifi-key' });
    expect(deliverOrientation('t_display_pro', 'landscape', {
      serialPortFor: () => '/dev/cu.x', sendSerial: () => false, sendWifi,
    })).toMatchObject({ transport: 'wifi' });
  });

  it('surfaces an unreachable board instead of reporting success', () => {
    expect(() => deliverOrientation('t_display_pro', 'auto', {
      serialPortFor: () => undefined,
      sendSerial: () => false,
      sendWifi: () => { throw new Error('No online WiFi ESP32 target matches "t_display_pro"'); },
    })).toThrow(/No online WiFi/);
    expect(() => deliverOrientation('', 'auto', {
      serialPortFor: () => undefined, sendSerial: () => false, sendWifi: () => 'x',
    })).toThrow(OrientationRequestError);
  });
});
