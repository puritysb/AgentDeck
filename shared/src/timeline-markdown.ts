/**
 * Lightweight markdown parser for timeline detail panes.
 *
 * Output is a flat array of typed lines that each platform renders natively
 * (SwiftUI / Compose). Pure data — no rendering. Mirrors the Apple parser at
 * apple/AgentDeck/UI/Monitor/TimelineStripView.swift `TimelineMarkdownLine`
 * and the Android port at
 * android/.../ui/timeline/TimelineMarkdown.kt — keep the three in lockstep.
 *
 * Block grammar (line-oriented):
 *   - ``` toggles a code fence; lines inside become `code` (verbatim, no inline parsing)
 *   - empty / whitespace-only line → `blank`
 *   - 1-6 leading hashes + space → `heading` (level 1-6; CommonMark ATX)
 *   - `- ` or `* ` → `bullet`
 *   - `<digits>.` or `<digits>)` followed by space → `numbered`
 *   - `> ` → `quote`
 *   - `|...|` (with optional `|---|` separator) → `table` block
 *   - anything else → `text`
 *
 * Inline grammar (per `parseInlineSpans`, applied at render time to non-code
 * line content + table cells; first-match-wins, no recursion):
 *   - `` `code` `` → `code` span
 *   - `**bold**`   → `bold` span
 *   - `*italic*`   → `italic` span (only when not adjacent to another `*`)
 *   - `[text](href)` → `link` span
 *   - everything else → `plain` span
 */

export type MarkdownLine =
  | { kind: 'blank' }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: string }
  | { kind: 'bullet'; content: string }
  | { kind: 'numbered'; marker: string; content: string }
  | { kind: 'quote'; content: string }
  | { kind: 'code'; content: string }
  | { kind: 'text'; content: string }
  | { kind: 'table'; rows: string[][]; hasHeader: boolean };

export type InlineSpan =
  | { kind: 'plain'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export function parseTimelineMarkdown(text: string): MarkdownLine[] {
  if (!text) return [];
  const out: MarkdownLine[] = [];
  let inCodeFence = false;
  const lines = text.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      i += 1;
      continue;
    }
    if (inCodeFence) {
      out.push({ kind: 'code', content: rawLine });
      i += 1;
      continue;
    }
    if (trimmed.length === 0) {
      out.push({ kind: 'blank' });
      i += 1;
      continue;
    }

    // Table block: current line looks like `|...|`. Optional separator on
    // next line marks the previous row as header. Continue collecting rows
    // while subsequent lines are also table-rows.
    if (isTableRow(trimmed)) {
      const rows: string[][] = [splitCells(trimmed)];
      let hasHeader = false;
      let j = i + 1;
      if (j < lines.length && isTableSeparator(lines[j].trim())) {
        hasHeader = true;
        j += 1;
      }
      while (j < lines.length) {
        const nextTrimmed = lines[j].trim();
        if (!isTableRow(nextTrimmed) || isTableSeparator(nextTrimmed)) break;
        rows.push(splitCells(nextTrimmed));
        j += 1;
      }
      out.push({ kind: 'table', rows, hasHeader });
      i = j;
      continue;
    }

    const heading = parseHeading(trimmed);
    if (heading) {
      out.push({ kind: 'heading', level: heading.level, content: heading.content });
      i += 1;
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      out.push({ kind: 'bullet', content: trimmed.slice(2) });
      i += 1;
      continue;
    }

    const numbered = parseNumbered(trimmed);
    if (numbered) {
      out.push({ kind: 'numbered', marker: numbered.marker, content: numbered.content });
      i += 1;
      continue;
    }

    if (trimmed.startsWith('> ')) {
      out.push({ kind: 'quote', content: trimmed.slice(2) });
      i += 1;
      continue;
    }

    out.push({ kind: 'text', content: rawLine });
    i += 1;
  }

  return out.length === 0 ? [{ kind: 'text', content: text }] : out;
}

/**
 * Tokenize a single line of inline content into spans. First-match-wins
 * left-to-right walker; never recurses (so e.g. `**bold *with italic***` is
 * just bold + plain — keeps the implementation simple and the platform ports
 * trivial). Always returns at least one span; empty input → empty array.
 */
export function parseInlineSpans(text: string): InlineSpan[] {
  if (!text) return [];
  const out: InlineSpan[] = [];
  let pending = ''; // buffered plain text waiting to flush
  const flushPlain = () => {
    if (pending.length > 0) {
      out.push({ kind: 'plain', text: pending });
      pending = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // `code`
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i) {
        flushPlain();
        out.push({ kind: 'code', text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    // **bold**
    if (ch === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close > i + 1) {
        flushPlain();
        out.push({ kind: 'bold', text: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }

    // *italic* — single `*`, not surrounded by another `*`
    if (
      ch === '*' &&
      text[i + 1] !== '*' &&
      (i === 0 || text[i - 1] !== '*')
    ) {
      // Find a closing single `*` that isn't doubled.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '*' && text[j + 1] !== '*' && text[j - 1] !== '*') break;
        j += 1;
      }
      if (j < text.length && j > i + 1) {
        flushPlain();
        out.push({ kind: 'italic', text: text.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }

    // [text](href)
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket > i && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket + 1) {
          const linkText = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen);
          flushPlain();
          out.push({ kind: 'link', text: linkText, href });
          i = closeParen + 1;
          continue;
        }
      }
    }

    pending += ch;
    i += 1;
  }
  flushPlain();
  return out.length === 0 ? [{ kind: 'plain', text }] : out;
}

function parseHeading(trimmed: string): { level: 1 | 2 | 3 | 4 | 5 | 6; content: string } | null {
  let level = 0;
  for (const ch of trimmed) {
    if (ch === '#') level += 1;
    else break;
  }
  if (level < 1 || level > 6) return null;
  if (trimmed.charAt(level) !== ' ') return null;
  return { level: level as 1 | 2 | 3 | 4 | 5 | 6, content: trimmed.slice(level + 1) };
}

function parseNumbered(trimmed: string): { marker: string; content: string } | null {
  const m = trimmed.match(/^(\d+[.)])\s/);
  if (!m) return null;
  const content = trimmed.slice(m[0].length).trimStart();
  if (/[\r\n\u2028\u2029]/.test(content)) return null;
  return { marker: m[1], content };
}

// ---- Table helpers ----

const TABLE_ROW_RE = /^\s*\|.+\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|[-:\s|]+\|\s*$/;

function isTableRow(trimmed: string): boolean {
  return TABLE_ROW_RE.test(trimmed) && !isTableSeparator(trimmed);
}

function isTableSeparator(trimmed: string): boolean {
  if (!TABLE_SEPARATOR_RE.test(trimmed)) return false;
  // Must contain at least one dash to be a real separator (not just `| | |`).
  return /-/.test(trimmed);
}

function splitCells(rowLine: string): string[] {
  return rowLine
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}
