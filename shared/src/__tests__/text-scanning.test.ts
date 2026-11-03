import { describe, expect, it } from 'vitest';
import { firstTagContent, hasOrderedTerms, stripCodeFences, stripThinkBlocks, trimCharacters } from '../text-scanning.js';

describe('bounded-work scanning of agent output', () => {
  it('preserves delimiter behavior for complete and truncated model output', () => {
    expect(stripThinkBlocks('before<think>private</think>answer<think>unfinished')).toBe('beforeanswer');
    expect(stripCodeFences('before```ts\nconst answer = 42;\n```after')).toBe('beforeconst answer = 42;\nafter');
    expect(stripCodeFences('before```unfinished')).toBe('before```unfinished');
    expect(firstTagContent('<command-args> one </command-args>', '<command-args>', '</command-args>')).toBe(' one ');
    expect(trimCharacters('(("/tmp/file.py");|&', '"\'`(', '"\'`);|&')).toBe('/tmp/file.py');
  });

  it('retains ordered same-line terms and whitespace after the suffix term', () => {
    const polling = (text: string) => hasOrderedTerms(text, /아직|여전히|계속/, /(?:번역|진행)\s*중/);
    expect(polling('계속 번역 중')).toBe(true);
    expect(polling('계속 번역\n중')).toBe(true);
    expect(polling('계속\n번역 중')).toBe(false);
    expect(polling('번역 중 계속')).toBe(false);
    expect(polling('계속\n다른 줄\n아직 진행 중')).toBe(true);
  });

  it('handles long unmatched delimiters, terms and whitespace without repeated suffix searches', () => {
    const repeated = 100_000;
    expect(stripThinkBlocks('<think>'.repeat(repeated))).toBe('');
    expect(firstTagContent('<command-args>a'.repeat(repeated), '<command-args>', '</command-args>')).toBeUndefined();
    expect(hasOrderedTerms('계속'.repeat(repeated), /아직|여전히|계속/, /(?:번역|진행)\s*중/)).toBe(false);
    expect(hasOrderedTerms(('계속\n').repeat(repeated) + '진행 중', /아직|여전히|계속/, /(?:번역|진행)\s*중/)).toBe(false);
    expect(trimCharacters('\t'.repeat(repeated), '\t\n\v\f\r ')).toBe('');
  });
});
