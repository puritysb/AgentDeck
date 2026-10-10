import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOpenClawConversationKey, nextOpenClawSteeringKey, pickOpenClawSteeringKey } from '../openclaw-session-key.js';

const vectors = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../openclaw-session-key-vectors.json', import.meta.url)), 'utf8',
)) as {
  keys: Array<{ key: string; conversation: boolean }>;
  pick: Array<{ name: string; keys: string[]; expected: string | null }>;
  next: Array<{ name: string; current: string | null; event: string | null; expected: string | null }>;
};

describe('OpenClaw session-key rule (shared vectors)', () => {
  for (const v of vectors.keys) {
    it(`classifies ${v.key || '(empty)'}`, () => expect(isOpenClawConversationKey(v.key)).toBe(v.conversation));
  }
  for (const v of vectors.pick) {
    it(`pick: ${v.name}`, () => expect(pickOpenClawSteeringKey(v.keys)).toBe(v.expected));
  }
  for (const v of vectors.next) {
    it(`next: ${v.name}`, () => expect(nextOpenClawSteeringKey(v.current, v.event)).toBe(v.expected));
  }
});
