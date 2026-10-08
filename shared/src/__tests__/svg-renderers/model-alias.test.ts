import { describe, it, expect } from 'vitest';
import { aliasModelName, formatModelEffort } from '../../svg-renderers/session-slot-renderer.js';

describe('aliasModelName', () => {
  it('shortens claude family-major-minor', () => {
    expect(aliasModelName('claude-sonnet-4-6')).toBe('sonnet 4.6');
    expect(aliasModelName('claude-opus-4-7')).toBe('opus 4.7');
    expect(aliasModelName('claude-haiku-4-5')).toBe('haiku 4.5');
  });

  it('drops trailing date suffix on claude releases', () => {
    expect(aliasModelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
  });

  it('passes gpt and unknown strings through unchanged', () => {
    expect(aliasModelName('gpt-5-codex')).toBe('gpt-5-codex');
    expect(aliasModelName('gpt-4o')).toBe('gpt-4o');
    expect(aliasModelName('llama-3.1-70b')).toBe('llama-3.1-70b');
  });
});

describe('formatModelEffort', () => {
  it('returns aliased model when no effort to show', () => {
    expect(formatModelEffort('claude-sonnet-4-6', undefined, 15)).toBe('sonnet 4.6');
    expect(formatModelEffort('claude-opus-4-7', 'default', 15)).toBe('opus 4.7');
  });

  it('shows every reported level — which one is the default is per agent and model (#463)', () => {
    expect(formatModelEffort('claude-opus-4-7', 'medium', 20)).toBe('opus 4.7 · medium');
    expect(formatModelEffort('gpt-6-astra', 'ultra', 20)).toBe('gpt-6-astra · ultra');
  });

  it('appends effort when it fits', () => {
    expect(formatModelEffort('claude-sonnet-4-6', 'high', 20)).toBe('sonnet 4.6 · high');
  });

  it('truncates aliased model name to fit budget with effort suffix', () => {
    const out = formatModelEffort('claude-sonnet-4-6', 'high', 12);
    expect(out.endsWith(' · high')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it('returns empty string for missing model', () => {
    expect(formatModelEffort(undefined, 'high')).toBe('');
  });
});
