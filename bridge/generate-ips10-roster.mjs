// Generate the pure Swift selection kernel; transport shaping stays platform-owned.
import fs from 'node:fs';
import crypto from 'node:crypto';
const origin = new URL('./src/ips10-roster.ts', import.meta.url);
const source = fs.readFileSync(origin, 'utf8');
const number = name => Number(source.match(new RegExp(`${name} = ([\\d_]+)`))[1].replaceAll('_',''));
const body = `    // BEGIN GENERATED IPS10 ROSTER — bridge/generate-ips10-roster.mjs
    // Source SHA256: ${crypto.createHash('sha256').update(source).digest('hex')}
    nonisolated static func ips10RosterIndices(total: Int, attention: Int, cap: Int, nowMs: Double) -> [Int] {
        guard cap > 0, total > 0 else { return [] }
        if total <= cap { return Array(0..<total) }
        let pinned = min(attention, ${number('IPS10_ATTENTION_SLOTS')}, cap - 1)
        let slots = cap - pinned, remaining = total - pinned
        let phase = Int(max(0, nowMs) / ${number('IPS10_ROSTER_PERIOD_MS')})
        let offset = (phase * slots) % remaining
        return Array(0..<pinned) + (0..<slots).map { pinned + (offset + $0) % remaining }
    }
    // END GENERATED IPS10 ROSTER`;
const target = new URL('../apple/AgentDeck/Daemon/Modules/ESP32Serial.swift', import.meta.url);
const old = fs.readFileSync(target,'utf8');
const pattern = /    \/\/ BEGIN GENERATED IPS10 ROSTER[\s\S]*?    \/\/ END GENERATED IPS10 ROSTER/;
const updated = pattern.test(old) ? old.replace(pattern,body) : old.replace('    /// IPS10 card roster',body+'\n\n    /// IPS10 card roster');
if(process.argv.includes('--check')) { if(old!==updated)throw Error('IPS10 Swift roster kernel drift'); }
else fs.writeFileSync(target,updated);
