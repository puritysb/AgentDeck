#!/usr/bin/env node
// design-sync-previews.mjs — author preview cards for the AgentDeck icon set.
//
// The icons are a homogeneous line-icon family, so the preview composition is
// uniform: a size sweep and a token-palette sweep, both wrapped in `.ad-body`
// so the design system's fonts/tokens apply. Output is one `<Icon>.tsx` per
// icon under `.design-sync/previews/` (authored files — no generated marker;
// hand-edit freely, but re-running this overwrites). Each named export is one
// graded card cell.
//
// Run from the repo root:  node scripts/design-sync-previews.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.design-sync/previews');
mkdirSync(OUT, { recursive: true });

const names = JSON.parse(readFileSync(join(ROOT, '_ds_gen/icon-names.json'), 'utf8'));

const tpl = (name) => `// Authored preview for ${name}. Cells: size sweep + token palette.
import React from 'react';
import { ${name} } from 'AgentDeck';

const row: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  background: 'var(--tide-50)',
  color: 'var(--ink-900)',
  padding: '22px 26px',
  display: 'flex',
  gap: 30,
  alignItems: 'flex-end',
};
const cell: React.CSSProperties = {
  display: 'grid',
  gap: 9,
  justifyItems: 'center',
  fontSize: 11,
  letterSpacing: '0.02em',
  color: 'var(--ink-500)',
};

export const Sizes = () => (
  <div className="ad-body" style={row}>
    {[16, 24, 32, 48].map((s) => (
      <div key={s} style={cell}>
        <${name} size={s} />
        <span>{s}px</span>
      </div>
    ))}
  </div>
);

export const Palette = () => (
  <div className="ad-body" style={row}>
    {([
      ['ink', 'var(--ink-900)'],
      ['kelp', 'var(--kelp-500)'],
      ['coral', 'var(--coral-500)'],
      ['amber', 'var(--amber-500)'],
    ] as const).map(([label, color]) => (
      <div key={label} style={cell}>
        <${name} size={34} color={color} />
        <span>{label}</span>
      </div>
    ))}
  </div>
);
`;

for (const n of names) writeFileSync(join(OUT, `${n}.tsx`), tpl(n));
console.error(`✓ wrote ${names.length} preview cards → .design-sync/previews/`);
