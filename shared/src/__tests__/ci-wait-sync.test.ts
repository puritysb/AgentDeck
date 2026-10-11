import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as rules from '../ci-wait.js';
import sharp from 'sharp';
import projection from '../../ci-wait-projection-vectors.json';
import { createHash } from 'node:crypto';
import { CI_GITHUB_GLYPH, CI_GITHUB_GLYPH_SOURCE_SHA256 } from '../ci-github-glyph.generated.js';
import { emitSwift, OUTPUT, emitKotlin, KOTLIN_OUTPUT, emitCpp, CPP_OUTPUT, emitHermesRules, HERMES_OUTPUT } from '../../../scripts/generate-ci-wait.mjs';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const arduinoJson = join(root, 'esp32/.pio/libdeps/box_86/ArduinoJson/src');

describe('Node/Swift CI wait command parity', () => {
  it('clears inactive pending phase evidence while preserving terminal verdicts', () => {
    for (const vector of projection) expect(rules.ciWaitPhaseId(vector.wait as never)).toBe(vector.expected);
  });
  it.skipIf(process.platform === 'win32' || !existsSync(join(arduinoJson, 'ArduinoJson.h')))(
    'executes full-JSON firmware projection against the same compact evidence vectors', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentdeck-ci-json-parity-'));
      try {
        const source = join(dir, 'projection.cpp');
        writeFileSync(source, `#include <ArduinoJson.h>
#include "esp32/src/state/ci_wait_generated.h"
#include <fstream>
#include <cassert>
int main(int argc, char** argv) {
    std::ifstream input(argv[1]); JsonDocument vectors;
    assert(!deserializeJson(vectors, input));
    for (auto vector : vectors.as<JsonArray>()) {
        assert(CiWaitVisual::fromJsonWait(vector["wait"]) == vector["expected"].as<unsigned>());
    }
}
`);
        execFileSync('c++', ['-std=c++17', '-iquote', root, '-I', arduinoJson, source, '-o', join(dir, 'projection')], { timeout: 60_000 });
        execFileSync(join(dir, 'projection'), [join(root, 'shared/ci-wait-projection-vectors.json')], { timeout: 10_000 });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 75_000,
  );
  it('derives the CI helper from the official GitHub SVG and preserves its transparent face', async () => {
    const svg = readFileSync(join(root, 'design/brand/github.svg'));
    expect(createHash('sha256').update(svg).digest('hex')).toBe(CI_GITHUB_GLYPH_SOURCE_SHA256);
    const { data, info } = await sharp(svg, { density: 384 })
      .resize(8, 8, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rows = Array.from({ length: 8 }, (_, y) => {
      let bits = 0;
      for (let x = 0; x < 8; x++) if (data[(y * 8 + x) * info.channels + info.channels - 1] >= 128) bits |= 0x80 >> x;
      return bits;
    });
    expect(CI_GITHUB_GLYPH).toEqual(rows);
    expect(rows[3] & 0x18).toBe(0); // Actual upstream Invertocat face cutout.
    expect(rows[3] & 0xc3).toBe(0xc3);
    expect(rows[7] & 1).toBe(0); // The separate phase dot cannot cover the logo.
    expect(Object.values(rules.CI_WAIT_VISUAL).filter((v) => typeof v === 'number')).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('keeps the native classifier generated from the common grammar and bounds', () => {
    expect(readFileSync(join(root, OUTPUT), 'utf8')).toBe(emitSwift(rules));
    expect(readFileSync(join(root, KOTLIN_OUTPUT), 'utf8')).toBe(emitKotlin(rules));
    expect(readFileSync(join(root, CPP_OUTPUT), 'utf8')).toBe(emitCpp(rules));
    expect(readFileSync(join(root, HERMES_OUTPUT), 'utf8')).toBe(emitHermesRules(rules));
  });
  it.skipIf(process.platform !== 'darwin')('executes every common command vector in Swift', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-ci-wait-parity-'));
    try {
      const main = join(dir, 'main.swift');
      writeFileSync(main, `import Foundation
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let vectors = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
for (index, vector) in vectors.enumerated() {
    let result = CiWaitRules.classify(command: vector["command"], runInBackground: vector["background"])
    if let expected = vector["expected"] as? [String: Any] {
        guard let result else { fatalError("Missing intent at vector \\(index)") }
        let actual = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as! [String: Any]
        precondition(NSDictionary(dictionary: actual).isEqual(to: expected), "Wrong intent at vector \\(index)")
    } else { precondition(result == nil, "Invented intent at vector \\(index)") }
 }
@globalActor actor DaemonActor { static let shared = DaemonActor() }
@DaemonActor func verifyLifecycle() throws {
let lifecycleData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
let scenarios = try JSONSerialization.jsonObject(with: lifecycleData) as! [[String: Any]]
for scenario in scenarios {
    let tracker = CiWaitTracker()
    for step in scenario["steps"] as! [[String: Any]] {
        let now = step["at"] as! Int
        tracker.note("session", event: step["event"] as! String, json: step["payload"] as! [String: Any], now: now)
        let actual = tracker.snapshot("session", now: now)
        if let expected = step["expected"] as? [String: Any] {
            precondition(NSDictionary(dictionary: actual ?? [:]).isEqual(to: expected), "Lifecycle mismatch")
        } else { precondition(actual == nil, "Wait was not cleared") }
    }
}
}
try await verifyLifecycle()
// The native timeline store runs without starting persistence or a daemon.
// Dependencies outside this replay fail loudly if unexpectedly reached.
enum AuthManager { static var agentDeckDir: URL { fatalError("Unexpected auth directory access") } }
enum ObservedAgentRules { static func rawSessionId(_ value: String) -> String { value.replacingOccurrences(of: "^observed:[a-z-]+:", with: "", options: .regularExpression) } }
let timelineData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[4]))
let timelineVectors = try JSONSerialization.jsonObject(with: timelineData) as! [[String: Any]]
for vector in timelineVectors {
    let store = DaemonTimelineStore(persistFile: URL(fileURLWithPath: "/unused-ci-parity.json"))
    let before = try JSONSerialization.data(withJSONObject: vector["before"]!)
    let incoming = try JSONSerialization.data(withJSONObject: vector["incoming"]!)
    let firstAccepted = await store.add(try JSONDecoder().decode(DaemonTimelineEntry.self, from: before))
    let incomingAccepted = await store.add(try JSONDecoder().decode(DaemonTimelineEntry.self, from: incoming))
    precondition(firstAccepted)
    precondition(incomingAccepted == (vector["action"] as! String == "add"), "Rejected duplicate must not broadcast")
    let actual = await store.getAll()
    precondition(actual.count == (vector["action"] as! String == "add" ? 2 : 1), "Scheduled CI dedup mismatch")
}
let accountingData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3]))
let accounting = try JSONSerialization.jsonObject(with: accountingData) as! [[String: Any]]
for vector in accounting {
    let actual = CiWaitAccounting.foregroundMs(vector["events"] as! [[String: Any]], turnIndex: vector["turnIndex"] as! Int,
        start: vector["start"] as! Int, end: vector["end"] as! Int)
    precondition(actual == vector["expected"] as! Int, "CI accounting mismatch")
}
let projectionData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[5]))
for vector in try JSONSerialization.jsonObject(with: projectionData) as! [[String: Any]] {
    precondition(CiWaitVisual.compactPhase(vector["wait"] as? [String: Any]) == vector["expected"] as! Int,
        "Full/compact waiting evidence projection mismatch")
}
`);
      execFileSync('swiftc', ['-swift-version', '6', join(root, OUTPUT), join(root, 'apple/AgentDeck/Daemon/Timeline/DaemonTimelineStore.swift'), main, '-o', join(dir, 'parity')], { timeout: 60_000 });
      execFileSync(join(dir, 'parity'), [join(root, 'shared/ci-wait-vectors.json'), join(root, 'shared/ci-wait-lifecycle-vectors.json'), join(root, 'shared/ci-wait-accounting-vectors.json'), join(root, 'shared/timeline-ci-dedup-vectors.json'), join(root, 'shared/ci-wait-projection-vectors.json')], { timeout: 10_000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 75_000);
});
