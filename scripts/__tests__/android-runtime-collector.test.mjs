// Native Gradle acceptance, run by the Android audit job rather than Vitest.
// All dependency bytes are synthetic and resolve from a temporary local Maven
// repository with --offline; no application or downloaded dependency executes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'android-inventory-'));
const logs = join(root, 'diagnostics/android-audit/collector-regressions');
mkdirSync(logs, { recursive: true }); mkdirSync(join(directory, 'app'));
after(() => rmSync(directory, { recursive: true, force: true }));
writeFileSync(join(directory, 'settings.gradle'), "rootProject.name = 'inventory-fixture'\ninclude ':app'\n");
const emptyJar = Buffer.from('504b05060000000000000000000000000000000000000000', 'hex');
for (const name of ['ok', 'second', 'broken']) {
  const path = join(directory, 'repo/test/example', name, '1.0'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `${name}-1.0.jar`), emptyJar);
  const dependencies = name === 'broken' ? '<dependencies><dependency><groupId>test.example</groupId><artifactId>missing</artifactId><version>1.0</version></dependency></dependencies>' : '';
  writeFileSync(join(path, `${name}-1.0.pom`), `<project><modelVersion>4.0.0</modelVersion><groupId>test.example</groupId><artifactId>${name}</artifactId><version>1.0</version>${dependencies}</project>`);
}
writeFileSync(join(directory, 'local.jar'), emptyJar);
const common = "repositories { maven { url = uri('../repo') } }\nconfigurations { debugRuntimeClasspath { canBeResolved = true }; releaseRuntimeClasspath { canBeResolved = true } }\n";

function collect(name, dependencies) {
  writeFileSync(join(directory, 'app/build.gradle'), `${common}dependencies { ${dependencies} }\n`);
  const output = join(directory, `${name}.json`);
  const result = spawnSync(join(root, 'android/gradlew'), ['--no-daemon', '--offline', '--console=plain', '--quiet',
    '-p', directory, '-I', join(root, 'scripts/android-runtime-inventory.gradle'),
    `-PagentdeckInventoryOutput=${output}`, ':app:agentdeckRuntimeInventory'],
  { cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024 });
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(join(logs, `${name}.log`), log);
  assert.ifError(result.error);
  return { result, log, output };
}

test('Gradle collector resolves both actual runtime configurations', () => {
  const { result, log, output } = collect('resolved', "debugRuntimeClasspath 'test.example:ok:1.0'; releaseRuntimeClasspath 'test.example:second:1.0'");
  assert.equal(result.status, 0, log);
  const inventory = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(inventory.configurations.debugRuntimeClasspath, [{ group: 'test.example', name: 'ok', version: '1.0' }]);
  assert.deepEqual(inventory.configurations.releaseRuntimeClasspath, [{ group: 'test.example', name: 'second', version: '1.0' }]);
});

test('Gradle collector fails on an unresolved transitive/runtime graph', () => {
  const { result, log } = collect('unresolved', "debugRuntimeClasspath 'test.example:ok:1.0'; releaseRuntimeClasspath 'test.example:broken:1.0'");
  assert.notEqual(result.status, 0); assert.match(log, /Unresolved runtime dependencies/);
});

test('Gradle collector refuses opaque local artifacts instead of omitting them', () => {
  const { result, log } = collect('opaque', "debugRuntimeClasspath 'test.example:ok:1.0'; releaseRuntimeClasspath 'test.example:second:1.0'; releaseRuntimeClasspath files('../local.jar')");
  assert.notEqual(result.status, 0); assert.match(log, /Unmapped runtime artifact/);
});
