import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Capture once at startup. Recomputing after a rebuild would claim new bytes
// while this process is still executing its old module.
export function captureRuntimeIdentity(bundleUrl: string) {
  const bundlePath = realpathSync(fileURLToPath(bundleUrl));
  return { bundlePath, sha256: createHash('sha256').update(readFileSync(bundlePath)).digest('hex'),
    pid: process.pid, startedAt: Date.now() };
}

export function writeRuntimeIdentity(identity: ReturnType<typeof captureRuntimeIdentity>) {
  const file = join(homedir(), '.agentdeck', 'streamdeck-runtime.json');
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(identity), { mode: 0o600 });
  renameSync(temporary, file);
}
