#!/usr/bin/env node
// Repository-side development tooling, never bundled into the Apple app.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync,
  renameSync, rmSync, realpathSync, statSync } from 'node:fs';
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

/**
 * Environment for a process that must outlive the workflow job. The Actions
 * runner SIGKILLs every process still carrying its `RUNNER_TRACKING_ID` when a
 * job ends, and `open` hands the caller's environment to the app it launches:
 * the freshly installed app was killed 24 s after launch by Runner.Worker
 * (2026-10-11, `exited due to SIGKILL | sent by Runner.Worker`), so every
 * deployment left the Mac without its dashboard. An empty value opts out.
 */
export function detachedEnv(env = process.env) {
  return { ...env, RUNNER_TRACKING_ID: '' };
}

/**
 * Poll the restarted daemon until it answers as the installed build. A single
 * 5 s probe right after `daemon restart` raced the daemon's startup work
 * (opening a multi-GB APME store blocks the loop for seconds) and failed a
 * deployment whose daemon was healthy moments later. The registry is re-read
 * each attempt because a supervised restart may still be handing over.
 */
export async function waitForDaemonHealth({ readRegistry, build, fetchImpl = fetch,
  deadlineMs = 90_000, attemptTimeoutMs = 5_000, intervalMs = 1_000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + deadlineMs;
  let lastError = 'no attempt';
  for (;;) {
    try {
      const registry = readRegistry();
      const response = await fetchImpl(`http://127.0.0.1:${registry.port}/health`,
        { signal: AbortSignal.timeout(attemptTimeoutMs) });
      if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
      const health = await response.json();
      if (health.pid !== registry.pid) throw new Error(`Health pid ${health.pid} is not registry pid ${registry.pid}`);
      if (health.build !== build) throw new Error(`Running daemon build ${health.build} differs from installed ${build}`);
      return { registry, health };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (now() + intervalMs > deadline) throw new Error(`Daemon did not become healthy: ${lastError}`);
    await sleep(intervalMs);
  }
}

/**
 * Run the steps between staging the app and swapping it in, and discard the
 * staged copy if one fails. Nothing installed has changed by then, so the
 * copy is only this run's own build. Left in place, it trips the "needs
 * inspection" guard on every later push: after the installed app outlasted the
 * quit wait on 2026-10-18 17:15Z, the next six deployments stopped there over
 * nine hours. The guard stays for a swap that was interrupted, which no catch
 * here can see.
 */
export async function beforeSwap(staged, steps, remove = path => rmSync(path, { recursive: true, force: true })) {
  try {
    await steps();
  } catch (error) {
    remove(staged);
    throw error;
  }
}

/** An unreadable receipt is unknown, never permission to replace a Store app. */
export function hasAppStoreReceipt(target, stat = statSync) {
  try {
    stat(join(target, 'Contents/_MASReceipt/receipt'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Preserve Store delivery; development swaps recover the original even when
 * moving it to the backup fails (e.g. macOS denies app-management access). */
export async function installMacApp({ target, staged, backup, prepare, quit, launch,
  rename = renameSync }) {
  if (hasAppStoreReceipt(target)) return { action: 'preserved-app-store', backup: null };
  if (existsSync(staged)) throw new Error('A staged app from an earlier deployment needs inspection');
  let quitAttempted = false;
  let backedUp = false;
  let installed = false;
  try {
    await beforeSwap(staged, async () => {
      await prepare();
      // An App Store install may have completed during the build/staging work.
      if (hasAppStoreReceipt(target)) throw new Error('App Store installation appeared during deployment; preserving it');
      quitAttempted = true;
      await quit();
      if (existsSync(target)) { rename(target, backup); backedUp = true; }
    });
    rename(staged, target);
    installed = true;
    await launch();
    return { action: backedUp ? 'replaced-development' : 'installed-development', backup: backedUp ? backup : null };
  } catch (error) {
    // If recovery itself fails, keep all remaining copies for inspection.
    if (backedUp) {
      if (installed) rename(target, staged);
      rename(backup, target);
    }
    if (quitAttempted && existsSync(target)) await launch();
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

/** Keep only the newest `keep` app backups; each is a full app bundle and one
 *  accrued per deployment (32 copies, 2.5 GB by 2026-10-11). */
export function pruneAppBackups(dir, keep = 3) {
  if (!existsSync(dir)) return [];
  const stamped = readdirSync(dir)
    .map(name => ({ name, stamp: /^AgentDeck-(\d+)\.app$/.exec(name)?.[1] }))
    .filter(entry => entry.stamp)
    .sort((a, b) => Number(b.stamp) - Number(a.stamp));
  const removed = stamped.slice(keep).map(entry => entry.name);
  for (const name of removed) rmSync(join(dir, name), { recursive: true, force: true });
  return removed;
}

async function deploy() {
  if (process.platform !== 'darwin') throw new Error('Local deployment requires macOS');
  const root = realpathSync(process.env.AGENTDECK_MAIN_CHECKOUT || process.cwd());
  const sha = validateCheckout(root, process.env.GITHUB_SHA);
  const logs = join(root, 'diagnostics/logs');
  mkdirSync(logs, { recursive: true });
  const lock = join(root, 'diagnostics/local-main-deploy.lock');
  mkdirSync(lock); // Exclusive across workflow and manual deployments.
  const run = (name, command, args, timeout = 600_000, env = process.env) => {
    console.log(name);
    const fd = openSync(join(logs, `local-main-${name}.log`), 'w');
    try { return execFileSync(command, args, { cwd: root, timeout, env, stdio: ['ignore', fd, fd] }); }
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
    // CLI must remain linked to the persistent main tree (never runner _work).
    if (realpathSync('/opt/homebrew/bin/agentdeck') !== join(root, 'bridge/dist/cli.js')) {
      throw new Error('CLI is not linked to the persistent main checkout');
    }
    const appDeployment = await installMacApp({ target, staged, backup,
      prepare: async () => {
        run('stage-app', 'ditto', [sourceApp, staged]);
        run('app-signature', 'codesign', ['--verify', '--deep', '--strict', staged]);
      },
      quit: async () => {
        let appPid;
        try { appPid = execFileSync('pgrep', ['-f', '^/Applications/AgentDeck.app/Contents/MacOS/AgentDeck$'], { encoding: 'utf8' }).trim(); }
        catch (error) { if (error.status !== 1) throw error; }
        for (const pid of (appPid || '').split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGTERM');
        // The app handles SIGTERM on its main queue, so a busy main thread delays
        // it. The handler ran 5 to 6 s (2026-10-17) and about 40 s (10-18) after this
        // signal, both times after a 10 s wait had given up. The app quit anyway,
        // and the Mac had no app until the next deployment, 43 min and 8 h 49 min
        // later.
        for (let attempt = 0; appPid && attempt < 120; attempt++) {
          const alive = appPid.split('\n').some(pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } });
          if (!alive) { appPid = ''; break; }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (appPid) throw new Error('Installed app did not quit within 60 s; preserving it');
      },
      launch: async () => { run('open-app', 'open', [target], 60_000, detachedEnv()); },
    });
    console.log(`macOS app: ${appDeployment.action}`);
    // An unsupervised restart spawns the daemon detached with this environment.
    run('daemon-restart', process.execPath, ['bridge/dist/cli.js', 'daemon', 'restart'], 180_000, detachedEnv());
    run('plugin-deploy', 'pnpm', ['plugin:deploy']);
    run('plugin-check', 'pnpm', ['plugin:check']);
    const { computeDistBuildIdentity } = await import(pathToFileURL(join(root, 'bridge/dist/daemon-build-identity.js')));
    const build = computeDistBuildIdentity().id;
    if (!build) throw new Error('Installed daemon build identity is unknown');
    const { registry, health } = await waitForDaemonHealth({ build,
      readRegistry: () => JSON.parse(readFileSync(join(homedir(), '.agentdeck/daemon.json'), 'utf8')) });
    let runningAppPid = null;
    try { runningAppPid = execFileSync('pgrep', ['-f', '^/Applications/AgentDeck.app/Contents/MacOS/AgentDeck$'],
      { encoding: 'utf8', timeout: 5000 }).trim(); }
    catch (error) { if (error.status !== 1 || appDeployment.action !== 'preserved-app-store') throw error; }
    const receipt = { verifiedAt: new Date().toISOString(), commit: sha, trigger: process.env.GITHUB_EVENT_NAME || 'manual',
      workflowRun: process.env.GITHUB_RUN_ID || null, daemon: { pid: health.pid, port: registry.port, build },
      macOS: { path: target, pid: runningAppPid, ...appDeployment }, pixoo: health.modules?.pixoo, plugin: { verified: true } };
    const receiptPath = join(root, 'diagnostics/latest-main-deployment.json');
    writeFileSync(`${receiptPath}.tmp`, JSON.stringify(receipt, null, 2));
    renameSync(`${receiptPath}.tmp`, receiptPath);
    const pruned = pruneAppBackups(join(root, 'diagnostics/backups'));
    if (pruned.length) console.log(`Pruned ${pruned.length} older app backup(s)`);
    console.log(`Deployed main ${sha.slice(0, 12)}; daemon ${build}; plugin runtime verified`);
  } finally { rmSync(lock, { recursive: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deploy().catch(error => { console.error(error.message); process.exitCode = 1; });
}
