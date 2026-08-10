#!/usr/bin/env node
/**
 * Publish the four public npm packages in dependency order with `npm publish`
 * run from each package DIRECTORY.
 *
 * Why not `pnpm --filter <pkg> publish`: pnpm (verified 11.5.2, 2026-08-08)
 * uploads the tarball with README.md inside but does NOT attach the readme to
 * the registry packument — and npmjs.com renders the package page from the
 * packument, so every @agentdeck package page showed no README at all. npm's
 * directory publish populates `manifest.readme` (via read-package-json) and
 * the page renders. Publishing a prebuilt tarball path has the same gap as
 * pnpm, which is why this script publishes from directories.
 *
 * The one thing pnpm's publish did for us — rewriting `workspace:*` to the
 * concrete version — is done here with a write/restore around the publish, so
 * the committed manifests keep the workspace protocol (verify-version-sync
 * enforces that).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// bridge depends on hooks + shared, so those two must exist on the registry
// before bridge's exact-version pins can resolve; setup is last, matching the
// order users install in.
const ORDER = ['shared', 'hooks', 'bridge', 'setup'];

function publishedVersion(name, version) {
  try {
    const output = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim() === version;
  } catch {
    return false;
  }
}

const versionOf = new Map();
for (const pkg of ORDER) {
  const manifest = JSON.parse(readFileSync(join(root, pkg, 'package.json'), 'utf8'));
  versionOf.set(manifest.name, manifest.version);
}
const versions = new Set(versionOf.values());
if (versions.size !== 1) {
  console.error(`[publish-npm] public packages are not in lockstep: ${JSON.stringify([...versionOf])}`);
  process.exit(1);
}
console.log(`[publish-npm] publishing ${[...versions][0]} as: ${ORDER.join(' -> ')}`);

for (const pkg of ORDER) {
  const manifestPath = join(root, pkg, 'package.json');
  const original = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  let rewritten = false;
  for (const section of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [dep, spec] of Object.entries(manifest[section] ?? {})) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        const concrete = versionOf.get(dep);
        if (!concrete) {
          console.error(`[publish-npm] ${pkg}: ${dep} is workspace-linked but not in the publish set`);
          process.exit(1);
        }
        manifest[section][dep] = concrete;
        rewritten = true;
      }
    }
  }
  try {
    if (rewritten) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (publishedVersion(manifest.name, manifest.version)) {
      // A workflow retry after a partial four-package publish must be able to
      // continue past packages whose immutable version already reached npm.
      console.log(`[publish-npm] ==> ${manifest.name}@${manifest.version} already published; skipping`);
    } else {
      console.log(`[publish-npm] ==> ${manifest.name}`);
      execFileSync('npm', ['publish', '--access', 'public'], {
        cwd: join(root, pkg),
        stdio: 'inherit',
      });
    }
  } finally {
    if (rewritten) writeFileSync(manifestPath, original);
  }
}

for (const [name, version] of versionOf) {
  if (!publishedVersion(name, version)) {
    console.error(`[publish-npm] registry verification failed: ${name}@${version}`);
    process.exit(1);
  }
}
console.log('[publish-npm] done');
