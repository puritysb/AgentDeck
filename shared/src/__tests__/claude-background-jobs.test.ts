import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeBackgroundProcessRole, isClaudeSpareStartup } from '../claude-background-jobs.js';

const { vectors } = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../claude-background-job-vectors.json', import.meta.url)), 'utf8',
)) as { vectors: Array<{
  name: string; command: string; parent: string | null; source: string;
  role: string; forkedFrom?: string; spareStartup: boolean;
}> };

describe('claude background-job rule (shared vectors)', () => {
  it('has vectors', () => expect(vectors.length).toBeGreaterThan(0));
  for (const v of vectors) {
    it(v.name, () => {
      const role = claudeBackgroundProcessRole(v.command, v.parent ?? undefined);
      expect(role.role).toBe(v.role);
      expect(role.role === 'job' ? role.forkedFrom : undefined).toBe(v.forkedFrom);
      expect(isClaudeSpareStartup(v.source, role)).toBe(v.spareStartup);
    });
  }
});
