#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const productVersion = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
const failures = [];

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function expectValue(path, actual, expected) {
  if (actual !== expected) failures.push(`${path}: expected ${expected}, found ${actual ?? '<missing>'}`);
}

function jsonVersion(path, key = 'version') {
  return JSON.parse(read(path))[key];
}

for (const path of [
  'package.json',
  'shared/package.json',
  'bridge/package.json',
  'setup/package.json',
  'hooks/package.json',
  'plugin/package.json',
  'plugin-ulanzi/package.json',
]) {
  expectValue(path, jsonVersion(path), productVersion);
}

for (const path of [
  'hooks/package.json',
  'shared/package.json',
  'bridge/package.json',
  'setup/package.json',
]) {
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
  productVersion,
);
const streamDeckManifestPath = 'plugin/bound.serendipity.agentdeck.sdPlugin/manifest.json';
const streamDeckManifest = JSON.parse(read(streamDeckManifestPath));
expectValue(streamDeckManifestPath, streamDeckManifest.Version, `${productVersion}.0`);
for (const [name, deviceType] of [
  ['agentdeck-sd', 0],
  ['agentdeck-sdmini', 1],
  ['agentdeck-sdplus', 7],
]) {
  const profile = streamDeckManifest.Profiles?.find((candidate) => candidate.Name === name);
  expectValue(`${streamDeckManifestPath} profile ${name}`, profile?.DeviceType, deviceType);
}

const textChecks = [
  ['apple/project.yml', /MARKETING_VERSION:\s*"([^"]+)"/, productVersion],
  ['android/app/build.gradle.kts', /versionName\s*=\s*"([^"]+)"/, productVersion],
  ['esp32/src/config.h', /FIRMWARE_VERSION\s*=\s*"([^"]+)"/, productVersion],
  ['bridge/src/daemon.ts', /\.version\('([^']+)'\)/, productVersion],
];
for (const [path, pattern, expected] of textChecks) {
  expectValue(path, read(path).match(pattern)?.[1], expected);
}

const xcodeVersions = [...read('apple/AgentDeck.xcodeproj/project.pbxproj').matchAll(/MARKETING_VERSION = ([^;]+);/g)]
  .map((match) => match[1]);
if (xcodeVersions.length === 0 || xcodeVersions.some((version) => version !== productVersion)) {
  failures.push(`apple/AgentDeck.xcodeproj/project.pbxproj: MARKETING_VERSION mirrors must all be ${productVersion}`);
}

const profilePaths = [
  'plugin/bound.serendipity.agentdeck.sdPlugin/agentdeck-sd.sdProfile/Profiles/7F6C6400-1A9F-4F57-8D58-0F5C6C102A15/manifest.json',
  'plugin/bound.serendipity.agentdeck.sdPlugin/agentdeck-sd.streamDeckProfile/Profiles/7F6C6400-1A9F-4F57-8D58-0F5C6C102A15/manifest.json',
  'plugin/bound.serendipity.agentdeck.sdPlugin/agentdeck-sdmini.sdProfile/Profiles/A63D9B52-2C41-4A8B-9E63-1D5F7C20B601/manifest.json',
  'plugin/bound.serendipity.agentdeck.sdPlugin/agentdeck-sdmini.streamDeckProfile/Profiles/A63D9B52-2C41-4A8B-9E63-1D5F7C20B601/manifest.json',
  'plugin/bound.serendipity.agentdeck.sdPlugin/agentdeck-sdplus.sdProfile/Profiles/D3714493-5D2A-40D9-9DFF-B2423F73685F/manifest.json',
  'plugin/bound.serendipity.agentdeck.sdPlugin/agentdeck-sdplus.streamDeckProfile/Profiles/D3714493-5D2A-40D9-9DFF-B2423F73685F/manifest.json',
];
for (const path of profilePaths) {
  const versions = [...read(path).matchAll(/"Version"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  if (versions.length === 0 || versions.some((version) => version !== `${productVersion}.0`)) {
    failures.push(`${path}: embedded plugin versions must all be ${productVersion}.0`);
  }
}

if (failures.length > 0) {
  console.error(`Product version drift (VERSION=${productVersion}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Product version ${productVersion} is synchronized across all release surfaces.`);
