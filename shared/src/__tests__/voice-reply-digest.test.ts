import { describe, it, expect } from 'vitest';
import {
  MAX_SPOKEN_CHARS, SPOKEN_DIGEST_MAX_CHARS, SPOKEN_DIGEST_CASES,
  speakableReply, spokenDigest,
} from '../voice-reply-digest.js';

describe('spokenDigest parity cases', () => {
  // The same table drives SpokenDigestParityTests on the Swift side; a case
  // added here must be added there, which is the point of keeping it exported.
  it.each(SPOKEN_DIGEST_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(spokenDigest(c.input)).toBe(c.expected);
  });
});

describe('spokenDigest', () => {
  it('reads one sentence out of a long answer, not the whole thing', () => {
    const body = '고쳤습니다. ' + '이유는 여러 가지입니다. '.repeat(40);
    const out = spokenDigest(body);
    expect(out).toBe('고쳤습니다.');
    expect(out.length).toBeLessThan(SPOKEN_DIGEST_MAX_CHARS);
  });

  it('keeps a summary line even when it is the last thing in the reply', () => {
    const out = spokenDigest('앞 문장입니다.\n중간 문장입니다.\n결론 — 다시 빌드하면 됩니다.');
    expect(out).toBe('다시 빌드하면 됩니다.');
  });

  it('does not treat prose that merely opens with a label word as a summary', () => {
    // "요약" here is the subject of the sentence, not a heading.
    const out = spokenDigest('요약 문서는 따로 없습니다. 코드를 보세요.');
    expect(out).toBe('요약 문서는 따로 없습니다.');
  });

  it('cuts an over-long single sentence on a word boundary', () => {
    const sentence = `${'word '.repeat(120).trim()} end`;
    const out = spokenDigest(sentence);
    expect(out.length).toBeLessThanOrEqual(SPOKEN_DIGEST_MAX_CHARS);
    expect(out.endsWith('word')).toBe(true);   // never mid-word
  });

  it('honours full: true for callers that opted back in', () => {
    const body = 'First. Second. Third.';
    expect(spokenDigest(body, { full: true })).toBe(body);
    expect(spokenDigest(body)).toBe('First.');
  });

  it('stays empty when there is nothing to say', () => {
    expect(spokenDigest('')).toBe('');
    expect(spokenDigest('   \n \n')).toBe('');
  });
});

describe('speakableReply', () => {
  // Unchanged contract — the digest is layered on top rather than replacing it,
  // so the board/bench paths that want the whole readable answer still can.
  it('keeps the whole readable answer', () => {
    const out = speakableReply('Fixed it.\n\n```ts\nconst x = 1;\n```\n\nRun the tests.');
    expect(out).toContain('Fixed it.');
    expect(out).toContain('(code)');
    expect(out).toContain('Run the tests.');
    expect(out).not.toContain('const x');
  });

  it('caps at the monologue ceiling', () => {
    expect(speakableReply('y'.repeat(MAX_SPOKEN_CHARS + 500)).length)
      .toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
  });
});
