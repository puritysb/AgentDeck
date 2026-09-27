import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CodexAmbientSessions,
  codexHookPromptText,
  isCodexAmbientPrompt,
  isCodexBackgroundCwd,
} from '../codex-ambient-hooks.js';

const VECTORS = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../shared/codex-ambient-vectors.json', import.meta.url)), 'utf8'));

const HYPER = 'Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project.';
const SAFETY = 'You are an expert at upholding safety and compliance standards for Codex ambient suggestions.\n\nI will present';

describe('isCodexAmbientPrompt (shared vectors)', () => {
  for (const v of VECTORS.vectors as Array<{ name: string; prompt: string; ambient: boolean }>) {
    it(v.name, () => {
      expect(isCodexAmbientPrompt(v.prompt)).toBe(v.ambient);
    });
  }
  it('non-string prompts are never ambient', () => {
    expect(isCodexAmbientPrompt(undefined)).toBe(false);
    expect(isCodexAmbientPrompt({ text: HYPER })).toBe(false);
  });
});

describe('isCodexBackgroundCwd (shared vectors)', () => {
  for (const v of VECTORS.cwdVectors as Array<{ name: string; cwd: string; codexHome?: string; background: boolean }>) {
    it(v.name, () => {
      expect(isCodexBackgroundCwd(v.cwd, v.codexHome)).toBe(v.background);
    });
  }
});

describe('CodexAmbientSessions — memory consolidation agent', () => {
  it('drops the thread from its very first hook, the session start, and keeps dropping it', () => {
    const sessions = new CodexAmbientSessions(30 * 60_000, undefined);
    const sid = '01a0e215-6bdc-7a63-9001-169189760604';
    const first = sessions.classify('codex_session_start', { session_id: sid, cwd: '/Users/me/.codex/memories' });
    expect(first).toEqual({ ambient: true, firstSeen: true, sessionId: sid, reason: 'memory-consolidation' });
    // Tool and stop hooks keep the classification even if their cwd differs.
    expect(sessions.classify('codex_tool_start', { session_id: sid, cwd: '/tmp' }).ambient).toBe(true);
    expect(sessions.classify('codex_stop', { session_id: sid }).ambient).toBe(true);
  });

  it('leaves a real project session alone', () => {
    const sessions = new CodexAmbientSessions(30 * 60_000, undefined);
    expect(sessions.classify('codex_session_start', { session_id: 'real', cwd: '/Users/me/github/memories' }).ambient).toBe(false);
  });
});

describe('codexHookPromptText', () => {
  it('reads prompt, then user_prompt, then message.content', () => {
    expect(codexHookPromptText({ prompt: 'a', user_prompt: 'b' })).toBe('a');
    expect(codexHookPromptText({ user_prompt: 'b' })).toBe('b');
    expect(codexHookPromptText({ message: { content: 'c' } })).toBe('c');
    expect(codexHookPromptText({})).toBe('');
  });
});

describe('CodexAmbientSessions', () => {
  const prompt = (sid: string, text: string) => ({ session_id: sid, cwd: '/', prompt: text });

  it('classifies the thread on its prompt and every later hook on that id', () => {
    const s = new CodexAmbientSessions();
    // The live order: session_start arrives ~90 ms before the prompt and is
    // not yet identifiable — the caller retracts its effects at firstSeen.
    expect(s.classify('codex_session_start', { session_id: 'amb-1', cwd: '/' }, 1000)).toEqual({ ambient: false, firstSeen: false });
    expect(s.classify('codex_user_prompt_submit', prompt('amb-1', SAFETY), 1090))
      .toEqual({ ambient: true, firstSeen: true, sessionId: 'amb-1', reason: 'ambient-suggestions' });
    expect(s.classify('codex_tool_start', { session_id: 'amb-1', tool_name: 'shell' }, 1500))
      .toEqual({ ambient: true, firstSeen: false, sessionId: 'amb-1' });
    expect(s.classify('codex_stop', { session_id: 'amb-1' }, 3000))
      .toEqual({ ambient: true, firstSeen: false, sessionId: 'amb-1' });
    expect(s.isAmbient('amb-1')).toBe(true);
  });

  it('a user thread on the same host is untouched, even at cwd /', () => {
    const s = new CodexAmbientSessions();
    expect(s.classify('codex_user_prompt_submit', prompt('user-1', 'fix the failing test'), 1)).toEqual({ ambient: false, firstSeen: false });
    expect(s.classify('codex_tool_start', { session_id: 'user-1' }, 2)).toEqual({ ambient: false, firstSeen: false });
    expect(s.size()).toBe(0);
  });

  it('only codex_* hooks with a session id are considered', () => {
    const s = new CodexAmbientSessions();
    expect(s.classify('UserPromptSubmit', { session_id: 'c', prompt: HYPER }, 1).ambient).toBe(false);
    expect(s.classify('codex_user_prompt_submit', { prompt: HYPER }, 1).ambient).toBe(false);
    expect(s.size()).toBe(0);
  });

  it('a background thread is forgotten after the TTL, and re-identified by a fresh prompt', () => {
    const s = new CodexAmbientSessions(1000);
    s.classify('codex_user_prompt_submit', prompt('amb-2', HYPER), 0);
    expect(s.classify('codex_tool_end', { session_id: 'amb-2' }, 900).ambient).toBe(true);
    // Silence past the TTL: the id is released.
    expect(s.classify('codex_tool_end', { session_id: 'amb-2' }, 2000).ambient).toBe(false);
    expect(s.size()).toBe(0);
    expect(s.classify('codex_user_prompt_submit', prompt('amb-2', HYPER), 2001).firstSeen).toBe(true);
  });

  it('a hook on a live background thread refreshes its TTL', () => {
    const s = new CodexAmbientSessions(1000);
    s.classify('codex_user_prompt_submit', prompt('amb-3', HYPER), 0);
    s.classify('codex_tool_start', { session_id: 'amb-3' }, 900);
    expect(s.classify('codex_stop', { session_id: 'amb-3' }, 1800).ambient).toBe(true);
  });
});
