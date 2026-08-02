#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { areVersionsCompatible, compatibilityLine, parseNumericVersion } from './version-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const productVersion = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
const failures = [];

if (!parseNumericVersion(productVersion)) {
  failures.push(`VERSION: expected numeric X.Y.Z SemVer, found ${productVersion || '<empty>'}`);
}

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function expectValue(path, actual, expected) {
  if (actual !== expected) failures.push(`${path}: expected ${expected}, found ${actual ?? '<missing>'}`);
}

const productCompatibilityLine = compatibilityLine(productVersion) ?? '<invalid>';

function expectCompatible(path, actual) {
  if (!parseNumericVersion(actual)) {
    failures.push(`${path}: expected numeric X.Y.Z SemVer, found ${actual ?? '<missing>'}`);
    return;
  }
  if (!areVersionsCompatible(productVersion, actual)) {
    failures.push(`${path}: expected compatibility line ${productCompatibilityLine}.x, found ${actual}`);
  }
}

function jsonVersion(path, key = 'version') {
  return JSON.parse(read(path))[key];
}

expectValue('package.json', jsonVersion('package.json'), productVersion);

// Major.minor is the cross-target compatibility contract. Patch versions are
// delivery counters and may lag on targets that were not part of a hotfix.
// Packages that ship together inside one target must still agree exactly.
const npmVersion = jsonVersion('bridge/package.json');
expectCompatible('bridge/package.json', npmVersion);
for (const path of ['hooks/package.json', 'shared/package.json', 'setup/package.json']) {
  expectValue(path, jsonVersion(path), npmVersion);
}

const streamDeckVersion = jsonVersion('plugin/package.json');
expectCompatible('plugin/package.json', streamDeckVersion);
const ulanziVersion = jsonVersion('plugin-ulanzi/package.json');
expectCompatible('plugin-ulanzi/package.json', ulanziVersion);

for (const path of ['hooks/package.json', 'shared/package.json', 'bridge/package.json', 'setup/package.json']) {
  const manifest = JSON.parse(read(path));
  if (manifest.private === true) failures.push(`${path}: required public npm package must not be private`);
}

const bridgeManifest = JSON.parse(read('bridge/package.json'));
for (const dependency of ['@agentdeck/hooks', '@agentdeck/shared']) {
  if (bridgeManifest.dependencies?.[dependency] !== 'workspace:*') {
    failures.push(`bridge/package.json: ${dependency} must remain a workspace runtime dependency`);
  }
}

expectValue(
  'plugin-ulanzi/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/manifest.json',
  jsonVersion('plugin-ulanzi/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/manifest.json', 'Version'),
  ulanziVersion,
);
const streamDeckManifestPath = 'plugin/bound.serendipity.agentdeck.sdPlugin/manifest.json';
const streamDeckManifest = JSON.parse(read(streamDeckManifestPath));
expectValue(streamDeckManifestPath, streamDeckManifest.Version, `${streamDeckVersion}.0`);
for (const [name, deviceType] of [
  ['agentdeck-sd', 0],
  ['agentdeck-sdmini', 1],
  ['agentdeck-sdplus', 7],
  ['agentdeck-sdxl', 2],
  ['agentdeck-sdplusxl', 13],
]) {
  const profile = streamDeckManifest.Profiles?.find((candidate) => candidate.Name === name);
  expectValue(`${streamDeckManifestPath} profile ${name}`, profile?.DeviceType, deviceType);
}

const appleVersion = read('apple/project.yml').match(/MARKETING_VERSION:\s*"([^"]+)"/)?.[1];
const androidVersion = read('android/app/build.gradle.kts').match(/versionName\s*=\s*"([^"]+)"/)?.[1];
const esp32Version = read('esp32/src/config.h').match(/FIRMWARE_VERSION\s*=\s*"([^"]+)"/)?.[1];
const daemonVersion = read('bridge/src/daemon.ts').match(/\.version\('([^']+)'\)/)?.[1];
expectCompatible('apple/project.yml', appleVersion);
expectCompatible('android/app/build.gradle.kts', androidVersion);
expectCompatible('esp32/src/config.h', esp32Version);
expectValue('bridge/src/daemon.ts', daemonVersion, npmVersion);

const xcodeVersions = [
  ...read('apple/AgentDeck.xcodeproj/project.pbxproj').matchAll(/MARKETING_VERSION = ([^;]+);/g),
].map((match) => match[1]);
if (xcodeVersions.length === 0 || xcodeVersions.some((version) => version !== appleVersion)) {
  failures.push(`apple/AgentDeck.xcodeproj/project.pbxproj: MARKETING_VERSION mirrors must all be ${appleVersion}`);
}

// Bundled `.streamDeckProfile` files are now generated deterministic ZIP
// archives (scripts/generate-streamdeck-profiles.mjs), so their embedded plugin
// version cannot be regex-scanned from loose directory manifests anymore. That
// generator reads plugin/package.json for the embedded version and its drift
// gate (plugin/src/__tests__/streamdeck-profiles-sync.test.ts) byte-compares
// the committed zips against it — so profile version correctness is enforced
// there. Here we only assert the plugin manifest's Profiles[] DeviceType map
// (above); running the generator's --check keeps the zips honest.

if (failures.length > 0) {
  console.error(`Compatibility/version drift (VERSION=${productVersion}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Compatibility line ${productCompatibilityLine} is synchronized (patch ordering is independent); target patches: ` +
    `npm ${npmVersion}, Apple ${appleVersion}, Android ${androidVersion}, ESP32 ${esp32Version}, ` +
    `Stream Deck ${streamDeckVersion}, Ulanzi ${ulanziVersion}.`,
);
