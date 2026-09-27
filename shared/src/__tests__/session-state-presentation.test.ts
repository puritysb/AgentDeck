import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { State } from '../states.js';
import { Brand, Session, UI } from '../design-tokens.js';
import {
  SESSION_STATE_WORDS, SESSION_TONE_COLORS, SESSION_TONE_PAPER_COLORS, SESSION_PULSING_TONE,
  sessionTone, sessionToneColor, sessionStateWords,
} from '../session-state-presentation.js';
import { STATE_COLORS, stateColor, agentBrandColor } from '../state-colors.js';
import * as shared from '../index.js';
// @ts-expect-error executable generator has no TypeScript declaration
import { outputs, sourceFrom } from '../../../scripts/generate-session-state.mjs';

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('session state presentation (DESIGN.md §2.7)', () => {
  it('gives each wire state one tone: calm idle, cyan work, amber asks, grey offline', () => {
    expect(sessionTone(State.IDLE)).toBe('idle');
    expect(sessionTone(State.PROCESSING)).toBe('working');
    for (const s of [State.AWAITING_PERMISSION, State.AWAITING_OPTION, State.AWAITING_DIFF]) expect(sessionTone(s)).toBe('awaiting');
    expect(sessionTone(State.DISCONNECTED)).toBe('offline');
  });

  it('treats a missing state as offline and an unknown one as a live quiet session', () => {
    expect(sessionTone(undefined)).toBe('offline');
    expect(sessionTone('')).toBe('offline');
    expect(sessionTone('some_future_state')).toBe('idle');
    expect(sessionStateWords(undefined).short).toBe('OFFLINE');
    expect(sessionStateWords('some_future_state').short).toBe('IDLE');
  });

  it('binds colours to the Session token group, never to literals', () => {
    expect(SESSION_TONE_COLORS).toEqual({ idle: Session.idle, working: Session.working, awaiting: Session.awaiting, offline: Session.offline });
    expect(Session).toMatchObject({ idle: UI.idle, working: UI.cyan, awaiting: UI.attn, offline: UI.idleDark });
    for (const state of Object.values(State)) expect(STATE_COLORS[state]).toBe(sessionToneColor(state));
    expect(stateColor(undefined)).toBe(Session.offline);
  });

  it('keeps work visually distinct from brand hues and from the idle grey', () => {
    // Working used to be Tailwind blue, which read as the Codex brand beside a
    // Codex mark; green would collide with health (link up, quota normal).
    expect(Session.working).not.toBe(Brand.codex);
    expect(Session.working).not.toBe(UI.ok);
    expect(new Set(Object.values(SESSION_TONE_COLORS)).size).toBe(4);
    // A live quiet session reads brighter than one with no live information.
    expect(luminance(Session.idle)).toBeGreaterThan(luminance(Session.offline));
  });

  it('stays legible as small text on water, dark popups and paper', () => {
    for (const c of Object.values(SESSION_TONE_COLORS)) {
      expect(contrast(c, UI.waterDeep)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, UI.popupBgDark)).toBeGreaterThanOrEqual(4.5);
    }
    for (const c of Object.values(SESSION_TONE_PAPER_COLORS)) expect(contrast(c, UI.popupBgLight)).toBeGreaterThanOrEqual(4.5);
  });

  it('lets only the awaiting tone animate', () => {
    expect(SESSION_PULSING_TONE).toBe('awaiting');
  });

  it('keeps one vocabulary that fits every surface budget', () => {
    for (const words of Object.values(SESSION_STATE_WORDS)) {
      expect(words.short).toBe(words.short.toUpperCase());
      expect(words.short.length).toBeLessThanOrEqual(7);
      expect(words.tiny.length).toBeLessThanOrEqual(4);
      expect(words.label[0]).toBe(words.label[0].toUpperCase());
    }
    const shorts = Object.values(SESSION_STATE_WORDS).map(w => w.short);
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it('draws agent brand hues from the Brand tokens', () => {
    expect(agentBrandColor('codex-cli')).toBe(Brand.codex);
    expect(agentBrandColor('claude-code')).toBe(Brand.claudeCode);
    expect(agentBrandColor('opencode')).toBe(Brand.opencodeOnDark);
    expect(agentBrandColor('kiro-ide')).toBe(Brand.kiro);
    expect(agentBrandColor('nobody')).toBe(UI.hudSubtext);
  });

  it('generates the Swift, Kotlin and ESP32 mirrors from the source', () => {
    const src = sourceFrom(shared);
    for (const [target, emit] of outputs) {
      expect(readFileSync(new URL(`../../../${target}`, import.meta.url), 'utf8'), target).toBe(emit(src));
    }
  });
});
