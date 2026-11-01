import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
export const OUTPUT = 'apple/AgentDeck/Daemon/Relay/DaemonRelayPolicy.generated.swift';
export function emitPolicy(policy) {
 return '// GENERATED from shared/src/daemon-relay-policy.ts.\n#if os(macOS)\nenum DaemonRelayPolicy {\n'
 + Object.entries(policy).map(([key,value]) => `    static let ${key} = ${JSON.stringify(value)}\n`).join('') + '}\n#endif\n';
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const { RELAY_POLICY } = await import('../shared/dist/daemon-relay-policy.js');
 fs.mkdirSync('apple/AgentDeck/Daemon/Relay', { recursive:true });
 fs.writeFileSync(OUTPUT, emitPolicy(RELAY_POLICY));
}
