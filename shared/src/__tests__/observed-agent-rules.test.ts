/**
 * The two observed-agent lists, and the gate that keeps their Swift/Kotlin
 * mirrors from drifting away from this source again.
 *
 * Both drifted the same way and neither failure was visible: Kiro was added to
 * the TypeScript source and to nothing else, so on iOS/macOS and Android a Kiro
 * session's id kept its `observed:kiro:` prefix, matched no timeline rows, and
 * its detail view came up empty — while its per-tool rows, unsuppressed,
 * drowned the prompt and response rows they were meant to sit beside.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  OBSERVED_SESSION_AGENT_KEYS,
  OBSERVED_SESSION_PREFIXES,
  OBSERVED_SESSION_PREFIX_RE,
  rawSessionId,
  sameSession,
} from '../session-utils.js';
import { TOOL_EXEC_SUPPRESSED_AGENTS, isToolExecSuppressedAgent } from '../timeline.js';
import { OUTPUTS } from '../../../scripts/generate-observed-agent-rules.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('observed session ids', () => {
  it('strips every advertised prefix, Kiro included', () => {
    // `observed:kiro:` / `observed:kiro-ide:` are what passive-observer.ts
    // actually emits; a client that cannot strip them shows an empty timeline.
    for (const key of OBSERVED_SESSION_AGENT_KEYS) {
      expect(rawSessionId(`observed:${key}:abc-123`)).toBe('abc-123');
    }
    expect(sameSession('observed:kiro:abc-123', 'abc-123')).toBe(true);
    expect(sameSession('observed:kiro-ide:abc-123', 'abc-123')).toBe(true);
  });

  it('keeps the regex and the list from disagreeing about which agents exist', () => {
    // The regex is built FROM the list, so this is a statement about the
    // construction rather than a second copy of the membership.
    for (const prefix of OBSERVED_SESSION_PREFIXES) {
      expect(OBSERVED_SESSION_PREFIX_RE.test(`${prefix}x`)).toBe(true);
    }
    expect(OBSERVED_SESSION_PREFIX_RE.test('observed:not-an-agent:x')).toBe(false);
    // A bare id is returned unchanged, not mangled.
    expect(rawSessionId('abc-123')).toBe('abc-123');
  });
});

describe('observed tool_exec suppression', () => {
  it('covers every observed agent whose tool rows are a firehose', () => {
    expect(isToolExecSuppressedAgent('kiro-cli')).toBe(true);
    expect(isToolExecSuppressedAgent('kiro-ide')).toBe(true);
    // Claude is deliberately absent: its tool rows are the signal the managed
    // timeline strip is built around.
    expect(isToolExecSuppressedAgent('claude-code')).toBe(false);
    expect(isToolExecSuppressedAgent(undefined)).toBe(false);
    expect(isToolExecSuppressedAgent('some-2027-agent')).toBe(false);
  });
});

describe('generated mirrors', () => {
  it('match this source', () => {
    const rules = {
      prefixes: [...OBSERVED_SESSION_PREFIXES],
      suppressed: [...TOOL_EXEC_SUPPRESSED_AGENTS],
    };
    for (const [rel, emit] of OUTPUTS as Array<[string, (r: unknown) => string]>) {
      const onDisk = readFileSync(join(repoRoot, rel), 'utf8');
      expect(onDisk, `${rel} drifted — run pnpm generate-observed-agent-rules`).toBe(emit(rules));
    }
  });

  it('leaves no hand-written copy of either list behind', () => {
    // The point of generating them is that there is one list. A call site that
    // spells the membership out again is the drift this replaced, so it fails
    // here rather than silently on one platform.
    for (const rel of [
      'apple/AgentDeck/Model/Timeline.swift',
      'android/app/src/main/kotlin/dev/agentdeck/state/TimelineDisplay.kt',
      'apple/AgentDeck/UI/Monitor/TimelineStripView.swift',
    ]) {
      const src = readFileSync(join(repoRoot, rel), 'utf8');
      expect(src, `${rel} still hand-lists observed prefixes`).not.toContain('"observed:codex-app:"');
    }
  });
});
