/**
 * "Latest version" on a dev checkout is a fact about two clocks — source vs
 * build — and about two processes: the daemon holding the port vs the code on
 * disk. Neither is visible anywhere else, because `dist/cli.js` is overwritten
 * in place: a daemon started before a rebuild reports the same pid, port and
 * package version as one started after it.
 *
 * These tests drive the two predicates that answer those questions. The
 * staleness one is exercised against a real temp tree with real mtimes rather
 * than a mocked `statSync`, because the failure it exists to catch is about
 * WHICH files count (a test edit must not read as a stale build, a package with
 * no dist at all must).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  computeDistBuildIdentity,
  distBuildIdentity,
  distBuildId,
  findStaleSources,
  findSourceCheckout,
  buildPackages,
} from '../daemon-build-identity.js';

let root: string;

/** Seconds since epoch, so utimes takes it directly. */
const T0 = 1_700_000_000;

function write(path: string, body: string, atSeconds: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  utimesSync(path, atSeconds, atSeconds);
}

/** A workspace with one built package: src at T0, dist at T0 + 60s. */
function seedPackage(pkg: string, opts: { srcAt?: number; distAt?: number | null } = {}): void {
  const srcAt = opts.srcAt ?? T0;
  write(join(root, pkg, 'src', 'index.ts'), 'export const x = 1;\n', srcAt);
  const distAt = opts.distAt === undefined ? srcAt + 60 : opts.distAt;
  if (distAt !== null) write(join(root, pkg, 'dist', 'index.js'), 'export const x = 1;\n', distAt);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentdeck-build-id-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "*"\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findStaleSources', () => {
  it('reports nothing when every build is newer than its source', () => {
    for (const pkg of ['shared', 'hooks', 'bridge']) seedPackage(pkg);
    expect(findStaleSources(root)).toEqual([]);
  });

  it('names the package and the newest unbuilt file', () => {
    seedPackage('shared');
    seedPackage('hooks');
    seedPackage('bridge');
    // An edit after the last build — the case the whole feature is about.
    write(join(root, 'bridge', 'src', 'daemon-server.ts'), 'export const y = 2;\n', T0 + 600);

    const stale = findStaleSources(root);
    expect(stale.map((s) => s.pkg)).toEqual(['bridge']);
    expect(stale[0].newestSource.endsWith('daemon-server.ts')).toBe(true);
    expect(stale[0].sourceMtimeMs).toBeGreaterThan(stale[0].distMtimeMs);
  });

  it('compares per package, not against one global build time', () => {
    // shared was edited after ITS build; bridge was built later still. A single
    // newest-dist timestamp would call shared current — and the daemon would
    // load a stale shared/dist with nothing saying so.
    seedPackage('shared', { srcAt: T0 + 300, distAt: T0 + 60 });
    seedPackage('bridge', { srcAt: T0, distAt: T0 + 900 });
    expect(findStaleSources(root).map((s) => s.pkg)).toEqual(['shared']);
  });

  it('treats a package that has never been built as stale', () => {
    seedPackage('bridge', { distAt: null });
    const stale = findStaleSources(root);
    expect(stale.map((s) => s.pkg)).toEqual(['bridge']);
    expect(stale[0].distMtimeMs).toBe(0);
  });

  it('ignores test sources — they compile to nothing the daemon loads', () => {
    // Counting them would report a stale build after every test edit, and a
    // warning that fires constantly is one nobody reads.
    seedPackage('bridge');
    write(join(root, 'bridge', 'src', '__tests__', 'thing.test.ts'), 'test\n', T0 + 900);
    write(join(root, 'bridge', 'src', 'other.test.ts'), 'test\n', T0 + 900);
    write(join(root, 'bridge', 'src', 'types.d.ts'), 'declare const z: 1;\n', T0 + 900);
    expect(findStaleSources(root)).toEqual([]);
  });

  it('says nothing about a package it cannot see', () => {
    // A checkout without `hooks` is not a checkout with a stale `hooks`.
    seedPackage('bridge');
    expect(findStaleSources(root)).toEqual([]);
  });
});

