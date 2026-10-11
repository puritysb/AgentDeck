import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  codexHookFingerprint,
  codexThreadIdFromPayload,
  fnv1a32Utf16,
  isCodexHookPayload,
  routeHookHarness,
} from '../hook-harness.js';

interface Vector {
  name: string;
  event: string;
  payload: Record<string, unknown>;
  route: 'as-posted' | 'codex' | 'drop';
  routedEvent?: string;
  fingerprint?: string;
}

const ROOT = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../hook-harness-vectors.json', import.meta.url)), 'utf8',
)) as {
  vectors: Vector[];
  noFingerprint: Array<{ name: string; event: string; payload: Record<string, unknown> }>;
  hashVectors: Array<{ text: string; hash: string }>;
  distinctInstances: Array<{ name: string; event: string; a: Record<string, unknown>; b: Record<string, unknown> }>;
};

describe('routeHookHarness (shared vectors)', () => {
  for (const v of ROOT.vectors) {
    it(v.name, () => {
      const route = routeHookHarness(v.event, v.payload);
      expect(route.kind).toBe(v.route);
      if (route.kind === 'codex') expect(route.event).toBe(v.routedEvent);
      const ingestedAs = route.kind === 'codex' ? route.event : v.event;
      if (v.fingerprint !== undefined) {
        expect(codexHookFingerprint(ingestedAs, v.payload)).toBe(v.fingerprint);
      }
    });
  }
  for (const v of ROOT.distinctInstances) {
    it(v.name, () => {
      const a = codexHookFingerprint(v.event, v.a);
      expect(a).toBeDefined();
      expect(codexHookFingerprint(v.event, v.b)).not.toBe(a);
    });
  }
  it('hashes text as FNV-1a over UTF-16 units (pinned for the Swift mirror)', () => {
    for (const h of ROOT.hashVectors) expect(fnv1a32Utf16(h.text)).toBe(h.hash);
  });
  for (const v of ROOT.noFingerprint) {
    it(v.name, () => {
      expect(codexHookFingerprint(v.event, v.payload)).toBeUndefined();
    });
  }
});

describe('Codex identity evidence', () => {
  it('reads every thread-id key Codex builds have used and strips a codex: prefix', () => {
    expect(codexThreadIdFromPayload({ 'thread-id': 'abc' })).toBe('abc');
    expect(codexThreadIdFromPayload({ thread_id: 'codex:abc' })).toBe('abc');
    expect(codexThreadIdFromPayload({ threadId: 'abc' })).toBe('abc');
    expect(codexThreadIdFromPayload({ 'codex.thread_id': 'abc' })).toBe('abc');
    expect(codexThreadIdFromPayload({ 'thread.id': 'abc' })).toBe('abc');
    expect(codexThreadIdFromPayload({ session_id: 'abc' })).toBeUndefined();
  });

  it('never treats the model or provider as harness evidence', () => {
    expect(isCodexHookPayload({ session_id: 's', model: 'gpt-6-astra', model_provider: 'openai' })).toBe(false);
  });

  it('accepts a Windows rollout path', () => {
    expect(isCodexHookPayload({
      transcript_path: 'C:\\Users\\u\\.codex\\sessions\\2026\\10\\11\\rollout-2026-10-11T10-25-44-01a12890-d8be-74b2-b19b-05218da072ae.jsonl',
    })).toBe(true);
  });
});
