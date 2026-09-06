/** Private benchmark boundary and provenance. Never imports the daemon or opens its database. */
import { mkdirSync, readFileSync, realpathSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const within = (path, parent) => {
  const rel = relative(parent, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
  );
};
const canonical = (path) =>
  existsSync(path) ? realpathSync(path) : resolve(canonical(dirname(path)), path.split(/[\\/]/).pop());
export function safeName(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value) ||
    ['settings', 'fixture'].includes(value)
  ) {
    throw new Error('Profile and case names must be simple, non-reserved identifiers');
  }
  return value;
}
export function privateRoot(
  input,
  forbidden = [repo, join(homedir(), '.agentdeck'), process.env.AGENTDECK_DATA_DIR].filter(Boolean),
) {
  if (!input) throw new Error('An explicit private fixture directory is required');
  const root = realpathSync(input);
  if (!statSync(root).isDirectory() || forbidden.some((path) => within(root, canonical(path)))) {
    throw new Error('Use a private fixture directory outside the repository and live data directories');
  }
  process.umask(0o077);
  return root;
}
export function privateOutput(root, profile) {
  const output = join(root, safeName(profile));
  // A symlink must never redirect private outputs to the repository or live data.
  if (canonical(output) !== output) throw new Error('Output directories must not be symlinks');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  return output;
}
export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function hashTree(root) {
  const hash = createHash('sha256');
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (name.endsWith('.js')) hash.update(relative(root, path)).update('\0').update(readFileSync(path));
    }
  }
  visit(root);
  return hash.digest('hex');
}
export function recordManifest(root, output, config, fixtureNames) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const manifest = {
    schema: 1,
    commit: git(['rev-parse', 'HEAD']),
    workingTree: git(['status', '--porcelain', '--untracked-files=normal']),
    node: process.version,
    bridgeDistSha256: hashTree(join(repo, 'bridge/dist')),
    sharedDistSha256: hashTree(join(repo, 'shared/dist')),
    scriptsSha256: Object.fromEntries(
      ['replay', 'normalized', 'boundary', 'evidence'].map((name) => [
        name,
        hashFile(join(repo, `scripts/apme-serving-${name}.mjs`)),
      ]),
    ),
    fixtures: Object.fromEntries(fixtureNames.map((name) => [name, hashFile(join(root, name))])),
    // Server build/model digest cannot be inferred from a model's friendly name.
    serverRevision: process.env.BENCH_SERVER_REVISION ?? 'unrecorded',
    config,
  };
  const file = join(output, 'manifest.json');
  const encoded = JSON.stringify(manifest, null, 2);
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') !== encoded)
      throw new Error('Evidence/configuration changed; use a new BENCH_PROFILE');
  } else {
    if (readdirSync(output).length)
      throw new Error('Existing evidence has no manifest; preserve it and use a new BENCH_PROFILE');
    writeFileSync(file, encoded, { flag: 'wx', mode: 0o600 });
  }
  return hashFile(file);
}

/** The result file closes this attempt. A start without a result is preserved
 * as interrupted work; rerunning must use a new profile rather than erase it. */
export function claimAttempt(output, name) {
  const file = join(output, `${safeName(name)}.started.json`);
  writeFileSync(file, JSON.stringify({ startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
}
