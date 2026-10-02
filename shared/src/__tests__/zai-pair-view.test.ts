import { describe, expect, it } from 'vitest';
import { isZaiPairMode, nextZaiPairMode, zaiPairReadings } from '../zai-pair-view.js';

describe('z.ai pair view', () => {
  it('cycles both → first → second → both', () => {
    expect(nextZaiPairMode()).toBe('first');
    expect(nextZaiPairMode('first')).toBe('second');
    expect(nextZaiPairMode('second')).toBe('both');
  });
  it('never invents a missing window', () => {
    expect(zaiPairReadings('5h', 'mcp', 'second')).toEqual(['mcp']);
    expect(zaiPairReadings('5h', undefined, 'second')).toEqual(['5h']);
    expect(zaiPairReadings(undefined, 'mcp', 'first')).toEqual(['mcp']);
    expect(zaiPairReadings(undefined, undefined)).toEqual([]);
  });
  it('accepts only known saved modes', () => {
    expect(isZaiPairMode('second')).toBe(true);
    expect(isZaiPairMode('mcp')).toBe(false);
  });
});
