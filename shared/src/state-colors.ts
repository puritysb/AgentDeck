/**
 * State and agent-brand colours for TypeScript renderers.
 *
 * Both tables are bindings, not palettes: session-state colours come from
 * `session-state-presentation.ts` (the `Session` token group, DESIGN.md §2.7)
 * and brand colours from the `Brand` token group (design/brand/*.svg). Native
 * platforms consume the generated mirrors of the same source.
 */
import { State } from './states.js';
import { Brand, UI } from './design-tokens.js';
import { SESSION_STATE_TONES, SESSION_TONE_COLORS, sessionToneColor } from './session-state-presentation.js';

// ===== State Colors =====

export const STATE_COLORS: Record<State, string> = Object.fromEntries(
  Object.entries(SESSION_STATE_TONES).map(([state, tone]) => [state, SESSION_TONE_COLORS[tone]]),
) as Record<State, string>;

/** Look up state color by string key. No agent-type overrides — purely semantic.
 * Missing → offline grey; unknown → idle (see `sessionTone`). */
export function stateColor(state: string | undefined): string {
  return sessionToneColor(state);
}

// ===== Agent Brand Colors (for icons, not states) =====

/** Brand hue per agent, as legible on the dark product screens these
 * renderers draw. OpenCode's upstream mark is near-black, so dark screens use
 * its light variant. `monitor` and unknown agents are a neutral HUD grey. */
export const AGENT_BRAND_COLORS: Record<string, string> = {
  'claude-code': Brand.claudeCode,
  'openclaw':    Brand.openclaw,
  'codex-cli':   Brand.codex,
  'codex-app':   Brand.codex,
  'opencode':    Brand.opencodeOnDark,
  'antigravity': Brand.antigravity,
  'kiro-cli':    Brand.kiro,
  'kiro-ide':    Brand.kiro,
  'monitor':     UI.hudSubtext,
};

/** Get agent brand color. Falls back to the neutral HUD grey for unknown types. */
export function agentBrandColor(agentType: string | undefined): string {
  return AGENT_BRAND_COLORS[agentType ?? ''] ?? UI.hudSubtext;
}

// ===== Color Utilities =====

/** Mix a hex color toward black by ratio (0=original, 1=black). */
export function dimColor(hex: string, ratio: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.round(r * (1 - ratio));
  const dg = Math.round(g * (1 - ratio));
  const db = Math.round(b * (1 - ratio));
  return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;
}
