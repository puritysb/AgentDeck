import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { uuid, runtimeFile, installedPath, inspectInstallation, digest, verifyRuntime, processExists, stopRuntime, waitForRuntime } from './deployment-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'plugin', `${uuid}.sdPlugin`);
const installed = installedPath();
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', timeout: 120000, windowsHide: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const alive = processExists;
const progress = phase => ({ elapsedMs, budgetMs }) => console.log(
  `Waiting for Stream Deck ${phase}: ${Math.floor(elapsedMs / 1000)}s / ${budgetMs / 1000}s; retrying state check`);
const receipt = () => { try { return JSON.parse(readFileSync(runtimeFile, 'utf8')); } catch { return null; } };
const expected = notBefore => ({ bundlePath: realpathSync(join(source, 'bin/plugin.js')), sha256: digest(join(source, 'bin/plugin.js')), notBefore });
async function main() {
  if (process.argv.includes('--check')) {
    const problem = inspectInstallation(source, installed);
    if (problem) throw new Error(problem);
    if (!verifyRuntime(receipt(), expected(0), alive)) throw new Error('Installed files and running plugin differ; run pnpm plugin:deploy');
    console.log(`Plugin verified: ${receipt().sha256.slice(0, 12)} PID ${receipt().pid}`);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Automatic development deployment currently supports macOS; --check also supports Windows');
  // Worktree names are arbitrary: inspect Git topology, never path substrings.
  if (realpathSync(git('rev-parse', '--absolute-git-dir')) !== realpathSync(resolve(root, git('rev-parse', '--git-common-dir')))) {
    throw new Error('Deploy from the persistent main checkout; worktree links become dangling after cleanup');
  }
  if (git('branch', '-r', '--list', 'origin/master')) {
    try { git('merge-base', '--is-ancestor', 'origin/master', 'HEAD'); }
    catch { throw new Error('Checkout omits origin/master changes. Integrate them before deployment (no automatic reset/merge).'); }
  }
  run('pnpm', ['--filter', '@agentdeck/shared', 'build']);
  run('pnpm', ['--filter', '@agentdeck/plugin', 'build']);
  const backup = join(homedir(), '.agentdeck', 'plugin-backups', `${Date.now()}`, `${uuid}.sdPlugin`);
  let moved = false;
  let changed = false;
  let restartRequested = false;
  const previousPid = receipt()?.pid;
  let hasInstallation = true;
  try { lstatSync(installed); }
  catch (error) { if (error.code === 'ENOENT') hasInstallation = false; else throw error; }
  // A missing receipt is unknown for an existing install. Only an absent
  // installation with no prior runtime is a first install needing no stop.
  if (hasInstallation || previousPid !== undefined) {
    await stopRuntime(previousPid, () => run('streamdeck', ['stop', uuid]), alive,
      { onRetry: progress('shutdown') });
  }
  try {
    if (inspectInstallation(source, installed)) {
      // Keep the complete Marketplace package for reversal, outside the host's scan directory.
      mkdirSync(dirname(backup), { recursive: true });
      try { renameSync(installed, backup); moved = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      changed = true;
      run('streamdeck', ['link', source]);
    }
    const problem = inspectInstallation(source, installed);
    if (problem) throw new Error(problem);
    // Ignore a receipt from before this restart, including a host auto-load
    // after linking. CLI success acknowledges submission, not host handling.
    const wanted = { ...expected(Date.now()), previousPid: receipt()?.pid };
    restartRequested = true;
    run('streamdeck', ['restart', uuid]);
    const running = await waitForRuntime(receipt, wanted, alive,
      { onRetry: progress('startup') });
    console.log(`Plugin deployed and running: ${wanted.sha256.slice(0, 12)} PID ${running.pid}`);
    if (moved) console.log(`Previous installation preserved: ${backup}`);
  } catch (error) {
    // A timed-out restart may still be queued in the host. Do not follow it
    // with another stop/restart or swap files beneath that pending request.
    if (restartRequested) {
      throw new Error(`${error.message}; installation retained${moved ? `, previous package preserved at ${backup}` : ''}. Retry deployment after the host responds.`, { cause: error });
    }
    if (changed) {
      await stopRuntime(receipt()?.pid, () => run('streamdeck', ['stop', uuid]), alive,
        { onRetry: progress('rollback shutdown') });
      // Only remove the link created by this attempt; never erase an unexpected install.
      if (!inspectInstallation(source, installed)) rmSync(installed);
      if (moved && !existsSync(installed)) renameSync(backup, installed);
      run('streamdeck', ['restart', uuid]);
    }
    throw error;
  }
}
main().catch(error => { console.error(`Plugin deployment failed: ${error.message}`); process.exitCode = 1; });
