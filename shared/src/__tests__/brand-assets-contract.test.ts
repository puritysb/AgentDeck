import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_PATH,
  CLAUDE_LOGO_PATH,
  CODEX_LOGO_PATH,
  OPENCODE_RING_PATH,
  OPENCLAW_LOGO_PATHS,
  ROBOT_CREATURE_PATH,
  agentGlyphMono,
  agentLogoIcon,
  agentLogoWatermark,
} from '../svg-renderers/agent-logos.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (relative: string) => readFileSync(`${root}/${relative}`, 'utf8');

const canonicalPaths = {
  claudeCode: [ROBOT_CREATURE_PATH],
  codex: [CODEX_LOGO_PATH],
  openClaw: OPENCLAW_LOGO_PATHS,
  openCode: [OPENCODE_RING_PATH],
  antigravity: [ANTIGRAVITY_PATH],
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
    for (const stem of ['claudecode', 'codex', 'openclaw', 'opencode', 'antigravity']) {
      for (const generator of generators) expect(generator).toContain(stem);
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

  it('does not reuse another agent mark for Hermes', () => {
    expect(agentGlyphMono('hermes', 12, 12, 24, '#fff', '#000')).toBe('');
    expect(agentLogoIcon('hermes')).toBe('');
    expect(agentLogoWatermark('hermes')).toBe('');
  });
});
