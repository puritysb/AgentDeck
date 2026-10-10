import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isOpenClawConversationKey, nextOpenClawSteeringKey, openClawMainSessionKeyFromHello, pickOpenClawSteeringKey,
} from '../openclaw-session-key.js';

const vectors = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../openclaw-session-key-vectors.json', import.meta.url)), 'utf8',
)) as {
  keys: Array<{ key: string; conversation: boolean; main?: string }>;
  pick: Array<{ name: string; keys: string[]; main?: string; expected: string | null }>;
  next: Array<{ name: string; current: string | null; event: string | null; main?: string; expected: string | null }>;
};

describe('OpenClaw session-key rule (shared vectors)', () => {
  for (const v of vectors.keys) {
    it(`classifies ${v.key || '(empty)'}${v.main ? ` (main ${v.main})` : ''}`, () => expect(isOpenClawConversationKey(v.key, v.main)).toBe(v.conversation));
  }
  for (const v of vectors.pick) {
    it(`pick: ${v.name}`, () => expect(pickOpenClawSteeringKey(v.keys, v.main)).toBe(v.expected));
  }
  for (const v of vectors.next) {
    it(`next: ${v.name}`, () => expect(nextOpenClawSteeringKey(v.current, v.event, v.main)).toBe(v.expected));
  }

  it('reads the main key from hello-ok, and nothing from a malformed frame', () => {
    expect(openClawMainSessionKeyFromHello({ snapshot: { sessionDefaults: { mainSessionKey: 'agent:main:main', scope: 'per-sender' } } }))
      .toBe('agent:main:main');
    for (const frame of [null, {}, { snapshot: null }, { snapshot: { sessionDefaults: { mainSessionKey: 7 } } }, { snapshot: { sessionDefaults: { mainSessionKey: '' } } }]) {
      expect(openClawMainSessionKeyFromHello(frame)).toBeNull();
    }
  });
});
