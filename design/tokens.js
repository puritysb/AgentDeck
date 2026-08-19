// AgentDeck — Design tokens (browser-loadable mirror of design/tokens.css).
// Use in mockup HTMLs that need design tokens as JS values (e.g. data.js demo
// state color lookups). Loads as a plain script and exposes window.DT.
//
// Source of truth is design/tokens.css. Keep this file in sync when tokens
// change. Add design/tokens.js to lint.sh TOKEN_FILES allowlist.

(function () {
  const Tide = {
    s50: '#f5f3ec', s100: '#ebe6d6', s200: '#d8cfb6', s300: '#a8b09a',
  };
  const Ink = {
    s900: '#0e1f1f', s800: '#15302f', s700: '#1f4544', s500: '#426664', s300: '#7c9694',
  };
  const Kelp = { s700: '#1f6157', s500: '#2f8a7c', s300: '#6fb6a8' };
  const Coral = { s500: '#c0573a', s700: '#8c3a23' };
  const Amber = { s500: '#c8923a' };

  // Marketing status semantics (DESIGN.md §2.7)
  const Status = {
    idle: Ink.s300,
    processing: Kelp.s500,
    awaiting: Amber.s500,
    error: Coral.s500,
  };

  // Product UI palette (DESIGN.md §2.6) — brighter signal colors for menubar /
  // e-ink / hardware / TTY. Marketing surfaces must NEVER use these.
  const UI = {
    ok: '#52D988',
    attn: '#FFA93D',
    error: '#FF6B6B',
    cyan: '#3ED6E8',
    idle: '#9a9aa2',
    idleDark: '#7a8a9c',
    popupBgDark: '#0a1a2a',
    popupBgDeep: '#061018',
    popupBgMid: '#0a1520',
    popupBgLight: '#f6f3ee',
    ttyBg: '#0c0d10',
    ttyBgMid: '#141820',
    ttyText: '#c8d0d8',
    ttyDim: '#7a8493',
    ttyFaint: '#4a5060',
  };

  // Agent brand marks — only saturated reds/blues allowed in the system.
  // DESIGN.md §6.1: brand colors come from upstream marks; do not redraw or restyle.
  const Brand = {
    claudeCode: '#C07058',
    codex: '#6166E0',
    openclaw: '#FF4D4D',
    opencode: '#3a3a3a',
    antigravity: '#5F6368',
    kiro: '#7C3AED',
  };

  window.DT = { Tide, Ink, Kelp, Coral, Amber, Status, UI, Brand };
})();