describe('findSourceCheckout', () => {
  it('finds the workspace root from a package inside it', () => {
    mkdirSync(join(root, 'bridge', 'src'), { recursive: true });
    mkdirSync(join(root, 'bridge', 'dist'), { recursive: true });
    expect(findSourceCheckout(join(root, 'bridge'))).toBe(root);
  });

  it('returns null for an installed package (a dist with no src beside it)', () => {
    // Both markers are required: an installed @agentdeck/bridge has neither a
    // sibling `src` nor a workspace file above it, and rebuilding there is not
    // a thing that can succeed.
    const installed = join(root, 'node_modules', '@agentdeck', 'bridge');
    mkdirSync(join(installed, 'dist'), { recursive: true });
    rmSync(join(root, 'pnpm-workspace.yaml'));
    expect(findSourceCheckout(installed)).toBeNull();
  });
});

describe('distBuildIdentity', () => {
  it('answers the same digest every time within a process', () => {
    const first = distBuildIdentity();
    const second = distBuildIdentity();
    expect(second).toBe(first);
    // The memo is the contract, not an optimisation: the daemon captures this
    // once at startup, so a rebuild underneath it must show as a mismatch
    // rather than being absorbed by a fresh read.
    expect(distBuildId()).toBe(first.id);
  });

  it('recomputes on demand for the before/after comparison around a build', () => {
    // Same tree, so the same digest — what matters is that the uncached entry
    // point READ the tree rather than answering from the memo the daemon
    // depends on staying frozen.
    expect(computeDistBuildIdentity().id).toBe(distBuildIdentity().id);
    expect(computeDistBuildIdentity()).not.toBe(distBuildIdentity());
  });

  it('is a short hex digest over real build output', () => {
    const identity = distBuildIdentity();
    // This suite runs against a built repo; if that ever stops being true the
    // assertion below should fail loudly rather than be relaxed to `?.`.
    expect(identity.files).toBeGreaterThan(0);
    expect(identity.id).toMatch(/^[0-9a-f]{12}$/);
    expect(identity.trees.length).toBeGreaterThan(0);
  });
});

