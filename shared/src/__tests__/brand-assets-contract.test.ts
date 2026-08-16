import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_PATH,
  CLAUDE_LOGO_PATH,
  CODEX_LOGO_PATH,
  KIRO_GHOST_PATH,
  OPENCODE_RING_PATH,
  OPENCLAW_LOGO_PATHS,
  ROBOT_CREATURE_PATH,
} from '../svg-renderers/agent-logos.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (relative: string) => readFileSync(`${root}/${relative}`, 'utf8');

const canonicalPaths = {
  claudeCode: [ROBOT_CREATURE_PATH],
  codex: [CODEX_LOGO_PATH],
  openClaw: OPENCLAW_LOGO_PATHS,
  openCode: [OPENCODE_RING_PATH],
  antigravity: [ANTIGRAVITY_PATH],
  kiro: [KIRO_GHOST_PATH],
};

describe('canonical agent brand assets', () => {
  it('keeps the Claude compatibility export on the Claude Code robot mark', () => {
    expect(CLAUDE_LOGO_PATH).toBe(ROBOT_CREATURE_PATH);
  });

  it.each([
    ['claudecode.svg', canonicalPaths.claudeCode],
    ['codex.svg', canonicalPaths.codex],
    ['openclaw.svg', canonicalPaths.openClaw],
    ['opencode.svg', canonicalPaths.openCode],
    ['antigravity.svg', canonicalPaths.antigravity],
    ['kiro.svg', canonicalPaths.kiro],
  ])('%s is the geometry used by shared renderers', (filename, paths) => {
    const svg = read(`design/brand/${filename}`);
    for (const path of paths) expect(svg).toContain(`d="${path}"`);
  });

  it('mirrors every canonical path on Android and Apple vector surfaces', () => {
    const surfaces = [
      read('android/app/src/main/kotlin/dev/agentdeck/ui/component/BrandIcon.kt'),
      read('android/app/src/main/kotlin/dev/agentdeck/terrarium/CreatureGeometry.kt'),
      read('apple/AgentDeck/UI/Common/SessionBrand.swift'),
      read('apple/AgentDeck/Rendering/CreatureGeometry.swift'),
    ];
    for (const paths of Object.values(canonicalPaths)) {
      for (const path of paths) {
        for (const surface of surfaces) expect(surface).toContain(path);
      }
    }
  });

  it('generates constrained-device masks directly from canonical SVG files', () => {
    const generators = [
      read('scripts/generate-creature-glyphs.mjs'),
      read('scripts/generate-micro-glyphs.mjs'),
    ];
    for (const stem of ['claudecode', 'codex', 'openclaw', 'opencode', 'antigravity', 'kiro']) {
      for (const generator of generators) expect(generator).toContain(stem);
    }
  });

  // Pinned per mark rather than for Kiro alone. The table used to carry one row
  // and this test enforced exactly that row, which is how five marks shipped for
  // months with no recorded source while the sixth read as the one with a
  // licensing question. They come from one MIT package; the contract is that
  // none of them may ship without its source and holder written down.
  it('records the upstream source and trademark holder for every agent mark', () => {
    const resources = read('design/RESOURCES.md');
    expect(resources).toContain('@lobehub/icons-static-svg@1.94.0');
    // The integrity hash is what makes "upstream geometry" checkable later.
    expect(resources).toContain('sha512-Inx1TYkjLH6YeHOIHeVW9+OM/xxRnk8TmcQVKquFUDBmE3X9sUuRGt7kALrrDBNNAbrWz7Qq6fAiFj9E9Mmw9Q==');
    for (const [stem, holder] of [
      ['claudecode', 'Anthropic'],
      ['codex', 'OpenAI'],
      ['antigravity', 'Google'],
      ['kiro', 'Amazon.com, Inc. or its affiliates'],
      ['opencode', 'the opencode project'],
      ['openclaw', 'the OpenClaw project'],
    ] as const) {
      expect(resources).toContain(`icons/${stem}.svg`);
      expect(resources).toContain(holder);
    }
  });

  it('does not retain alternate logo-source dumps', () => {
    expect(existsSync(`${root}/assets/logos`)).toBe(false);
    expect(existsSync(`${root}/assets/creatures`)).toBe(false);
    for (const imageset of [
      'CreatureClaudeCode',
      'CreatureCodex',
      'CreatureOpenClaw',
      'CreatureOpenCode',
      'BrandOpenAI',
    ]) {
      expect(existsSync(`${root}/apple/AgentDeck/Resources/Assets.xcassets/${imageset}.imageset`)).toBe(false);
    }
  });
});
