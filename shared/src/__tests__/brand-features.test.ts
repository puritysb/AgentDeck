import { agentLogoIcon, agentGlyphMono } from '../svg-renderers/agent-logos.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { BRAND_FEATURES, creatureFeatureLayers, closedSvgSubpaths, featureRgbHex } from '../brand-features.js';
import { emitBrandFeatures, OUTPUT, sourcePaths } from '../../../scripts/generate-brand-features.mjs';
const root = fileURLToPath(new URL('../../..', import.meta.url));

describe('source-grounded creature feature semantics', () => {
  it('pins all canonical SVG bytes and generated Blender material selectors', () => {
    expect(readFileSync(root + '/' + OUTPUT, 'utf8')).toBe(emitBrandFeatures());
  });
  for (const [agent, definition] of Object.entries(BRAND_FEATURES.agents)) {
    it(`${agent} fills are independent of background and OpenCode is a true hole`, async () => {
      const paths = sourcePaths(readFileSync(root + '/' + definition.sourcePath, 'utf8'));
      const features = creatureFeatureLayers(agent as keyof typeof BRAND_FEATURES.agents, paths);
      const render = async (background: string) => {
        const layers = features.filter(f => f.mode === 'fill').map(f =>
          `<path fill="${featureRgbHex(f.rgb!)}" d="${f.paths.join(' ')}"/>`).join('');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="240" height="240"><rect width="24" height="24" fill="${background}"/><g fill="${featureRgbHex([176, 128, 96])}" fill-rule="evenodd">${paths.slice(agent === 'openclaw' ? 2 : 0).map(p => `<path d="${p}"/>`).join('')}</g>${layers}</svg>`;
        return sharp(Buffer.from(svg)).raw().toBuffer();
      };
      const a = await render(featureRgbHex([40, 73, 105])), b = await render(featureRgbHex([212, 231, 171]));
      const pixel = (buffer: Buffer, x: number, y: number) => [...buffer.subarray((y * 240 + x) * 4, (y * 240 + x) * 4 + 3)];
      const samples: Record<string, [number, number, number[]][]> = {
        claudecode: [[65, 94, [0, 0, 0]], [173, 94, [0, 0, 0]]],
        codex: [[79, 110, [255, 255, 255]], [150, 153, [255, 255, 255]]],
        openclaw: [[80, 81, [5, 8, 16]], [90, 76, [0, 229, 204]]],
        opencode: [[120, 120, []]],
      };
      for (const [x, y, rgb] of samples[agent]) {
        if (agent === 'opencode') {
          expect(pixel(a, x, y)).toEqual([40, 73, 105]);
          expect(pixel(b, x, y)).toEqual([212, 231, 171]);
        }
        else { expect(pixel(a, x, y)).toEqual(rgb); expect(pixel(b, x, y)).toEqual(rgb); }
      }
      if (agent === 'opencode') {
        const areas = paths[0].match(/[Mm][^Mm]*/g)!;
        expect(areas[0]).toContain('H8v12h8');
        expect(areas[1]).toContain('H4V2h16v20');
      }
    });
  }
});

it('compact feature masks stay cropped, bounded and source-grounded across 64/24/9/8 pixel surfaces', async () => {
  const { rasterizeFeatureLayers, cppFeatureLayers, emitBrowserFeatures } = await import('../../../scripts/creature-feature-masks.mjs');
  expect(readFileSync(root + '/tools/creature-simulator/brand-features.generated.js', 'utf8')).toBe(emitBrowserFeatures());
  let flashBytes = 0;
  for (const size of [64, 24, 9, 8]) for (const agent of Object.keys(BRAND_FEATURES.agents)) {
    const layers = await rasterizeFeatureLayers(agent, size);
    if (agent === 'opencode') { expect(layers).toEqual([]); continue; }
    for (const layer of layers) {
      expect(layer.x).toBeGreaterThanOrEqual(0); expect(layer.y).toBeGreaterThanOrEqual(0);
      expect(layer.x + layer.width).toBeLessThanOrEqual(size); expect(layer.y + layer.height).toBeLessThanOrEqual(size);
      expect(layer.alpha).toHaveLength(layer.width * layer.height);
      expect(layer.alpha.some((value: number) => value > 0)).toBe(true);
      expect(layer.monochrome).toBe(layer.monochromeCreature === 'paper' && agent === 'openclaw' ? 'ink' : 'paper');
      if (size === 64) flashBytes += layer.alpha.length;
    }
    if (size === 64) {
      const names: Record<string, string> = { claudecode: 'OCTOPUS', codex: 'CODEX', openclaw: 'OPENCLAW_MARK' };
      expect(readFileSync(root + '/esp32/src/ui/terrarium/creature_glyphs_generated.h', 'utf8')).toContain(cppFeatureLayers(names[agent], layers));
    }
    if (size === 8) {
      const names: Record<string, string> = { claudecode: 'CLAUDE_CODE', codex: 'CODEX', openclaw: 'OPEN_CLAW' };
      expect(readFileSync(root + '/esp32/src/ui/matrix/official_dot_glyphs_generated.h', 'utf8')).toContain(cppFeatureLayers(names[agent], layers));
    }
  }
  // Cropped feature alpha alone stays far below one extra full 64px mask.
  expect(flashBytes).toBeLessThan(64 * 64);
});


it('actual deck creature SVGs paint literal features over both backgrounds and preserve OpenCode alpha', async () => {
  const cases = [
    ['claude-code', 65, 94, [0, 0, 0]], ['codex-cli', 145, 147, [255, 255, 255]],
    ['openclaw', 83, 85, [5, 8, 16]], ['openclaw', 92, 80, [0, 229, 204]], ['opencode', 120, 120, null],
  ] as const;
  for (const [agent, x, y, feature] of cases) for (const background of [[40, 73, 105], [212, 231, 171]]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="${featureRgbHex(background)}"/>${agentLogoIcon(agent, 240, 1, 120, 120)}</svg>`;
    const rgba = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
    expect([...rgba.subarray((y * 240 + x) * 4, (y * 240 + x) * 4 + 3)]).toEqual(feature ?? background);
  }
});

it('large paper creatures honor black eyes while compact ink-body logos retain legibility', () => {
  const ink = featureRgbHex([0, 0, 0]), paper = featureRgbHex([255, 255, 255]);
  const large = agentGlyphMono('claude-code', 24, 24, 48, ink, paper);
  const tiny = agentGlyphMono('claude-code', 6, 6, 12, ink, paper);
  const eye = creatureFeatureLayers('claudecode', sourcePaths(readFileSync(root + '/design/brand/claudecode.svg', 'utf8')))[0].paths.join(' ');
  expect(large).toContain(`d="${eye}" fill="${ink}"`);
  expect(large).toContain(`fill="${paper}" fill-rule="evenodd" stroke="${ink}"`);
  expect(tiny).toContain(`d="${eye}" fill="${paper}"`);
  expect(agentGlyphMono('codex', 24, 24, 48, ink, paper)).toContain(`fill="${ink}" fill-rule="evenodd"`);
});


it('OpenCode selector is the contained smaller rectangle, not an outer fill', async () => {
  const svg = readFileSync(root + '/design/brand/opencode.svg', 'utf8');
  const paths = closedSvgSubpaths(sourcePaths(svg)[0]);
  const coverage = async (path: string) => {
    const data = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="240" height="240"><path d="${path}" fill="white"/></svg>`)).ensureAlpha().raw().toBuffer();
    const points = Array.from({ length: 240 * 240 }, (_, i) => i).filter(i => data[i * 4 + 3] === 255);
    return { area: points.length, minX: Math.min(...points.map(i => i % 240)), maxX: Math.max(...points.map(i => i % 240)), minY: Math.min(...points.map(i => Math.floor(i / 240))), maxY: Math.max(...points.map(i => Math.floor(i / 240))) };
  };
  const inner = await coverage(paths[0]), outer = await coverage(paths[1]);
  expect(inner.area).toBeLessThan(outer.area);
  expect(inner.minX).toBeGreaterThan(outer.minX); expect(inner.maxX).toBeLessThan(outer.maxX);
  expect(inner.minY).toBeGreaterThan(outer.minY); expect(inner.maxY).toBeLessThan(outer.maxY);
  expect(creatureFeatureLayers('opencode', sourcePaths(svg))[0].paths).toEqual([paths[0]]);
});

it('unknown creature identity never borrows another agent mark', () => {
  expect(agentGlyphMono('future-agent', 12, 12, 24, 'black', 'white')).toBe('');
  expect(agentLogoIcon('future-agent' as any, 48, 1)).toBe('');
});


it('OpenClaw feature colors come from the pinned original color reference, not inferred white', async () => {
  const { createHash } = await import('node:crypto');
  const definition = BRAND_FEATURES.agents.openclaw;
  const reference = readFileSync(root + '/' + definition.colorReference.sourcePath, 'utf8');
  expect(createHash('sha256').update(reference).digest('hex')).toBe(definition.colorReference.sourceHash);
  const source = [...reference.replace(/<defs\b[\s\S]*?<\/defs>/g, '').matchAll(/<path\b[^>]*>/g)];
  for (const role of ['eyes', 'eye-highlight'] as const) {
    const element = source[definition.colorReference.rolePathIndices[role]][0];
    const color = element.match(/fill="(#[A-Fa-f0-9]{6})"/)![1];
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    for (const feature of definition.features.filter(f => f.role === role)) expect(feature.rgb).toEqual(rgb);
  }
  expect(definition.features[0].monochromeCreature).toBe('ink');
  expect(definition.features[1].monochromeCreature).toBe('paper');
});

it('native vector/color/monochrome mirrors retain exact source feature contours', async () => {
  const { VECTOR_OUTPUTS, emitSwiftBrandFeatures, emitKotlinBrandFeatures } = await import('../../../scripts/generate-brand-features.mjs');
  expect(readFileSync(root + '/' + VECTOR_OUTPUTS.swift, 'utf8')).toBe(emitSwiftBrandFeatures());
  expect(readFileSync(root + '/' + VECTOR_OUTPUTS.kotlin, 'utf8')).toBe(emitKotlinBrandFeatures());
});
