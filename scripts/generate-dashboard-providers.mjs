// Provider membership vocabulary: daemon policy -> native validators and menu order.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'bridge/src/dashboard-providers.ts'), 'utf8');
const ids = [...source.match(/DASHBOARD_PROVIDER_IDS = \[([^\]]+)\]/s)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
const list = `[${ids.map(id => JSON.stringify(id)).join(', ')}]`;
const targets = [
  // The Swift resolver's vocabulary (DashboardProviders.swift) and the menu
  // order; providerDisplayResponse routes through the resolver, so the old
  // local `let allowed` slot in DaemonServer is gone.
  ['apple/AgentDeck/Daemon/Server/DashboardProviders.swift', /static let providerIds: \[String\] = \[[^\n]+\]/, `static let providerIds: [String] = ${list}`],
  ['apple/AgentDeck/UI/Monitor/TopologyRail.swift', /private let providerOrder = \[[^\n]+\]/, `private let providerOrder = ${list}`],
];
let drift = false;
for (const [relative, pattern, replacement] of targets) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, 'utf8');
  if (!pattern.test(before)) throw Error(`Missing generated slot: ${relative}`);
  const after = before.replace(pattern, replacement);
  if (after !== before) {
    if (process.argv.includes('--check')) { console.error(`Provider vocabulary drift: ${relative}`); drift = true; }
    else fs.writeFileSync(file, after);
  }
}
// Menu labels are presentation, but each native menu must cover the complete vocabulary.
for (const relative of ['apple/AgentDeck/UI/Monitor/TopologyRail.swift', 'android/app/src/main/kotlin/dev/agentdeck/ui/monitor/TopologyRail.kt']) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const names = source.split('\n').find(line => line.includes('providerNames ='));
  for (const id of ids) if (!names.includes(JSON.stringify(id))) throw Error(`Missing provider label ${id}: ${relative}`);
}
process.exitCode = drift ? 1 : 0;
