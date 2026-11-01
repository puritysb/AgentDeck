import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { openCodeQuestionPrompt } from '../opencode-question.js';
const cases = JSON.parse(readFileSync(new URL('../../opencode-question-vectors.json', import.meta.url), 'utf8'));
describe('OpenCode device question contract', () => {
  for (const row of cases) it(row.name, () => {
    const prompt = openCodeQuestionPrompt(row.questions);
    if (!row.expected) expect(prompt).toBeUndefined();
    else {
      expect(prompt?.question).toBe(row.expected.question);
      expect(prompt?.options.map(o => o.label)).toEqual(row.expected.labels);
      expect(prompt?.replyable).toBe(row.expected.replyable);
    }
  });
});
