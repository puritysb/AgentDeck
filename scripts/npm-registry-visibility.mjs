import { setTimeout as delay } from 'node:timers/promises';

export async function waitForRegistryVersion(
  check,
  name,
  version,
  // Ten minutes. npm reports "being processed and may take a few minutes"
  // after a provenance-signed publish, and 1.6.0 took about five minutes to
  // become visible for three of its four packages: a 60-second window failed a
  // release whose publish had fully succeeded, skipping its GitHub Release.
  { attempts = 60, intervalMs = 10_000, sleep = delay, log = console.log } = {},
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
