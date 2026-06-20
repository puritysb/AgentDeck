// Authored preview for IconSparkle. Cells: size sweep + token palette.
import React from 'react';
import { IconSparkle } from 'AgentDeck';

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
        <IconSparkle size={s} />
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
        <IconSparkle size={34} color={color} />
        <span>{label}</span>
      </div>
    ))}
  </div>
);
