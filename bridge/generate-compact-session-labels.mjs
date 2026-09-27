import fs from 'node:fs';
import crypto from 'node:crypto';
const source = fs.readFileSync(new URL('./src/compact-session-labels.ts', import.meta.url), 'utf8');
const cap = Number(source.match(/COMPACT_PROJECT_BYTES = (\d+)/)[1]);
const ttgoCap = Number(source.match(/TTGO_COMPACT_PROJECT_BYTES = (\d+)/)[1]);
const body = `    // BEGIN GENERATED COMPACT SESSION LABELS — bridge/generate-compact-session-labels.mjs
    // Source SHA256: ${crypto.createHash('sha256').update(source).digest('hex')}
    nonisolated static func compactSessionLabels(_ rows: [(id: String, name: String)], board: String? = nil) -> [String: String] {
        let cap = board == "ttgo_t_display" ? ${ttgoCap} : ${cap}
        func compact(_ value: String) -> String {
            var output = "", used = 0
            for scalar in value.unicodeScalars {
                let part = String(scalar), size = String(scalar).utf8.count
                if used + size > cap { break }
                output += part; used += size
            }
            return output
        }
        var groups: [String: [String]] = [:]
        for row in rows {
            let base = compact(row.name.isEmpty ? "Session" : row.name)
            if !(groups[base] ?? []).contains(row.id) { groups[base, default: []].append(row.id) }
        }
        var labels: [String: String] = [:]
        for (base, members) in groups {
            let ids = members.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            for (index, id) in ids.enumerated() {
                labels[id] = ids.count > 1 ? "\\(base) #\\(index + 1)" : base
            }
        }
        return labels
    }
    // END GENERATED COMPACT SESSION LABELS`;
const target = new URL('../apple/AgentDeck/Daemon/Modules/ESP32Serial.swift', import.meta.url);
const old = fs.readFileSync(target, 'utf8');
const pattern = /    \/\/ BEGIN GENERATED COMPACT SESSION LABELS[\s\S]*?    \/\/ END GENERATED COMPACT SESSION LABELS/;
const updated = pattern.test(old) ? old.replace(pattern, body) : old.replace('    // BEGIN GENERATED IPS10 ROSTER', body + '\n\n    // BEGIN GENERATED IPS10 ROSTER');
if (process.argv.includes('--check')) { if (old !== updated) throw Error('Compact session label Swift drift'); }
else fs.writeFileSync(target, updated);
