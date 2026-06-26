/**
 * Encoder OFFLINE-banner slicing contract.
 *
 * Regression guard for the multi-session-switch bug where the encoder touch
 * strip showed a *half* "AGENTDECK OFFLINE" banner interleaved with timeline /
 * creature content. The banner is a single 800px design sliced across all four
 * encoders (E0..E3) via `translate(-index*200, 0)` — it only reads correctly
 * when all four encoders render it together. This test pins that all-or-nothing
 * slicing contract so a renderer change can't silently break the unified banner.
 *
 * The behavioral half of the fix — that each dial renders this banner IFF the
 * daemon WS is actually down (`isDaemonConnected() === false`) rather than on a
 * transient session-level DISCONNECTED — lives in the dial refresh functions
 * (utility/option/iterm/voice-dial). Those action modules carry Stream Deck
 * `@action` class decorators that the vitest transform does not evaluate, so
 * they are exercised via build + manual hardware verification rather than here,
 * matching the existing suite (which tests pure renderers, not action modules).
 */
import { describe, it, expect } from 'vitest';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';

describe('renderOfflineTouchStrip — all-or-nothing 800px slice contract', () => {
  it('every slice is a 200x100 canvas carrying the shared banner content', () => {
    for (let i = 0; i < 4; i++) {
      const svg = renderOfflineTouchStrip(i);
      expect(svg).toContain('width="200" height="100"');
      expect(svg).toContain('AGENTDECK OFFLINE');
      expect(svg).toContain('npx @agentdeck/setup');
    }
  });

  it('slices 0..3 offset the same banner by -index*200 (E0..E3 align into one strip)', () => {
    expect(renderOfflineTouchStrip(0)).toContain('translate(0 0)');
    expect(renderOfflineTouchStrip(1)).toContain('translate(-200 0)');
    expect(renderOfflineTouchStrip(2)).toContain('translate(-400 0)');
    expect(renderOfflineTouchStrip(3)).toContain('translate(-600 0)');
  });

  it('uses a per-slice gradient id so the four panels are independent SVGs', () => {
    for (let i = 0; i < 4; i++) {
      expect(renderOfflineTouchStrip(i)).toContain(`touchstrip-offline-bg-${i}`);
    }
  });
});
