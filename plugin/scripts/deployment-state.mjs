import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const uuid = 'bound.serendipity.agentdeck';
export const runtimeFile = join(homedir(), '.agentdeck', 'streamdeck-runtime.json');
export function installedPath(platform = process.platform) {
  if (platform === 'darwin') return join(homedir(), 'Library/Application Support/com.elgato.StreamDeck/Plugins', `${uuid}.sdPlugin`);
  if (platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'Elgato/StreamDeck/Plugins', `${uuid}.sdPlugin`);
  throw new Error('Stream Deck deployment requires macOS or Windows');
}
export function digest(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
export function inspectInstallation(source, installed) {
  try {
    if (!lstatSync(installed).isSymbolicLink()) return 'packaged installation replaces development link';
    if (realpathSync(installed) !== realpathSync(source)) return 'linked to another checkout';
    return null;
  } catch (error) { return `installation unavailable: ${error.code ?? error.message}`; }
}
export function verifyRuntime(receipt, expected, isAlive) {
  if (!receipt || receipt.sha256 !== expected.sha256 || receipt.bundlePath !== expected.bundlePath) return false;
  if (!Number.isInteger(receipt.pid) || receipt.pid <= 0 || (!Number.isFinite(receipt.startedAt) || receipt.startedAt < expected.notBefore)) return false;
  if (receipt.pid === expected.previousPid) return false;
  return isAlive(receipt.pid) === true;
}

// Only ESRCH proves absence; EPERM and other probe failures are unknown.
export function processExists(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Plugin runtime PID is unknown');
  try { kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// The CLI only acknowledges deep-link submission. A busy host processed a stop
// about 75 seconds later (2026-10-25). Retry observation, never queue duplicate
// stop/restart requests that could arrive after the replacement has started.
async function waitUntil(check, failure, { now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), budgetMs = 120000,
  intervalMs = 250, reportEveryMs = 20000, onRetry = () => {} } = {}) {
  const started = now();
  let nextReport = reportEveryMs;
  for (;;) {
    const result = check();
    if (result) return result;
    const elapsedMs = now() - started;
    if (elapsedMs >= budgetMs) throw new Error(`${failure} within ${budgetMs / 1000}s`);
    if (elapsedMs >= nextReport) {
      onRetry({ elapsedMs, budgetMs });
      nextReport = elapsedMs + reportEveryMs;
    }
    await sleep(Math.min(intervalMs, budgetMs - elapsedMs));
  }
}

export async function waitForRuntimeExit(pid, isAlive, options) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Plugin runtime PID is unknown; cannot confirm shutdown');
  await waitUntil(() => isAlive(pid) === false,
    'Previous Stream Deck runtime did not stop before restart', options);
}

export async function stopRuntime(pid, requestStop, isAlive, options) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Plugin runtime PID is unknown; cannot confirm shutdown');
  const alive = isAlive(pid);
  if (alive === false) return; // A previous delayed stop may already have finished.
  if (alive !== true) throw new Error('Plugin runtime process state is unknown');
  await requestStop();
  await waitForRuntimeExit(pid, isAlive, options);
}

export async function waitForRuntime(readReceipt, expected, isAlive, options) {
  return waitUntil(() => {
    const current = readReceipt();
    return verifyRuntime(current, expected, isAlive) ? current : null;
  }, 'No fresh matching Stream Deck runtime receipt after restart', options);
}
