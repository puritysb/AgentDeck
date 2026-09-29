import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { uuid, runtimeFile, installedPath, inspectInstallation, digest, verifyRuntime } from './deployment-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'plugin', `${uuid}.sdPlugin`);
const installed = installedPath();
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', timeout: 120000, windowsHide: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
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
  const wanted = expected(Date.now());
  const backup = join(homedir(), '.agentdeck', 'plugin-backups', `${Date.now()}`, `${uuid}.sdPlugin`);
  let moved = false;
  let changed = false;
  run('streamdeck', ['stop', uuid]);
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
    run('streamdeck', ['restart', uuid]);
    const deadline = Date.now() + 20000;
    do {
      if (verifyRuntime(receipt(), wanted, alive)) {
        console.log(`Plugin deployed and running: ${wanted.sha256.slice(0, 12)} PID ${receipt().pid}`);
        if (moved) console.log(`Previous installation preserved: ${backup}`);
        return;
      }
      await new Promise(r => setTimeout(r, 250));
    } while (Date.now() < deadline);
    throw new Error('No fresh matching Stream Deck runtime receipt after restart');
  } catch (error) {
    if (changed) {
      run('streamdeck', ['stop', uuid]);
      // Only remove the link created by this attempt; never erase an unexpected install.
      if (!inspectInstallation(source, installed)) rmSync(installed);
      if (moved && !existsSync(installed)) renameSync(backup, installed);
      run('streamdeck', ['restart', uuid]);
    }
    throw error;
  }
}
main().catch(error => { console.error(`Plugin deployment failed: ${error.message}`); process.exitCode = 1; });
