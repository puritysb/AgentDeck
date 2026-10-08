import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/** Source package assets are shipped beside dist in the published hooks package. */
export const hermesObserverSource = resolve(dirname(fileURLToPath(import.meta.url)), '../hermes-agentdeck');

/** Explicit installation only; Hermes remains responsible for plugin enablement. */
export function installHermesObserver(home = process.env.HERMES_HOME || join(homedir(), '.hermes')): string {
  const target = join(resolve(home), 'plugins', 'agentdeck-observer');
  const files = ['__init__.py', 'plugin.yaml', 'ci-wait-rules.json'];
  const marker = join(target, '.agentdeck-owned');
  if (existsSync(target) && !existsSync(marker)) {
    throw new Error(`Refusing to overwrite unowned Hermes plugin: ${target}`);
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(marker, 'agentdeck-hermes-observer-v1\n');
  for (const file of files) writeFileSync(join(target, file), readFileSync(join(hermesObserverSource, file)));
  return target;
}
