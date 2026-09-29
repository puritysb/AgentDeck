import { describe, expect, it } from 'vitest';
import { PerActionViewState } from '../actions/per-action-view-state.js';

describe('PerActionViewState', () => {
  const views = ['triple', '5h', '7d', 'session'];

  it('rotates one action without changing another action', () => {
    const state = new PerActionViewState('triple');
    state.load('left', 'triple');
    state.load('right', '7d');

    expect(state.rotate('left', views, 1)).toBe('5h');
    expect(state.resolve('right', views)).toBe('7d');
  });

  it('restores a persisted view for each action', () => {
    const state = new PerActionViewState('triple');
    state.load('five-hour', '5h');
    state.load('session', 'session');

    expect(state.resolve('five-hour', views)).toBe('5h');
    expect(state.resolve('session', views)).toBe('session');
  });

  it('falls back when a dynamic scoped view disappears', () => {
    const state = new PerActionViewState('triple');
    state.load('scoped', 'scoped:0');

    expect(state.resolve('scoped', views)).toBe('triple');
  });

  it('wraps in both directions', () => {
    const state = new PerActionViewState('triple');
    state.load('dial', 'triple');

    expect(state.rotate('dial', views, -1)).toBe('session');
    expect(state.rotate('dial', views, 1)).toBe('triple');
  });
});
