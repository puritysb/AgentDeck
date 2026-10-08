#!/usr/bin/env node
// Repository-side development tooling, never bundled into the Apple app.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync,
  renameSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 }).trim();

export function validateCheckout(root, expectedSha) {
  if (git(root, 'rev-parse', '--show-toplevel') !== realpathSync(root)) throw new Error('Use the repository root');
  if (git(root, 'branch', '--show-current') !== 'master') throw new Error('Deployment requires master');
  if (git(root, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Tracked changes belong to another session');
  const sha = git(root, 'rev-parse', 'HEAD');
  if (sha !== git(root, 'rev-parse', 'origin/master')) throw new Error('Checkout differs from origin/master');
  // A queued event may be older than the newest main commit; never downgrade.
  if (expectedSha) git(root, 'merge-base', '--is-ancestor', expectedSha, sha);
  return sha;
}

async function deploy() {
  if (process.platform !== 'darwin') throw new Error('Local deployment requires macOS');
  const root = realpathSync(process.env.AGENTDECK_MAIN_CHECKOUT || process.cwd());
  const sha = validateCheckout(root, process.env.GITHUB_SHA);
  const logs = join(root, 'diagnostics/logs');
  mkdirSync(logs, { recursive: true });
  const lock = join(root, 'diagnostics/local-main-deploy.lock');
  mkdirSync(lock); // Exclusive across workflow and manual deployments.
  const run = (name, command, args, timeout = 600_000) => {
    console.log(name);
    const fd = openSync(join(logs, `local-main-${name}.log`), 'w');
    try { return execFileSync(command, args, { cwd: root, timeout, stdio: ['ignore', fd, fd] }); }
    catch (error) { throw new Error(`${name} failed; see diagnostics/logs/local-main-${name}.log`, { cause: error }); }
    finally { closeSync(fd); }
  };
  try {
    run('install', 'pnpm', ['install', '--frozen-lockfile']);
    run('build', 'pnpm', ['build']);
    run('typecheck', 'pnpm', ['typecheck']);
    run('tests', 'pnpm', ['test']);
    run('native', process.execPath, ['bridge/dist/cli.js', 'diag', 'native']);
    run('macos-build', 'xcodebuild', ['build', '-project', 'apple/AgentDeck.xcodeproj',
      '-scheme', 'AgentDeck_macOS', '-destination', 'platform=macOS,arch=arm64',
      '-derivedDataPath', 'apple/DerivedData', '-quiet']);
    // Recheck after lengthy builds before changing installed/running artifacts.
    if (validateCheckout(root, process.env.GITHUB_SHA) !== sha) throw new Error('Main changed during the build');
    const sourceApp = join(root, 'apple/DerivedData/Build/Products/Debug/AgentDeck.app');
    const target = '/Applications/AgentDeck.app';
    const staged = '/Applications/AgentDeck.deploy-staged.app';
    const backup = join(root, 'diagnostics/backups', `AgentDeck-${Date.now()}.app`);
    mkdirSync(join(root, 'diagnostics/backups'), { recursive: true });
    if (existsSync(staged)) throw new Error('A staged app from an earlier deployment needs inspection');
    run('stage-app', 'ditto', [sourceApp, staged]);
    run('app-signature', 'codesign', ['--verify', '--deep', '--strict', staged]);
    // CLI must remain linked to the persistent main tree (never runner _work).
    if (realpathSync('/opt/homebrew/bin/agentdeck') !== join(root, 'bridge/dist/cli.js')) {
      throw new Error('CLI is not linked to the persistent main checkout');
    }
    let appPid;
    try { appPid = execFileSync('pgrep', ['-f', '^/Applications/AgentDeck.app/Contents/MacOS/AgentDeck$'], { encoding: 'utf8' }).trim(); }
    catch (error) { if (error.status !== 1) throw error; }
    for (const pid of (appPid || '').split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGTERM');
    for (let attempt = 0; appPid && attempt < 20; attempt++) {
      const alive = appPid.split('\n').some(pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } });
      if (!alive) { appPid = ''; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (appPid) throw new Error('Installed app did not quit; preserving it');
    if (existsSync(target)) renameSync(target, backup);
    try {
      renameSync(staged, target);
      run('open-app', 'open', [target]);
    } catch (error) {
      if (existsSync(target)) renameSync(target, staged);
      if (existsSync(backup)) { renameSync(backup, target); execFileSync('open', [target]); }
      throw error;
    }
    run('daemon-restart', process.execPath, ['bridge/dist/cli.js', 'daemon', 'restart'], 180_000);
    run('plugin-deploy', 'pnpm', ['plugin:deploy']);
    run('plugin-check', 'pnpm', ['plugin:check']);
    const registry = JSON.parse(readFileSync(join(homedir(), '.agentdeck/daemon.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${registry.port}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
    const health = await response.json();
    const { computeDistBuildIdentity } = await import(pathToFileURL(join(root, 'bridge/dist/daemon-build-identity.js')));
    const build = computeDistBuildIdentity().id;
    if (health.pid !== registry.pid || !build || health.build !== build) throw new Error('Running daemon differs from the installed build');
    const runningAppPid = execFileSync('pgrep', ['-f', '^/Applications/AgentDeck.app/Contents/MacOS/AgentDeck$'],
      { encoding: 'utf8', timeout: 5000 }).trim();
    const receipt = { verifiedAt: new Date().toISOString(), commit: sha, trigger: process.env.GITHUB_EVENT_NAME || 'manual',
      workflowRun: process.env.GITHUB_RUN_ID || null, daemon: { pid: health.pid, port: registry.port, build },
      macOS: { path: target, pid: runningAppPid, backup }, pixoo: health.modules?.pixoo, plugin: { verified: true } };
    const receiptPath = join(root, 'diagnostics/latest-main-deployment.json');
    writeFileSync(`${receiptPath}.tmp`, JSON.stringify(receipt, null, 2));
    renameSync(`${receiptPath}.tmp`, receiptPath);
    console.log(`Deployed main ${sha.slice(0, 12)}; daemon ${build}; plugin runtime verified`);
  } finally { rmSync(lock, { recursive: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deploy().catch(error => { console.error(error.message); process.exitCode = 1; });
}
