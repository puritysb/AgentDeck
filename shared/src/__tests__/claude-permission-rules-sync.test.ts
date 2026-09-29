// Drift gate for the generated Claude permission predictor mirror
// (shared/src/claude-permission-rules.ts → Swift). A hand edit to the
// generated file, or a skipped `pnpm generate-claude-permission-rules`,
// fails here in CI — the apme-display-rules sync-test pattern.
//
// The BEHAVIOR of the mirror stays pinned by shared/claude-permission-vectors.json,
// which both suites replay — a byte-identical mirror emitted from wrong rules
// goes red there, not here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rulesMod from '../claude-permission-rules.js';
import { OUTPUTS, rulesFrom } from '../../../scripts/generate-claude-permission-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(rulesMod);

describe('generated Claude permission-rules mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(emit(rules));
    });
  }

  it('emitter embeds the SSOT constants', () => {
    const swift = OUTPUTS[0][1](rules);
    expect(swift).toContain(`static let gateLearnWindowMs: Int = ${rulesMod.GATE_LEARN_WINDOW_MS}`);
    for (const name of [
      ...rulesMod.NEVER_PROMPT_TOOLS, ...rulesMod.PROMPT_PRONE_TOOLS,
      ...rulesMod.READ_ONLY_BASH_COMMANDS, ...rulesMod.ACCEPT_EDITS_FS_COMMANDS,
      ...rulesMod.READ_ONLY_GIT_SUBCOMMANDS,
    ]) {
      expect(swift).toContain(JSON.stringify(name));
    }
  });

  it('the Swift suite replays the shared vector file (grep the test wiring)', () => {
    const swiftTest = readFileSync(
      `${repoRoot}apple/AgentDeckTests/ClaudePermissionRulesTests.swift`, 'utf8');
    expect(swiftTest).toContain('shared/claude-permission-vectors.json');
  });

  it('no daemon keeps a private copy of the Bash rule matcher', () => {
    // The whole point of the generator: the two hand copies drifted into the
    // same defect (legacy `:*` only). A `hasSuffix(":*")` outside the
    // generated file is a copy coming back.
    for (const rel of [
      'apple/AgentDeck/Daemon/Session/ObservedSteering.swift',
      'apple/AgentDeck/Daemon/Server/DaemonServer.swift',
      'bridge/src/claude-permission-rules.ts',
      'bridge/src/observed-steering.ts',
      'bridge/src/awaiting-overlay.ts',
    ]) {
      const src = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(src, `${rel} re-implements the Bash spec matcher`).not.toMatch(/hasSuffix\(":\*"\)|endsWith\(':\*'\)/);
    }
  });
});