describe('installed runtime build identity', () => {
  function packageAt(scope: string, name: string, code: string) {
    const pkg = join(scope, name);
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    // These are the real public packages' import-only export conditions.
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({
      name: `@agentdeck/${name}`, type: 'module', exports: { '.': { import: './dist/index.js' } },
    }));
    writeFileSync(join(pkg, 'dist', 'index.js'), code);
    return join(pkg, 'dist');
  }

  function installedLayout() {
    const scope = join(root, 'installed', 'node_modules', '@agentdeck');
    const bridge = packageAt(scope, 'bridge', 'export const bridge = 1;');
    // Execute the compiled shipping module from the installed layout, not a
    // mocked resolver or an identity helper still anchored in the workspace.
    writeFileSync(join(bridge, 'daemon-build-identity.js'), readFileSync(
      resolve(__dirname, '../../dist/daemon-build-identity.js'), 'utf8',
    ));
    const shared = packageAt(scope, 'shared', 'throw new Error("dependency must not be evaluated");');
    const hooks = packageAt(scope, 'hooks', 'throw new Error("dependency must not be evaluated");');
    packageAt(scope, 'unrelated', 'export const noise = 1;');
    return { bridge, shared, hooks };
  }

  function run(bridge: string, body: string) {
    const modulePath = join(bridge, 'daemon-build-identity.js');
    const script = `import {pathToFileURL} from 'node:url';
      import {writeFileSync} from 'node:fs';
      const {computeDistBuildIdentity: fresh, distBuildIdentity: captured} = await import(pathToFileURL(${JSON.stringify(modulePath)}));
      ${body}`;
    // windows-hide-exempt: a short-lived pure filesystem regression; no daemon
    // lifecycle command, port, installed application or real configuration.
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    }));
  }

  it('hashes hoisted shared/hooks without executing them and retains the startup snapshot', () => {
    const { bridge, shared, hooks } = installedLayout();
    const result = run(bridge, `
      const initial = captured();
      writeFileSync(${JSON.stringify(join(shared, 'index.js'))}, 'export const shared = 2;');
      const sharedChanged = fresh();
      writeFileSync(${JSON.stringify(join(hooks, 'index.js'))}, 'export const hooks = 3;');
      console.log(JSON.stringify({initial, sharedChanged, hooksChanged: fresh(), captured: captured()}));`);
    expect(result.initial.trees).toHaveLength(3);
    expect(result.initial.trees.every((path: string) => /(?:bridge|shared|hooks)[/\\]dist$/.test(path))).toBe(true);
    expect(result.sharedChanged.id).not.toBe(result.initial.id);
    expect(result.hooksChanged.id).not.toBe(result.sharedChanged.id);
    expect(result.captured.id).toBe(result.initial.id);
  });

  it('hashes the resolved nested dependency rather than an unused hoisted copy', () => {
    const { bridge, shared } = installedLayout();
    const nested = packageAt(join(bridge, '..', 'node_modules', '@agentdeck'), 'shared', 'export const shared = 4;');
    const result = run(bridge, `
      const initial = fresh();
      writeFileSync(${JSON.stringify(join(shared, 'index.js'))}, 'export const unused = 5;');
      const unrelatedChange = fresh();
      writeFileSync(${JSON.stringify(join(nested, 'index.js'))}, 'export const shared = 6;');
      console.log(JSON.stringify({initial, unrelatedChange, nestedChanged: fresh()}));`);
    expect(result.initial.trees).toHaveLength(3);
    expect(result.unrelatedChange.id).toBe(result.initial.id);
    expect(result.nestedChanged.id).not.toBe(result.initial.id);
  });

  it('preserves the digest when identical runtime packages move from hoisted to nested layout', () => {
    const { bridge, shared } = installedLayout();
    const hoisted = run(bridge, 'console.log(JSON.stringify(fresh()));');
    packageAt(join(bridge, '..', 'node_modules', '@agentdeck'), 'shared', readFileSync(join(shared, 'index.js'), 'utf8'));
    const nested = run(bridge, 'console.log(JSON.stringify(fresh()));');
    expect(nested.trees).not.toEqual(hoisted.trees);
    expect(nested.files).toBe(hoisted.files);
    expect(nested.bytes).toBe(hoisted.bytes);
    expect(nested.id).toBe(hoisted.id);
  });

  it('matches the source checkout digest for byte-equivalent installed package dist trees', () => {
    const source = resolve(__dirname, '../../..');
    const scope = join(root, 'equivalent', 'node_modules', '@agentdeck');
    for (const name of ['shared', 'hooks', 'bridge']) {
      const pkg = join(scope, name);
      mkdirSync(pkg, { recursive: true });
      cpSync(join(source, name, 'dist'), join(pkg, 'dist'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), readFileSync(join(source, name, 'package.json')));
    }
    const installed = run(join(scope, 'bridge', 'dist'), 'console.log(JSON.stringify(fresh()));');
    const workspace = computeDistBuildIdentity();
    expect(installed.trees).toHaveLength(3);
    expect(installed.files).toBe(workspace.files);
    expect(installed.bytes).toBe(workspace.bytes);
    expect(installed.id).toBe(workspace.id);
  });
});

describe('buildPackages', () => {
  it('does nothing when nothing is stale', () => {
    expect(buildPackages(root, [])).toEqual({ ok: true });
  });

  it('reports a missing package manager as a reason, not as a failed build', () => {
    // "pnpm is not installed" and "your code does not compile" call for
    // different actions, and a bare ok:false would collapse them.
    const result = buildPackages(root, ['bridge'], join(root, 'no-such-pnpm'));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not on PATH/);
  });
});
