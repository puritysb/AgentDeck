// AgentDeck — Design tokens (TS bindings)
// Mirror of design/tokens.css — see DESIGN.md for the spec.
// CSS file remains the source of truth; keep this file in sync when tokens change.

export const Tide = {
  s50: "#f5f3ec",
  s100: "#ebe6d6",
  s200: "#d8cfb6",
  s300: "#a8b09a",
} as const;

export const Ink = {
  s900: "#0e1f1f",
  s800: "#15302f",
  s700: "#1f4544",
  s500: "#426664",
  s300: "#7c9694",
} as const;

export const Kelp = {
  s700: "#1f6157",
  s500: "#2f8a7c",
  s300: "#6fb6a8",
} as const;

export const Coral = {
  s500: "#c0573a",
  s700: "#8c3a23",
} as const;

export const Amber = {
  s500: "#c8923a",
} as const;

// Marketing / editorial status semantics (DESIGN.md §2.7)
export const Status = {
  idle: Ink.s300,
  processing: Kelp.s500,
  awaiting: Amber.s500,
  error: Coral.s500,
} as const;

// Product UI palette — brighter signal colors for menubar / e-ink / hardware / TTY.
// DESIGN.md §2.6: marketing surfaces must NEVER use these.
export const UI = {
  ok: "#52D988",
  attn: "#FFA93D",
  error: "#FF6B6B",
  cyan: "#3ED6E8",
  idle: "#9a9aa2",
  idleDark: "#7a8a9c",
  popupBgDark: "#0a1a2a",
  popupBgDeep: "#061018",
  popupBgMid: "#0a1520",
  popupBgLight: "#f6f3ee",
  ttyBg: "#0c0d10",
  ttyBgMid: "#141820",
  ttyText: "#c8d0d8",
  ttyDim: "#7a8493",
  ttyFaint: "#4a5060",
} as const;

// Agent brand marks (only saturated reds/blues allowed in the system).
// Keep in sync with design/brand/*.svg.
export const Brand = {
  claudeCode: "#C07058",
  codex: "#6166E0",
  openclaw: "#FF4D4D",
  opencode: "#3a3a3a",
  antigravity: "#5F6368",
  kiro: "#7C3AED",
} as const;

export const Font = {
  sans: '"IBM Plex Sans", "IBM Plex Sans KR", "IBM Plex Sans JP", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
} as const;

export const Type = {
  hero: "clamp(54px, 7vw, 96px)",
  editorial: "clamp(56px, 8vw, 112px)",
  pageTitle: "clamp(38px, 5vw, 64px)",
  h2: "44px",
  h3: "26px",
  h3Lg: "32px",
  cardTitle: "19px",
  bodyLg: "19px",
  body: "17px",
  lede: "18px",
  small: "14.5px",
  caption: "13px",
  kicker: "12px",
  monoBadge: "11.5px",
} as const;

export const Tracking = {
  hero: "-0.035em",
  editorial: "-0.04em",
  h2: "-0.02em",
  h3: "-0.015em",
  card: "-0.01em",
  kicker: "0.18em",
  badge: "0.16em",
  chip: "0.08em",
} as const;

// Spacing scale (4px base) — DESIGN.md §4.1
export const Spacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
  s12: 48,
  s14: 56,
  s16: 64,
  s20: 80,
  s24: 96,
  s30: 120,
} as const;

export const Layout = {
  containerMax: 1240,
  containerPad: 32,
  sectionY: 96,
} as const;

export const Radius = {
  sm: 4,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 14,
  xxxl: 16,
  xxxxl: 18,
  pill: 999,
} as const;

export const Shadow = {
  card: "0 6px 20px -8px rgba(14, 31, 31, 0.45)",
  cardHover: "0 10px 28px -8px rgba(14, 31, 31, 0.55)",
  frame:
    "0 30px 80px -30px rgba(14, 31, 31, 0.4), 0 8px 30px -10px rgba(14, 31, 31, 0.18)",
  canvas: "0 30px 80px -20px rgba(0, 0, 0, 0.6)",
} as const;

export const Motion = {
  easeSnap: "cubic-bezier(0.2, 0.6, 0.2, 1)",
  fast: 120,
  base: 200,
  slow: 320,
  pulse: 1100,
  wiggle: 700,
} as const;

export const DesignTokens = {
  Tide,
  Ink,
  Kelp,
  Coral,
  Amber,
  Status,
  UI,
  Brand,
  Font,
  Type,
  Tracking,
  Spacing,
  Layout,
  Radius,
  Shadow,
  Motion,
} as const;
