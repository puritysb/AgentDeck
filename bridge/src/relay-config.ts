/**
 * `relay.json` — the worker side's opt-in to the daemon relay (#273).
 *
 * The hub endpoint and its pairing token live in their own file rather than
 * in `settings.json`: the token is a credential for ANOTHER machine, and
 * `settings.json` is read by more consumers (CLI, device modules, the macOS
 * app's dev build). Written 0600 through tmp+rename, read once at daemon
 * startup — a change takes effect on `agentdeck daemon restart`, which is
 * also how it reaches an autostart unit without baking a credential into the
 * unit's argv.
 *
 * An absent or malformed file means "not configured": a relay never starts
 * on anything but an explicit, readable opt-in.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getDataDir } from './session-registry.js';

export interface RelayConfig {
  host: string;
  port: number;
  token?: string;
}

const FILE = 'relay.json';

export function relayConfigPath(): string {
  return join(getDataDir(), FILE);
}

/** The configured hub, or null when the relay is not opted into. */
export function loadRelayConfig(): RelayConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(relayConfigPath(), 'utf-8')) as Record<string, unknown>;
    const host = typeof parsed.host === 'string' ? parsed.host.trim() : '';
    const port = typeof parsed.port === 'number' && Number.isInteger(parsed.port) ? parsed.port : NaN;
    if (!host || !(port > 0 && port < 65536)) return null;
    const token = typeof parsed.token === 'string' && parsed.token ? parsed.token : undefined;
    return { host, port, ...(token ? { token } : {}) };
  } catch {
    return null;
  }
}

export function saveRelayConfig(config: RelayConfig): void {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.relay.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, relayConfigPath());
}

export function clearRelayConfig(): void {
  rmSync(relayConfigPath(), { force: true });
}
