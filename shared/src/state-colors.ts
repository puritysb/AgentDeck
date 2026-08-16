/**
 * Canonical state color palette — single source of truth for all platforms.
 *
 * TypeScript consumers import directly.
 * Native platforms (Android/Apple/ESP32) reference these hex values in comments.
 */
import { State } from './states.js';
import type { AgentType } from './adapter.js';

// ===== State Colors =====

export const STATE_COLORS: Record<State, string> = {
  [State.IDLE]:                '#22c55e',  // green
  [State.PROCESSING]:          '#3b82f6',  // blue
  [State.AWAITING_PERMISSION]: '#f59e0b',  // amber
  [State.AWAITING_OPTION]:     '#f59e0b',  // amber
  [State.AWAITING_DIFF]:       '#f59e0b',  // amber
  [State.DISCONNECTED]:        '#6b7280',  // gray
};

/** Look up state color by string key. No agent-type overrides — purely semantic. */
export function stateColor(state: string | undefined): string {
  if (!state) return STATE_COLORS[State.DISCONNECTED];
  return (STATE_COLORS as Record<string, string>)[state] ?? STATE_COLORS[State.IDLE];
}

// ===== Agent Brand Colors (for icons, not states) =====

export const AGENT_BRAND_COLORS: Record<string, string> = {
  'claude-code': '#C07058',  // terracotta
  'openclaw':    '#ff4d4d',  // red
  'codex-cli':   '#6366f1',  // indigo
  'codex-app':   '#6366f1',  // indigo
  'opencode':    '#F1ECEC',  // cream
  'antigravity': '#5F6368',  // Google gray
  'kiro-cli':    '#7C3AED',  // Kiro purple
  'kiro-ide':    '#7C3AED',  // Kiro purple
  'monitor':     '#94a3b8',  // slate
};

/** Get agent brand color. Falls back to slate for unknown types. */
export function agentBrandColor(agentType: string | undefined): string {
  return AGENT_BRAND_COLORS[agentType ?? ''] ?? '#94a3b8';
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
