import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { HERMES_MERMAID_2D } from '../../shared/src/svg-renderers/hermes-mermaid-2d.generated.js';

// The 2D mermaid is one geometry, generated outward to TS, Kotlin, C++ masks
// and Swift/TS dot-matrix masks. Hand edits to any output must fail here.
describe('Hermes 2D mermaid generator', () => {
  it('has every generated output in sync with the generator', () => {
    const run = spawnSync(process.execPath, ['scripts/generate-hermes-mermaid-2d.mjs', '--check'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('keeps the official Nous girl paths as the head, unmodified', () => {
    const svg = readFileSync('assets/terrarium/hermes-mermaid-2d.svg', 'utf8');
    const brand = readFileSync('design/brand/hermes.svg', 'utf8');
    for (const [, d] of brand.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)) expect(svg).toContain(`d="${d}"`);
  });

  it('places a tail below the bust instead of a floating head', () => {
    expect(HERMES_MERMAID_2D.viewBox[1]).toBeGreaterThan(24);
    expect(HERMES_MERMAID_2D.fade[1]).toBeLessThanOrEqual(24);
    expect(HERMES_MERMAID_2D.tail.length).toBeGreaterThan(100);
  });
});
