/**
 * The provider axis, and the gate that keeps its Swift/Kotlin mirrors honest.
 *
 * Why this axis exists at all: a `claude-glm` session is Claude Code — same
 * binary, same hook set, same transcript format — with `ANTHROPIC_BASE_URL`
 * pointed at z.ai. Measured on a live daemon (2026-08-17) it already arrives on
 * the wire correctly identified as `agentType: 'claude-code'` /
 * `modelName: 'glm-5.3'`. Nothing was wrong with the data; what was missing was
 * the fact a reader wants, which neither field states on its own: *this Claude
 * is not talking to Anthropic*.
 *
 * Minting a `claude-glm` **agentType** instead would have been wrong twice: it
 * conflates the harness with the endpoint, and every surface's agent handling
 * is an allow-list, so a value no client predates renders as nothing at all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  MODEL_PROVIDER_LABELS,
  harnessNativeProvider,
  modelProvider,
  offHarnessProvider,
  offHarnessProviderLabel,
} from '../model-provider.js';
import { OUTPUTS, loadRules } from '../../../scripts/generate-model-provider.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('modelProvider', () => {
  it('names the provider behind every id shape the wire actually carries', () => {
    // Bare — what the passive observer reads out of a Claude transcript.
    expect(modelProvider('glm-5.3')).toBe('zai');
    expect(modelProvider('claude-opus-5')).toBe('anthropic');
    // Vendored — OpenCode's `providerID/modelID`.
    expect(modelProvider('zai/glm-5.2')).toBe('zai');
    expect(modelProvider('anthropic/claude-sonnet-5')).toBe('anthropic');
    // Display-formatted — the Gateway's model catalog and the Codex snapshot.
    expect(modelProvider('GLM-5.2 (1M)')).toBe('zai');
    expect(modelProvider('gpt-5.6-sol high')).toBe('openai');
    expect(modelProvider('Claude Opus 4.6 (Thinking)')).toBe('anthropic');
  });

  it('answers unknown rather than guessing — the polarity is the point', () => {
    // A deny-list bucket would dress each of these as whatever the fallback
    // happened to be, which is a WRONG view rather than a degraded one.
    expect(modelProvider('some-2027-model')).toBe('unknown');
    expect(modelProvider('')).toBe('unknown');
    expect(modelProvider(undefined)).toBe('unknown');
    expect(modelProvider(null)).toBe('unknown');
    // `unknown` must have no label, so a surface that renders the label
    // unconditionally still shows nothing.
    expect(MODEL_PROVIDER_LABELS.unknown).toBe('');
  });
});

describe('offHarnessProvider', () => {
  it('badges the real case: Claude Code answering from z.ai', () => {
    expect(offHarnessProvider('claude-code', 'glm-5.3')).toBe('zai');
    expect(offHarnessProviderLabel('claude-code', 'glm-5.3')).toBe('z.ai');
  });

  it('says nothing when the harness is where it belongs', () => {
    expect(offHarnessProvider('claude-code', 'claude-opus-5')).toBeNull();
    expect(offHarnessProvider('codex-cli', 'gpt-5.6-sol high')).toBeNull();
    expect(offHarnessProviderLabel('claude-code', 'claude-opus-5')).toBe('');
  });

  it('never turns two unknowns into a claim', () => {
    // Unknown model under a known harness: no information, not redirection.
    expect(offHarnessProvider('claude-code', 'some-2027-model')).toBeNull();
    // Unknown harness: an agent added after this file must not acquire a badge.
    expect(offHarnessProvider('some-2027-agent', 'glm-5.3')).toBeNull();
    expect(offHarnessProvider(undefined, undefined)).toBeNull();
  });

  it('leaves multi-provider harnesses alone', () => {
    // OpenClaw/OpenCode/Antigravity/Kiro have no native provider by design.
    // Badging them would mark every session they run as anomalous.
    for (const agent of ['openclaw', 'opencode', 'antigravity', 'kiro-cli']) {
      expect(harnessNativeProvider(agent)).toBe('unknown');
      expect(offHarnessProvider(agent, 'glm-5.2')).toBeNull();
    }
  });
});

describe('generated mirrors', () => {
  it('are in sync with this source', async () => {
    const rules = await loadRules();
    for (const [rel, emit] of OUTPUTS) {
      const actual = readFileSync(join(repoRoot, rel), 'utf8');
      expect(actual, `${rel} drifted — run \`pnpm generate-model-provider\``).toBe(emit(rules));
    }
  });

  it('carry every provider, so no mirror can silently drop one', async () => {
    const rules = await loadRules();
    for (const [rel, emit] of OUTPUTS) {
      const emitted = emit(rules);
      for (const provider of Object.keys(MODEL_PROVIDER_LABELS)) {
        expect(emitted, `${rel} is missing ${provider}`).toContain(provider);
      }
    }
  });
});
