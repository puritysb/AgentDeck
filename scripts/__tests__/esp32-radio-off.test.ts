import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const firmware = join(root, 'esp32/src');
const wifiManager = join(firmware, 'net/wifi_manager.cpp');

// Calls that take the WiFi driver to WIFI_OFF. On Arduino 3 that destroys the
// default netifs, which the mDNS responder must not outlive
// (esp32/src/net/mdns_discovery.cpp), so radioOff() is the only way in.
const RADIO_OFF = /WiFi\.mode\(\s*WIFI_OFF\s*\)|WiFi\.disconnect\(\s*true|WiFi\.enableSTA\(\s*false|esp_wifi_stop\(|esp_wifi_deinit\(/;
const RADIO_OFF_FN = /static void radioOff\(\) \{\n([\s\S]*?)\n\}\n/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(c|cpp|h|hpp)$/.test(name) ? [path] : [];
  });
}

describe('ESP32 firmware radio-off', () => {
  it('stops mDNS inside radioOff() before the radio goes off', () => {
    const body = readFileSync(wifiManager, 'utf-8').match(RADIO_OFF_FN)?.[1] ?? '';
    const stop = body.indexOf('Net::mdnsStop();');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(body.indexOf('WiFi.mode(WIFI_OFF);'));
  });

  it('turns the radio off nowhere else', () => {
    const offenders: string[] = [];
    for (const file of sources(firmware)) {
      let text = readFileSync(file, 'utf-8');
      // Blank the one sanctioned call site, keeping line numbers for the report.
      if (file === wifiManager) text = text.replace(RADIO_OFF_FN, (fn) => fn.replace(/[^\n]/g, ''));
      text.split('\n').forEach((line, i) => {
        if (RADIO_OFF.test(line.replace(/\/\/.*$/, ''))) {
          offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
