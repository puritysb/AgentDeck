// Agent creature icons — mirrors the canonical marks from design/brand/.
// Inlined as strings so `currentColor` tinting works without fetch/CORS overhead.

const CREATURE_SVGS = {
  // Claude Code mark — lobe-icons MIT (monochrome, currentColor)
  claudecode: {
    viewBox: '0 0 24 24',
    inner: '<path clip-rule="evenodd" fill-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"/>',
    tintable: true,
  },
  // Codex — OpenAI Codex mark (monochrome, currentColor)
  codex: {
    viewBox: '0 0 24 24',
    inner: '<path fill-rule="evenodd" clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/>',
    tintable: true,
  },
  // OpenClaw — crab-like mark (monochrome, currentColor)
  openclaw: {
    viewBox: '0 0 24 24',
    inner: '<g><path d="M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z"/><path d="M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z"/><path clip-rule="evenodd" fill-rule="evenodd" d="M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z"/><path d="M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z"/><path d="M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.799 1.598-2.203 1.379-3.295.262l-.02-.02a4.962 4.962 0 01-.619-.791l-.01-.017a4.596 4.596 0 01-.276-.489c-.317-.74-.317-1.267-.105-1.61.21-.343.632-.501 1.16-.501l.09-.027a6.43 6.43 0 01.255-.076l.1-.027c.09-.022.176-.042.26-.06l.05-.009z"/></g>',
    tintable: true,
  },
  // OpenCode mark — lobe-icons MIT (monochrome, currentColor)
  opencode: {
    viewBox: '0 0 24 24',
    inner: '<path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/>',
    tintable: true,
  },
  antigravity: {
    viewBox: '0 0 24 24',
    inner: '<path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"/>',
    tintable: true,
  },
  // Kiro ghost — lobe-icons MIT (monochrome, currentColor)
  kiro: {
    viewBox: '0 0 24 24',
    inner: '<path d="M4.594 6.677C6.67-2.226 18.746-2.211 21.16 6.632c.353 1.297 1.725 7.582-1.673 13.747-1.545 2.797-5.841 5.49-6.99 1.883C8.6 25.477 3.315 24.1 5.789 18.609l-.318.143c-3.57 1.305-3.863-1.208-3.173-2.513.45-.84.727-1.335.937-1.897.353-.975.458-1.568.593-2.498.27-1.837.277-3.607.765-5.167zm8.37.01a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.214-.705 1.214-1.89 0-.622-.127-1.125-.367-1.455a1.014 1.014 0 00-.855-.435zm4.08 0a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.215-.705 1.215-1.89 0-.622-.128-1.125-.368-1.455a1.014 1.014 0 00-.855-.435z"/>',
    tintable: true,
  },
};

// Legacy-kind fallback — older cached data.js versions ship creature ids like
// `octopus / crayfish / crab / tetra`. Remap to the current brand-mark ids so
// the correct SVG renders even if data.js is stale in the browser cache.
const LEGACY_KIND_MAP = {
  octopus: 'claudecode',
  crayfish: 'codex',
  crab: 'openclaw',
  tetra: 'opencode',
  // also accept agent-id style fallbacks
  'claude-code': 'claudecode',
  'claude code': 'claudecode',
  'kiro-cli': 'kiro',
  'kiro-ide': 'kiro',
};

function Creature({ kind, size = 20, color = 'currentColor', animate = false, state = 'idle' }) {
  const resolvedKind = CREATURE_SVGS[kind] ? kind : (LEGACY_KIND_MAP[kind] || kind);
  const spec = CREATURE_SVGS[resolvedKind];
  const wrapperStyle = {
    width: size,
    height: size,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    verticalAlign: 'middle',
    color, // drives currentColor
    flexShrink: 0,
  };
  const animStyle = animate
    ? {
        animation:
          state === 'processing' ? 'swim 2.4s ease-in-out infinite'
          : state === 'awaiting' ? 'wiggle 0.9s ease-in-out infinite'
          : 'bob 3.2s ease-in-out infinite',
        transformOrigin: 'center',
      }
    : {};

  if (!spec) {
    // unknown kind — render a neutral dot
    return (
      <span style={wrapperStyle}>
        <svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="12" cy="12" r="5" fill={color}/></svg>
      </span>
    );
  }

  return (
    <span style={{ ...wrapperStyle, ...animStyle }}>
      <svg
        viewBox={spec.viewBox}
        width="100%"
        height="100%"
        fill="currentColor"
        dangerouslySetInnerHTML={{ __html: spec.inner }}
      />
    </span>
  );
}

window.Creature = Creature;

// Shared gear icon for settings buttons — SVG instead of ⚙ emoji so it scales
// crisply and matches neutral palette.
function GearIcon({ size = 16, color = 'currentColor' }) {
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  );
}

window.GearIcon = GearIcon;
