// Guards the protocol SSOT (shared/src/protocol.ts + shared/src/gateway-protocol.ts).
//
// The committed artifacts under generated/protocol/ — plus the TS builders in
// shared/src/command-builders.ts — are emitted by `pnpm generate-protocol`.
// Nothing forces that regeneration, so an edit to the SSOT that skips it drifts
// silently: CI catches it, but only after the push (this is how 9477cbcd broke
// master, from a comment-only edit in eed3b7be that still changes the emitted
// doc comments).
//
// This is the terrarium-rules gate applied to the protocol: regenerate into a
// temp dir, byte-compare, fail in `pnpm test` instead of in CI. Note that a
// doc-comment edit is a real change here — the comments are carried into the
// Swift/Kotlin mirrors, so "it's only a comment" is not a reason to skip the
// generator.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Committed path → basename inside the regenerated output directory.
const ARTIFACTS: Array<[string, string]> = [
  ['generated/protocol/bridge-event-schema.json', 'bridge-event-schema.json'],
  ['generated/protocol/plugin-command-schema.json', 'plugin-command-schema.json'],
  ['generated/protocol/gateway-frame-schema.json', 'gateway-frame-schema.json'],
  ['generated/protocol/BridgeEvent.swift', 'BridgeEvent.swift'],
  ['generated/protocol/PluginCommand.swift', 'PluginCommand.swift'],
  ['generated/protocol/GatewayFrame.swift', 'GatewayFrame.swift'],
  ['generated/protocol/BridgeEvent.kt', 'BridgeEvent.kt'],
  ['generated/protocol/PluginCommand.kt', 'PluginCommand.kt'],
  ['generated/protocol/GatewayFrame.kt', 'GatewayFrame.kt'],
  ['generated/protocol/AgentCommand.swift', 'AgentCommand.swift'],
  ['generated/protocol/AgentCommand.kt', 'AgentCommand.kt'],
  // Ungated by the CI step, which only diffs generated/protocol/.
  ['shared/src/command-builders.ts', 'command-builders.ts'],
];

describe('generated protocol artifacts in sync', () => {
  let freshDir: string;

  beforeAll(() => {
    freshDir = mkdtempSync(join(tmpdir(), 'agentdeck-protocol-'));
    execFileSync('bash', ['scripts/generate-protocol.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTDECK_PROTOCOL_OUT_DIR: freshDir,
        // On Windows, `bash` may be WSL, which drops custom env vars unless
        // WSLENV names them — and /p translates the path (C:\… → /mnt/c/…).
        // Git Bash ignores WSLENV and receives the variable natively.
        WSLENV: [process.env.WSLENV, 'AGENTDECK_PROTOCOL_OUT_DIR/p']
          .filter(Boolean).join(':'),
      },
      stdio: 'pipe',
    });
    return () => rmSync(freshDir, { recursive: true, force: true });
    // The generator shells out to quicktype/ts-json-schema-generator via npx.
    // Both are devDependencies pinned in the lockfile, so this resolves the
    // local binaries and needs no network.
  }, 180_000);

  for (const [committed, basename] of ARTIFACTS) {
    it(`${committed} matches the SSOT`, () => {
      const onDisk = readFileSync(join(repoRoot, committed), 'utf8');
      const fresh = readFileSync(join(freshDir, basename), 'utf8');
      expect(
        onDisk,
        `${committed} is stale — run 'pnpm generate-protocol' and commit the result.`
      ).toBe(fresh);
    });
  }
});
