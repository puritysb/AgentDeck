import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { COLLABORATION_PRESENTATION, collaborationPhase } from '../collaboration-presentation.js';
// @ts-expect-error executable generator has no TypeScript declaration
import { outputs } from '../../../scripts/generate-collaboration-presentation.mjs';
it('preserves parent state while distinguishing outstanding work from idle', () => {
  expect(collaborationPhase(false,false,0,0,0)).toBe(3);
  for(const counts of [[1,0,0],[0,1,0],[0,0,1]]) {
    expect(collaborationPhase(false,false,counts[0],counts[1],counts[2])).toBe(2);
    expect(collaborationPhase(false,true,counts[0],counts[1],counts[2])).toBe(1);
    expect(collaborationPhase(true,false,counts[0],counts[1],counts[2])).toBe(0);
  }
});
it('keeps firmware and macOS on the same census labels and phase rule', () => {
  for(const [target,emit] of outputs) expect(readFileSync(new URL(`../../../${target}`,import.meta.url),'utf8')).toBe(emit(COLLABORATION_PRESENTATION,collaborationPhase.toString()));
});
