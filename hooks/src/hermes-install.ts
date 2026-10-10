import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermesProfileHome, isHermesPort } from './hermes-diagnostics.js';

/** Source package assets are shipped beside dist in the published hooks package. */
export const hermesObserverSource = resolve(dirname(fileURLToPath(import.meta.url)), '../hermes-agentdeck');

/**
 * `--port` as the user typed it. Only plain decimal digits are a port:
 * `Number()` alone accepted `0x2380` (9088), `1e3` (1000) and `9120.0`, and a
 * persisted port the user did not mean surfaces later only as `unreachable`.
 * Anything else yields NaN, which `installHermesObserver` refuses before
 * writing a file.
 */
export function parseHermesPortFlag(text: string): number {
  return /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
}

/** Explicit installation only; Hermes remains responsible for plugin enablement. */
export function installHermesObserver(home?: string, options: { port?: number | null } = {}): string {
  if (options.port !== undefined && options.port !== null && !isHermesPort(options.port)) {
    throw new Error('Port must be an integer from 1 to 65535');
  }
  const target = join(hermesProfileHome(home), 'plugins', 'agentdeck-observer');
  const files = ['__init__.py', 'plugin.yaml', 'ci-wait-rules.json'];
  const marker = join(target, '.agentdeck-owned');
  if (existsSync(target) && !existsSync(marker)) {
    throw new Error(`Refusing to overwrite unowned Hermes plugin: ${target}`);
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(marker, 'agentdeck-hermes-observer-v1\n');
  for (const file of files) writeFileSync(join(target, file), readFileSync(join(hermesObserverSource, file)));
  const connection = join(target, 'connection.json');
  if (options.port === null) rmSync(connection, { force: true });
  else if (options.port !== undefined) writeFileSync(connection, JSON.stringify({ port: options.port }) + '\n', { mode: 0o600 });
  return target;
}
