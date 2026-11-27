import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Exercise the actual Python child boundary: an in-process serial mock cannot
// prove that a stuck open/read/close allows the next device to be identified.
const probe = resolve('esp32/scripts/probe_serial_identity.py');
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-serial-probe-'));
  temporary.push(dir);
  writeFileSync(join(dir, 'serial.py'), `
import sys
import time

# A healthy child can start more slowly than the fault-only timeout below.
if sys.argv[-1] == 'healthy-after-hangs':
    time.sleep(0.65)

class Serial:
    def __init__(self, port, **kwargs):
        self.port = port
        self.lines = iter([b'boot log\\n', b'[]\\n', b'{bad}\\n',
                           b'{"type":"device_', b'info","board":"nm_epd_420"}\\n'])
        if port == 'hang-open': time.sleep(60)
    def __enter__(self): return self
    def __exit__(self, *args):
        if self.port == 'hang-close': time.sleep(60)
    def reset_input_buffer(self): pass
    def write(self, request):
        assert request == b'{"type":"device_info_request"}\\n'
    def flush(self):
        raise AssertionError('tcdrain must never be part of a bounded identity probe')
    def read_until(self, *args, **kwargs):
        if self.port == 'hang-read': time.sleep(60)
        if self.port == 'invalid': return b'{"type":"device_info","board":"wrong board"}\\n'
        return next(self.lines, b'')
`);
  return { ...process.env, PYTHONPATH: dir };
}

describe('ESP32 serial identity probe', () => {
  it('retains split JSON and ignores boot noise without calling unbounded flush', () => {
    const result = execFileSync('python3', [probe, 'healthy'], { env: fixture(), encoding: 'utf8', timeout: 8000 });
    expect(result.trim()).toBe('nm_epd_420 healthy');
  });

  it('bounds stuck open, read and close, then identifies the next board', () => {
    const program = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('probe',sys.argv[1])
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
stuck = [probe.probe_port(port, timeout=0.5) for port in ['hang-open','hang-read','hang-close']]
print(json.dumps([*stuck, probe.probe_port('healthy-after-hangs')]))
`;
    const result = execFileSync('python3', ['-c', program, probe], {
      env: fixture(), encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(result)).toEqual([null, null, null, 'nm_epd_420']);
  });

  it('does not turn malformed identity into a flash target', () => {
    const result = execFileSync('python3', [probe, 'invalid'], { env: fixture(), encoding: 'utf8', timeout: 8000 });
    expect(result).toBe('');
  });
});
