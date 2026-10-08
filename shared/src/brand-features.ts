/** Creature feature materials over unchanged upstream SVG geometry.
 * The explicit black/white user fidelity requirement is a brand exception.
 * Ordinary monochrome UI logos retain their upstream alpha contract.
 * OpenClaw eye/glint colors are pinned to its original upstream color asset.
 * On an ink-filled 1-bit body, paper eyes/prompt and ink glints retain source
 * feature separation; this is a distinct monochrome adaptation, not color RGB. */
export const BRAND_FEATURES = {
  schema: 'agentdeck.brand-features/v1',
  // Small monochrome UI marks retain the ink-body inverse-contrast mapping.
  // Actual creatures at/above this size honor black eyes on a light outlined body.
  monochromeCreature: { minSize: 24, outlineWidth: 0.4, lightBodyAgents: ['claudecode', 'openclaw'] },
  agents: {
    claudecode: { sourcePath: 'design/brand/claudecode.svg', sourceHash: 'd7eb2d876b49e51cc16291a42b681d7cf4906e60e0150776dbfb353ec4ca3746',
      features: [{ role: 'eyes', mode: 'fill', monochrome: 'paper', monochromeCreature: 'ink', rgb: [0, 0, 0], pathIndex: 0, subpathIndices: [1, 2] }] },
    codex: { sourcePath: 'design/brand/codex.svg', sourceHash: 'd08b4e824cd6727e89617f59e4737273ff53e44c1da849d016dd64dfd08b33e1',
      features: [{ role: 'prompt', mode: 'fill', monochrome: 'paper', monochromeCreature: 'paper', rgb: [255, 255, 255], pathIndex: 0, subpathIndices: [1, 2] }] },
    openclaw: { colorReference: { sourcePath: 'design/brand/openclaw-color.svg', sourceHash: '4123c0c75dda5b28e3e0d38075514085bf546178a620776344813c08fa41277c', rolePathIndices: { eyes: 4, 'eye-highlight': 5 } }, sourcePath: 'design/brand/openclaw.svg', sourceHash: '1f0b18833ccb1c7c21ae998d237856975fc90eb8eafc14f8db05198628e8da4d',
      features: [
        { role: 'eyes', mode: 'fill', monochrome: 'paper', monochromeCreature: 'ink', rgb: [5, 8, 16], pathIndex: 2, subpathIndices: [1, 2] },
        { role: 'eye-highlight', mode: 'fill', monochrome: 'ink', monochromeCreature: 'paper', rgb: [0, 229, 204], pathIndex: 0, subpathIndices: [0] },
        { role: 'eye-highlight', mode: 'fill', monochrome: 'ink', monochromeCreature: 'paper', rgb: [0, 229, 204], pathIndex: 1, subpathIndices: [0] },
      ] },
    opencode: { sourcePath: 'design/brand/opencode.svg', sourceHash: '7cfa6e9d6726f7c9fa26c7d9aef0dfec52d20a137380454340f30f12ccbfd302',
      features: [{ role: 'center', mode: 'hole', monochrome: 'hole', monochromeCreature: 'hole', rgb: null, pathIndex: 0, subpathIndices: [0] }] },
  },
} as const;

export type CreatureFeatureAgent = keyof typeof BRAND_FEATURES.agents;

/** Each canonical subpath is closed. Its following relative m is relative to
 * the previous closed start, not the origin of an independently drawn layer. */
export function closedSvgSubpaths(path: string): string[] {
  const pieces = path.match(/[Mm][^Mm]*/g) ?? [];
  let x = 0, y = 0;
  return pieces.map(piece => {
    if (!/[zZ]\s*$/.test(piece)) throw new Error('Creature feature source must use closed subpaths');
    const numbers = [...piece.slice(1).matchAll(/[-+]?(?:\d*\.?\d+)(?:[eE][-+]?\d+)?/g)];
    if (numbers.length < 2) throw new Error('Missing SVG subpath origin');
    x = Number(numbers[0][0]) + (piece[0] === 'm' ? x : 0);
    y = Number(numbers[1][0]) + (piece[0] === 'm' ? y : 0);
    const end = 1 + numbers[1].index! + numbers[1][0].length;
    const coord = (value: number) => String(Number(value.toFixed(6)));
    return `M${coord(x)} ${coord(y)}${piece.slice(end)}`;
  });
}

export function creatureFeatureLayers(agent: CreatureFeatureAgent, paths: readonly string[]) {
  return BRAND_FEATURES.agents[agent].features.map(feature => ({ ...feature,
    paths: feature.subpathIndices.map(index => {
      const path = closedSvgSubpaths(paths[feature.pathIndex] ?? '')[index];
      if (!path) throw new Error(`Missing ${agent} ${feature.role} source contour ${index}`);
      return path;
    }),
  }));
}

export function featureRgbHex(rgb: readonly number[]): string {
  return '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('');
}
