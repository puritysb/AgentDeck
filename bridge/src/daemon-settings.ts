/**
 * `settings.json` access for the daemon — one reader, one writer.
 *
 * The reader was private to `daemon-server.ts`, which meant anything else that
 * needed a setting either re-implemented the cross-directory discovery or, as
 * the device-settings modules do, hardcoded `homedir()/.agentdeck` and lost the
 * `AGENTDECK_DATA_DIR` override (roadmap item 14). Extracted here so a second
 * consumer inherits the discovery rules rather than a copy of them.
 *
 * Read and write are deliberately asymmetric:
 *
 * - **Read** looks at every candidate data dir and takes the NEWEST file. A CLI
 *   world and an app world can both be installed, and the most recently written
 *   file is the one the user last edited.
 * - **Write** touches only `getDataDir()` — this process's own directory. A
 *   cross-directory write would reach into another install's state (and, on
 *   macOS, into a sandbox container this process cannot legally touch).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getCandidateDataDirs, getDataDir } from './session-registry.js';

/**
 * Newest `settings.json` across candidate data dirs — mirrors the
 * daemon.json/sessions.json cross-dir discovery (and honors the
 * AGENTDECK_DATA_DIR test override, which the hardcoded `~/.agentdeck` path in
 * the device-settings modules ignores). The App Store sandbox container is
 * intentionally NOT a candidate (TCC hang risk — see `getCandidateDataDirs`),
 * so settings written by the sandboxed Swift app stay invisible here; that
 * coexistence limit is documented in docs/appstore-feature-matrix.md.
 *
 * Never throws: an absent, unreadable or malformed file yields `{}`, so a
 * setting's fallback is always the one its own reader defines.
 */
export function loadDaemonSettings(): Record<string, unknown> {
  let best: { mtime: number; parsed: Record<string, unknown> } | null = null;
  for (const dir of getCandidateDataDirs()) {
    try {
      const path = join(dir, 'settings.json');
      const mtime = statSync(path).mtimeMs;
      if (best && best.mtime >= mtime) continue;
      best = { mtime, parsed: JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> };
    } catch {
      // Missing or unreadable — skip this candidate.
    }
  }
  return best?.parsed ?? {};
}

/**
 * Read-modify-write one key of this process's own `settings.json`.
 *
 * `undefined` deletes the key rather than storing a null — a persisted setting
 * that has been cleared must be indistinguishable from one that was never set,
 * or every reader needs a third case.
 *
 * The write is tmp+rename like every other file this daemon owns: settings.json
 * is read by the daemon, the CLI and the device modules, and a half-written
 * file reads as `{}` — which is to say, as every default at once.
 */
export function updateDaemonSetting(key: string, value: unknown): void {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Missing or malformed — start from empty rather than refusing to write.
  }
  if (value === undefined) delete settings[key];
  else settings[key] = value;

  const tmp = join(dir, `.settings.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/** Absolute path of the `settings.json` this process writes to. */
export function ownSettingsPath(): string {
  return join(getDataDir(), 'settings.json');
}
