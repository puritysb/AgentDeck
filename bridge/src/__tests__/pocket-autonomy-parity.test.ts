import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { POCKET_POLICY, POCKET_KINDS, POCKET_CARD_ID_PATTERN } from '@agentdeck/shared';
import * as engine from '../pocket-autonomy.js';
import * as modules from '../card-modules.js';
import { emitPocketPolicy, OUTPUT } from '../../../scripts/generate-pocket-policy.mjs';
import { runPocketVector } from '../../../scripts/pocket-vector-reference.mjs';

const vectors = JSON.parse(fs.readFileSync('shared/pocket-autonomy-vectors.json', 'utf8'));
describe('Pocket native parity', () => {
  it('generates policy without drift and replays Node golden vectors', () => {
    expect(fs.readFileSync(OUTPUT, 'utf8')).toBe(emitPocketPolicy(POCKET_POLICY, POCKET_KINDS, POCKET_CARD_ID_PATTERN));
    for (const testcase of vectors.cases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-node-'));
      try { expect(runPocketVector(testcase, root, { ...engine, ...modules }), testcase.name).toEqual(testcase.expected); }
      finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  });
  it.skipIf(process.platform !== 'darwin')('executes the real Swift engine with identical cards, feedback, state and restart results', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-native-'));
    try {
      const main = path.join(root, 'main.swift'), binary = path.join(root, 'replay');
      fs.writeFileSync(main, `import Foundation
@globalActor actor DaemonActor { static let shared = DaemonActor() }
@main struct Main {
  static func main() async throws {
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    let output = try await replay(bytes)
    FileHandle.standardOutput.write(output)
  }
  @DaemonActor static func replay(_ bytes: Data) throws -> Data {
    let input = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
    var results: [[[String: Any]]] = []
    for testcase in input["cases"] as! [[String: Any]] {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: root) }
      results.append(try PocketVectorReplay.run(testcase, root: root))
    }
    return try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
  }
}
`);
      execFileSync('xcrun', ['swiftc', '-swift-version', '6', '-DPOCKET_STANDALONE', '-parse-as-library',
        'apple/AgentDeck/Daemon/Server/PocketPolicy.generated.swift',
        'apple/AgentDeck/Daemon/Server/PocketAutonomy.swift',
        'apple/AgentDeckTests/PocketVectorReplay.swift', main, '-o', binary], { timeout: 90_000, stdio: 'pipe' });
      const actual = JSON.parse(execFileSync(binary, [], { input: JSON.stringify(vectors), encoding: 'utf8', timeout: 15_000 }));
      vectors.cases.forEach((testcase: { name: string; expected: unknown }, i: number) => {
        expect(actual[i], testcase.name).toEqual(testcase.expected);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});
