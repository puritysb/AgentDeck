import { setTimeout as delay } from 'node:timers/promises';

export async function waitForRegistryVersion(
  check,
  name,
  version,
  { attempts = 12, intervalMs = 5_000, sleep = delay, log = console.log } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (check(name, version)) return true;
    if (attempt === attempts) break;

    log(
      `[publish-npm] ${name}@${version} is not visible yet; ` +
        `retrying registry check in ${intervalMs}ms (${attempt}/${attempts})`,
    );
    await sleep(intervalMs);
  }
  return false;
}
