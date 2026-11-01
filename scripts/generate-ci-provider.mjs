#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
export const OUTPUT = 'apple/AgentDeck/Daemon/Session/GitHubCIPolicy.generated.swift';
export function emitPolicy(policy, lifecycle, rules) {
  return '// GENERATED from shared/src/ci-provider-policy.ts and ci-wait.ts.\n#if os(macOS)\nenum GitHubCIPolicy {\n'
    + Object.entries(policy).map(([k,v]) => `    static let ${k} = ${JSON.stringify(v)}\n`).join('')
    + `    static let maxIdentityChars = ${rules.maxIdentityChars}\n    static let maxId: Double = ${rules.maxId}\n    static let repoPattern = ${JSON.stringify(rules.repoPattern)}\n    static let refPattern = ${JSON.stringify(rules.branchPattern)}\n`
    + `    static let resultAgeMs = ${lifecycle.resultAgeMs}\n}\n#endif\n`;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const { CI_PROVIDER_POLICY } = await import('../shared/dist/ci-provider-policy.js');
 const { CI_WAIT_LIFECYCLE, CI_WAIT_RULES } = await import('../shared/dist/ci-wait.js');
 fs.writeFileSync(OUTPUT, emitPolicy(CI_PROVIDER_POLICY, CI_WAIT_LIFECYCLE, CI_WAIT_RULES));
}
