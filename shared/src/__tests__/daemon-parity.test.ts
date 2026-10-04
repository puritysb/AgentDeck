import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as rules from '../daemon-parity.js';
import { emitSwift, OUTPUT } from '../../../scripts/generate-daemon-parity.mjs';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const vectors = JSON.parse(readFileSync(join(root, 'shared/daemon-parity-vectors.json'), 'utf8'));

describe('Node/Swift daemon policies', () => {
  it('keeps the native policy generated from the canonical source', () => {
    expect(readFileSync(join(root, OUTPUT), 'utf8')).toBe(emitSwift(rules));
    expect(rules.DAEMON_TAKEOVER_YIELD_MS).toBe(vectors.takeoverYieldMs);
  });
  for (const vector of vectors.turns) {
    it(vector.name, () => {
      let state: 'processing' | 'idle' = 'idle';
      for (const event of vector.events) state = rules.kiroTurnState(state, event);
      expect(state).toBe(vector.expected);
    });
  }
  it('shares legacy tool-turn and runtime acceptance decisions', () => {
    for (const vector of vectors.legacy) {
      expect(rules.kiroLegacyTurnState('idle', vector.event, vector.hasToolUse)).toBe(vector.expected);
    }
    for (const vector of vectors.runtimes) {
      expect(rules.acceptsDaemonRuntime(vector.isSwift, vector.expectingNode)).toBe(vector.expected);
    }
  });
  it.skipIf(process.platform !== 'darwin')('executes the same vectors through generated Swift', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-parity-'));
    try {
      const main = join(dir, 'main.swift');
      writeFileSync(main, `import Foundation
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let vectors = try JSONSerialization.jsonObject(with: data) as! [String: Any]
for vector in vectors["legacy"] as! [[String: Any]] {
    precondition(DaemonParityRules.kiroLegacyTurnState("idle", event: vector["event"] as! String,
        hasToolUse: vector["hasToolUse"] as! Bool) == vector["expected"] as! String)
}
for vector in vectors["runtimes"] as! [[String: Any]] {
    precondition(DaemonParityRules.acceptsDaemonRuntime(isSwift: vector["isSwift"] as? Bool,
        expectingNode: vector["expectingNode"] as! Bool) == vector["expected"] as! Bool)
}
precondition(DaemonParityRules.takeoverYieldMs == vectors["takeoverYieldMs"] as! Int)
for vector in vectors["turns"] as! [[String: Any]] {
    var state = "idle"
    for event in vector["events"] as! [String] {
        state = DaemonParityRules.kiroTurnState(state, event: event)
    }
    precondition(state == vector["expected"] as! String)
}
`);
      execFileSync('swiftc', [join(root, OUTPUT), main, '-o', join(dir, 'parity')], { timeout: 60_000 });
      execFileSync(join(dir, 'parity'), [join(root, 'shared/daemon-parity-vectors.json')], { timeout: 10_000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 75_000);
});
