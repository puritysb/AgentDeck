/**
 * Session slot button SVG renderer for v4 dynamic layout.
 *
 * Renders: session list buttons, detail view info/options/nav buttons.
 * 144x144 canvas matching SD+ button spec.
 *
 * Agent identification: creature icon (agentLogoIcon) at top of button.
 * State colors: unified palette from shared/state-colors (no agent overrides).
 */
import type { SessionInfo } from '../protocol.js';
import type { PromptOption } from '../states.js';
import type { AgentType } from '../adapter.js';
import { State } from '../states.js';
import { stateColor } from '../state-colors.js';
import { agentLogoIcon } from './agent-logos.js';
import { wrapTextByWidth } from './text-utils.js';

const SIZE = 144;
const MAX_TEXT_PX = 124; // 144 - 10px padding each side

function stateLabel(state?: string, agentType?: AgentType): string {
  if (!state) return 'OFFLINE';
  // OpenClaw-specific labels
  if (agentType === 'openclaw') {
    if (state === 'idle') return 'STANDBY';
    if (state === 'processing') return 'ROUTING';
  }
  switch (state) {
    case 'idle': return 'IDLE';
    case 'processing': return 'WORKING';
    case 'awaiting_option':
    case 'awaiting_permission':
    case 'awaiting_diff':
      return 'AWAITING';
    default: return state.toUpperCase();
  }
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

// ---- Session List Button ----

export function renderSessionSlot(
  session: SessionInfo,
  isActive: boolean,
  animFrame: number,
  displayName?: string,
): string {
  const isAwaiting = session.state?.startsWith('awaiting') ?? false;
  const agent = (session.agentType as AgentType) || 'claude-code';
  const sColor = stateColor(session.state);
  const bgColor = isActive ? '#1e3a5f' : (isAwaiting ? '#2d1810' : '#1a1a2e');

  const nameForDisplay = displayName ?? session.projectName;

  // Project name (main text, bold)
  const projectName = truncate(nameForDisplay, 16);
  const projFontSize = projectName.length > 10 ? 16 : 20;

  // Model name
  const modelText = session.modelName ? truncate(session.modelName, 16) : '';

  // State indicator
  const stateLbl = stateLabel(session.state, agent);

  // Agent creature icon — primary identification element
  const icon = agentLogoIcon(agent, 48, 0.7);

  // AWAITING pulse glow border
  let glowBorder = '';
  if (isAwaiting) {
    const pulseOpacity = 0.4 + 0.5 * Math.abs(Math.sin(animFrame * 0.15));
    glowBorder = [
      `<defs><filter id="pg" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur in="SourceGraphic" stdDeviation="2"/></filter></defs>`,
      `<rect x="2" y="2" width="140" height="140" rx="11" fill="none" stroke="${sColor}" stroke-width="2.5" opacity="${pulseOpacity.toFixed(2)}" filter="url(#pg)"/>`,
      `<rect x="2" y="2" width="140" height="140" rx="11" fill="none" stroke="${sColor}" stroke-width="1.5" opacity="${(pulseOpacity * 0.8).toFixed(2)}"/>`,
    ].join('');
  }

  // Active indicator (thin left border)
  const activeBorder = isActive
    ? `<rect x="0" y="16" width="3" height="112" rx="1.5" fill="#3b82f6" opacity="0.8"/>`
    : '';

  // Layout (144px canvas):
  //   y=4~52:   Agent creature icon (48px, brand-colored)
  //   y=68:     Project name (bold, white)
  //   y=86:     Model name (slate)
  //   y=112:    State dot + label (state-colored)
  const elements = [
    icon,
    glowBorder,
    activeBorder,
    // Project name
    `<text x="72" y="68" text-anchor="middle" font-family="Arial,sans-serif" font-size="${projFontSize}" font-weight="bold" fill="#ffffff">${escXml(projectName)}</text>`,
    // Model name
    modelText ? `<text x="72" y="86" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#94a3b8">${escXml(modelText)}</text>` : '',
    // State dot + label (centered, bottom)
    `<text x="72" y="112" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="600" fill="${sColor}">\u25CF ${escXml(stateLbl)}</text>`,
  ].join('');

  return svgFrame(bgColor, elements);
}

// ---- Empty Slot ----

export function renderEmptySlot(): string {
  const label = `<text x="72" y="76" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#333333">Empty</text>`;
  return svgFrame('#111111', label);
}

export function renderNoDaemonSlot(slot: number): string {
  if (slot === 0) {
    // START button — launches macOS app
    const elements = [
      `<text x="72" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#94a3b8">AgentDeck</text>`,
      `<text x="72" y="96" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="#22c55e">\u25B6 START</text>`,
    ].join('');
    return svgFrame('#0f1a0f', elements);
  }
  return svgFrame('#111111', '');
}

// ---- Navigation Buttons ----

export function renderBackButton(): string {
  const arrow = `<text x="72" y="76" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" fill="#94a3b8">\u2190</text>`;
  const label = `<text x="72" y="108" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="600" fill="#94a3b8">BACK</text>`;
  return svgFrame('#1a1a1a', arrow + label);
}

export function renderNextPageButton(pageLabel: string): string {
  const arrow = `<text x="72" y="64" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" fill="#60a5fa">\u25B6</text>`;
  const label = `<text x="72" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="600" fill="#60a5fa">NEXT</text>`;
  const page = `<text x="72" y="114" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#64748b">${escXml(pageLabel)}</text>`;
  return svgFrame('#1a1a2e', arrow + label + page);
}

export function renderEscButton(active = true): string {
  const c = active ? '#f97316' : '#a0855a';
  const bg = active ? '#2d1810' : '#1a1308';
  const op = active ? '' : ' opacity="0.45"';
  const elements = [
    `<text x="72" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" fill="${c}"${op}>\u2716</text>`,
    `<text x="72" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${c}"${op}>ESC</text>`,
  ].join('');
  return svgFrame(bg, elements);
}

export function renderStopButton(active = true): string {
  const c = active ? '#ef4444' : '#666666';
  const bg = active ? '#2d1010' : '#1a0a0a';
  const op = active ? '' : ' opacity="0.4"';
  const elements = [
    `<text x="72" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" fill="${c}"${op}>\u25A0</text>`,
    `<text x="72" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${c}"${op}>STOP</text>`,
  ].join('');
  return svgFrame(bg, elements);
}

// ---- Detail View: Session Info ----

export function renderDetailInfo(session: SessionInfo | undefined, state: State, tool?: string, modelName?: string, mode?: string, displayName?: string): string {
  if (!session) return renderEmptySlot();

  const agent = (session.agentType as AgentType) || 'claude-code';
  const sColor = stateColor(session.state);
  const stateLbl = stateLabel(session.state, agent);
  const isOpenClaw = agent === 'openclaw';
  const nameForDisplay = displayName ?? session.projectName;

  // Detail info layout (144px canvas):
  //   y=top:    Agent creature icon (small, brand-colored)
  //   y=50:     project name (bold, white)
  //   y=72:     model (slate, skip for OpenClaw)
  //   y=90:     mode (purple, skip for OpenClaw)
  //   y=106:    tool (yellow)
  //   y=132:    state dot + label (state-colored)
  const detailIcon = agentLogoIcon(agent, 36, 0.5);

  const elements = [
    detailIcon,
    // Project name (bold, large)
    `<text x="72" y="50" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="bold" fill="#ffffff">${escXml(truncate(nameForDisplay, 12))}</text>`,
    // Model (skip for OpenClaw)
    modelName && !isOpenClaw ? `<text x="72" y="72" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#94a3b8">${escXml(truncate(modelName, 16))}</text>` : '',
    // Mode (skip for OpenClaw)
    mode && mode !== 'default' && !isOpenClaw ? `<text x="72" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#a78bfa">${escXml(mode.toUpperCase())}</text>` : '',
    // Tool (if processing)
    tool ? `<text x="72" y="106" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#fbbf24">\u25B6 ${escXml(truncate(tool, 16))}</text>` : '',
    // State (centered, bottom)
    `<text x="72" y="132" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="600" fill="${sColor}">\u25CF ${escXml(stateLbl)}</text>`,
  ].join('');

  return svgFrame('#0f172a', elements);
}

// ---- Detail View: Option Button ----

export function renderOptionButton(option: PromptOption, index: number): string {
  const label = option.label || `Option ${index + 1}`;
  const lines = wrapTextByWidth(label, MAX_TEXT_PX, 16);
  const lineHeight = 20;
  const startY = lines.length === 1 ? 76 : 76 - ((lines.length - 1) * lineHeight) / 2;

  // Slot number (top-right)
  const slotNum = `<text x="${SIZE - 10}" y="18" text-anchor="end" font-family="Arial,sans-serif" font-size="13" fill="#ffffff" opacity="0.25">${index + 1}</text>`;

  const textEls = lines.slice(0, 3).map((line, i) =>
    `<text x="72" y="${startY + i * lineHeight}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#ffffff">${escXml(line)}</text>`
  ).join('');

  // Use different bg colors for visual distinction
  const colors = ['#1e3a5f', '#1e3a4a', '#2a1e4a', '#1e4a3a', '#3a1e2a'];
  const bgColor = colors[index % colors.length];

  return svgFrame(bgColor, slotNum + textEls);
}

// ---- Detail View: Preset Action Button ----

export function renderPresetButton(label: string, iconSvg: string, color: string, textColor: string, subtitle?: string, loading?: boolean): string {
  if (loading) {
    return svgFrame(color, iconSvg);
  }
  const labelEl = `<text x="72" y="100" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="${textColor}">${escXml(label)}</text>`;
  const subEl = subtitle
    ? `<text x="72" y="118" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="${textColor}" opacity="0.7">${escXml(truncate(subtitle, 14))}</text>`
    : '';
  return svgFrame(color, iconSvg + labelEl + subEl);
}

// ---- Detail View: Info slot (tool, model/mode) ----

export function renderInfoSlot(label: string, subtitle?: string): string {
  const mainEl = `<text x="72" y="${subtitle ? 68 : 76}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#94a3b8">${escXml(truncate(label, 18))}</text>`;
  const subEl = subtitle
    ? `<text x="72" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#64748b">${escXml(truncate(subtitle, 22))}</text>`
    : '';
  return svgFrame('#1a1a1a', mainEl + subEl);
}

// ---- SVG Frame ----

export function svgFrame(bgColor: string, innerElements: string, slotNumber?: number): string {
  const slotLabel = slotNumber != null
    ? `<text x="${SIZE - 10}" y="18" text-anchor="end" font-family="Arial,sans-serif" font-size="13" fill="#ffffff" opacity="0.3">${slotNumber}</text>`
    : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${bgColor}"/>`,
    innerElements,
    slotLabel,
    `</svg>`,
  ].join('');
}
