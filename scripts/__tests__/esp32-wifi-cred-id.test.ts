import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const firmware = join(root, 'esp32/src');
const protocol = join(firmware, 'net/protocol.cpp');
const serialClient = join(firmware, 'net/serial_client.cpp');

// device_info.wifiCredId travels on the serial copy only: the WebSocket carries
// the pairing token in plaintext, and the id is an HMAC over the WiFi password
// keyed by that token, so the two together are an offline test for password
// guesses (esp32/src/net/protocol.cpp, sendDeviceInfo).
const FRAME_CALL = /sendDeviceInfoFrame\(\s*resp\s*,[^;]*?,\s*(true|false)\s*,\s*(true|false)\s*\)/g;
// Every call, whatever its transport arguments. A computed one (master's
// `true, Net::wsConnected()`) is one frame for both transports, and FRAME_CALL
// alone would skip it.
const ANY_FRAME_CALL = /sendDeviceInfoFrame\(\s*resp\s*,/g;

function code(file: string): string {
  return readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(c|cpp|h|hpp)$/.test(name) ? [path] : [];
  });
}

describe('ESP32 firmware credential id', () => {
  it('removes it before every WebSocket copy of device_info', () => {
    const text = code(protocol);
    const calls = [...text.matchAll(FRAME_CALL)];
    expect(calls.length).toBeGreaterThan(0);
    // Each transport is chosen by a literal, so the check below sees them all.
    expect(calls.length).toBe([...text.matchAll(ANY_FRAME_CALL)].length);
    let since = text.indexOf('resp["wifiCredId"]');
    expect(since).toBeGreaterThan(0);
    for (const call of calls) {
      const [, toSerial, toWs] = call;
      if (toWs === 'true') {
        // One frame for both transports would carry it to both.
        expect(toSerial).toBe('false');
        expect(text.slice(since, call.index)).toContain('resp.remove("wifiCredId")');
      }
      since = call.index ?? since;
    }
  });

  it('is built into no frame but the two device_info producers', () => {
    const carriers = sources(firmware)
      .filter((file) => code(file).includes('"wifiCredId"'))
      .map((file) => relative(root, file))
      .sort();
    expect(carriers).toEqual([relative(root, protocol), relative(root, serialClient)].sort());
    // The serial-only producer has no WebSocket path at all.
    expect(code(serialClient)).not.toMatch(/\bwsSend\(|sendDeviceInfoFrame\(/);
  });
});
