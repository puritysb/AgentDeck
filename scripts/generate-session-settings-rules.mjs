#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUTPUT = 'apple/AgentDeck/Daemon/Gateway/SessionSettingsRules.generated.swift';
export function emitSwift(rules) {
  const fields = Object.entries(rules).map(([key, value]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid session settings policy: ${key}`);
    }
    return `    static let ${key} = ${value}`;
  }).join('\n');
  return `// GENERATED — DO NOT EDIT. Source: shared/src/session-settings.ts
// Regenerate: pnpm generate-session-settings-rules; drift gate: session-settings.test.ts
import Foundation

enum SessionSettingsRules {
${fields}
}
`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { SESSION_SETTINGS_RULES } = await import('../shared/dist/session-settings.js');
  const target = fileURLToPath(new URL('../' + OUTPUT, import.meta.url));
  const next = emitSwift(SESSION_SETTINGS_RULES);
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== next) throw new Error('Session settings policy mirror drifted');
  } else fs.writeFileSync(target, next);
}
