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
  return isAlive(receipt.pid);
}
