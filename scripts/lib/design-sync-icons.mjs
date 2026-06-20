// Shared by scripts/design-sync-gen.mjs and scripts/design-sync-previews.mjs.
// Single source of truth for the AgentDeck icon name set: the keys of the
// `window.AgentDeckIcons = { … }` export block in design/icons.jsx. Both the
// adapter generator and the preview generator derive names from the SOURCE
// (icons.jsx), not from a generated/gitignored artifact, so either script runs
// standalone on a fresh clone and in any order.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read design/icons.jsx and return its exported `Icon*` names, sorted unique. */
export function extractIconNames(root) {
  const src = readFileSync(join(root, 'design/icons.jsx'), 'utf8');
  const block = src.match(/window\.AgentDeckIcons\s*=\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error('design/icons.jsx: could not find the `window.AgentDeckIcons = { … }` export block');
  const names = [...new Set([...block[1].matchAll(/\b(Icon[A-Za-z0-9]+)\b/g)].map((m) => m[1]))].sort();
  if (!names.length) throw new Error('design/icons.jsx: export block contained no Icon* names');
  return names;
}
