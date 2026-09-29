#!/usr/bin/env node
// Shared user-action classification; reachability alone is never approval evidence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(fs.readFileSync(path.join(root, 'shared/gateway-setup-status.json'), 'utf8'));
const quote = JSON.stringify;
const swift = `// BEGIN GENERATED GATEWAY SETUP STATUS
// Source: shared/gateway-setup-status.json; regenerate: node scripts/generate-gateway-setup-status.mjs
// Drift gate: scripts/__tests__/gateway-setup-status.test.ts
enum GatewaySetupStatus {
    static func evaluate(authStatus: String?, connected: Bool?, available: Bool?) -> IntegrationStatus {
        switch authStatus {
${Object.entries(rules).map(([key,[kind,detail]]) => `        case ${quote(key)}: return .${kind}(detail: ${quote(detail)})`).join('\n')}
        default:
            if connected == true { return .connected(detail: "Paired through Gateway") }
            if available == true { return .awaitingData(detail: "Gateway reachable; connection status unavailable.") }
            return .notConfigured(detail: "No OpenClaw Gateway connection.")
        }
    }
}
// END GENERATED GATEWAY SETUP STATUS`;
const kotlin = `// GENERATED from shared/gateway-setup-status.json; DO NOT EDIT.
// Regenerate: node scripts/generate-gateway-setup-status.mjs
package dev.agentdeck.net

data class GatewaySetupStatus(val kind: String, val detail: String) {
    val needsAttention: Boolean get() = kind in setOf("awaiting", "failed", "unsupported")
    companion object {
        fun evaluate(authStatus: String?, connected: Boolean?, available: Boolean?): GatewaySetupStatus = when (authStatus) {
${Object.entries(rules).map(([key,[kind,detail]]) => `            ${quote(key)} -> GatewaySetupStatus(${quote(kind)}, ${quote(detail)})`).join('\n')}
            else -> when {
                connected == true -> GatewaySetupStatus("connected", "Paired through Gateway")
                available == true -> GatewaySetupStatus("awaitingData", "Gateway reachable; connection status unavailable.")
                else -> GatewaySetupStatus("notConfigured", "No OpenClaw Gateway connection.")
            }
        }
    }
}
`;
const swiftFile = 'apple/AgentDeck/UI/Settings/IntegrationsView.swift';
const current = fs.readFileSync(path.join(root, swiftFile), 'utf8');
const updated = current.replace(/\/\/ BEGIN GENERATED GATEWAY SETUP STATUS[\s\S]*?\/\/ END GENERATED GATEWAY SETUP STATUS/, swift);
if (updated === current && !current.includes(swift)) throw new Error('Missing Swift generation markers');
for (const [file, text] of [[swiftFile, updated], ['android/app/src/main/kotlin/dev/agentdeck/net/GatewaySetupStatus.kt', kotlin]]) {
    if (process.argv.includes('--check')) {
        if (!fs.existsSync(path.join(root,file)) || fs.readFileSync(path.join(root,file),'utf8') !== text) throw new Error(`Generated Gateway setup status drift: ${file}`);
    } else fs.writeFileSync(path.join(root,file), text);
}
