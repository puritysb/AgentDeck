#!/usr/bin/env node
// Native Dashboard palette ratchet.
//
// design/lint.sh only reads web files (html/css/js/jsx), so the Swift, Kotlin
// and ESP32 C++ dashboards could add raw colours without any gate — which is
// how the same "working" session came to be green, blue or teal depending on
// the screen. This counts raw colour literals per file in the Dashboard
// directories and fails when any file gains one. Counts may only go down;
// `--write` records the new floor in design/native-palette-baseline.json.
//
// A raw colour belongs in design/tokens.css (then a mirror / generated file),
// not in a view. Token binding files and generated mirrors are exempt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = 'design/native-palette-baseline.json';

/** Dashboard-rendering directories, by language. */
export const SCOPES = [
  { lang: 'swift', dirs: ['apple/AgentDeck/UI/Monitor', 'apple/AgentDeck/UI/MenuBar', 'apple/AgentDeck/UI/Common', 'apple/AgentDeck/UI/Shared'] },
  { lang: 'kotlin', dirs: ['android/app/src/main/kotlin/dev/agentdeck/ui/monitor', 'android/app/src/main/kotlin/dev/agentdeck/ui/component', 'android/app/src/main/kotlin/dev/agentdeck/ui/common', 'android/app/src/main/kotlin/dev/agentdeck/ui/theme', 'android/app/src/main/kotlin/dev/agentdeck/ui/eink'] },
  { lang: 'cpp', dirs: ['esp32/src/ui/widgets', 'esp32/src/ui/ticker', 'esp32/src/ui/pocket', 'esp32/src/ui/knob', 'esp32/src/ui/screens', 'esp32/src/ui/eink', 'esp32/src/ui/companion'], files: ['esp32/src/ui/theme.h'] },
];

/** Token bindings and generated mirrors are where literals are supposed to live. */
const EXEMPT = new Set([
  'apple/AgentDeck/UI/Common/DesignTokens.swift',
  'android/app/src/main/kotlin/dev/agentdeck/ui/theme/DesignTokens.kt',
]);

const EXT = { swift: ['.swift'], kotlin: ['.kt'], cpp: ['.cpp', '.h'] };

const SYSTEM_HUES = 'red|orange|yellow|green|mint|teal|cyan|blue|indigo|purple|pink|brown|gray|grey';
const PATTERNS = {
  swift: [
    /\bColor\(\s*(?:red|hex|white|\.sRGB)\s*:/g,
    /\b(?:NS|UI)Color\(\s*(?:red|calibratedRed|srgbRed|white)\s*:/g,
    new RegExp(`\\bColor\\.(?:${SYSTEM_HUES})\\b`, 'g'),
    new RegExp(`\\.(?:foregroundStyle|foregroundColor|fill|tint|background|stroke)\\(\\s*\\.(?:${SYSTEM_HUES})\\b`, 'g'),
  ],
  kotlin: [/\bColor\(\s*0x[0-9A-Fa-f]{6,8}\b/g],
  // Six-digit hex outside the generated palette: in this UI code these are colours.
  cpp: [/\b0x[0-9A-Fa-f]{6}\b/g],
};

/** Drops block and line comments — a hex value quoted in a comment is not a colour in use. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function walk(dir, exts, acc) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.includes('.generated.') && !entry.name.includes('_generated')) acc.push(rel);
  }
  return acc;
}

export function measure() {
  const counts = {};
  for (const scope of SCOPES) {
    const files = scope.dirs.flatMap((d) => walk(d, EXT[scope.lang], [])).concat(scope.files ?? []);
    for (const file of files) {
      if (EXEMPT.has(file)) continue;
      const text = stripComments(fs.readFileSync(path.join(root, file), 'utf8'));
      const n = PATTERNS[scope.lang].reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
      if (n > 0) counts[file.split(path.sep).join('/')] = n;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function readBaseline() {
  return JSON.parse(fs.readFileSync(path.join(root, BASELINE), 'utf8')).files;
}

/** Files whose raw-colour count grew (or that are new with any). */
export function regressions(current, baseline) {
  return Object.entries(current)
    .filter(([file, n]) => n > (baseline[file] ?? 0))
    .map(([file, n]) => ({ file, baseline: baseline[file] ?? 0, current: n }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = measure();
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(root, BASELINE), JSON.stringify({
      note: 'Raw colour literals per native Dashboard file. May only go down. Regenerate with `node scripts/check-native-palette.mjs --write` after removing literals.',
      total,
      files: current,
    }, null, 2) + '\n');
    console.log(`native palette baseline written: ${total} literals in ${Object.keys(current).length} files`);
  } else {
    const bad = regressions(current, readBaseline());
    for (const r of bad) console.error(`✘ ${r.file}: ${r.baseline} → ${r.current} raw colour literals (use a design token)`);
    console.log(`native palette: ${total} raw colour literals (${bad.length ? 'REGRESSED' : 'within baseline'})`);
    process.exit(bad.length ? 1 : 0);
  }
}
