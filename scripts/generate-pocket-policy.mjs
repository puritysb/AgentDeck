#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
export const OUTPUT = 'apple/AgentDeck/Daemon/Server/PocketPolicy.generated.swift';
export function emitPocketPolicy(policy, kinds, pattern) {
  return '// GENERATED from shared/src/pocket-policy.ts. Do not edit.\n#if os(macOS)\nenum PocketPolicy {\n'
    + Object.entries(policy).map(([key, value]) => `    static let ${key}: Double = ${value}\n`).join('')
    + `    static let kinds: [String] = ${JSON.stringify(kinds)}\n`
    + `    static let cardIDPattern = ${JSON.stringify(pattern)}\n`
    + '}\n#endif\n';
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { POCKET_POLICY, POCKET_KINDS, POCKET_CARD_ID_PATTERN } = await import('../shared/dist/pocket-policy.js');
  fs.writeFileSync(OUTPUT, emitPocketPolicy(POCKET_POLICY, POCKET_KINDS, POCKET_CARD_ID_PATTERN));
}
