/**
 * What a spoken reply should actually say.
 *
 * SSOT for both daemons: the Node daemon imports these, and
 * `DaemonServer.speakableReply` / `.spokenDigest` in the Swift daemon mirror
 * them (parity cases in `SPOKEN_DIGEST_CASES` below are asserted on both sides).
 *
 * The distinction that matters: `speakableReply` decides *what is readable*
 * (strip code fences, markdown scaffolding, URLs), while `spokenDigest` decides
 * *how much to read*. A written answer and a spoken one are different artifacts
 * — a 700-character reply is a fine thing to read on screen and a monologue
 * through a speaker, and the listener cannot skim it. So speech gets the lead:
 * an explicit summary line when the answer has one, otherwise its first
 * sentence. The full text stays on the deck and in the terminal, where skimming
 * works.
 */

/** A spoken reply past this is a monologue, not an answer. Truncated at a
 *  sentence boundary when one is near the cap. */
export const MAX_SPOKEN_CHARS = 700;

/** Ceiling for the digest. Reached only by a single very long sentence — the
 *  first-sentence rule normally lands far below it. */
export const SPOKEN_DIGEST_MAX_CHARS = 240;

/**
 * Openers that mark an author-written summary. Matched at the start of a line,
 * with or without a separator, in both languages the replies come in.
 */
const SUMMARY_LABELS = [
  '요약', '한 줄 요약', '한줄 요약', '결론', '정리',
  'TL;DR', 'TLDR', 'Summary', 'In short', 'In summary', 'Bottom line',
];

/** Sentence enders, including the CJK forms. */
const TERMINATORS = new Set(['.', '!', '?', '。', '！', '？', '…']);

/**
 * Strip what makes no sense read aloud and cap at a sentence boundary.
 * Kept separate from the digest so callers that genuinely want the whole answer
 * (a board with a screen, a test) can still get it.
 */
export function speakableReply(raw: string, maxChars = MAX_SPOKEN_CHARS): string {
  if (!raw) return '';
  let text = raw
    // Fenced blocks read as noise; say so once instead of reciting them.
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/^\s*(?:#{1,6}|>|[*\-+])\s+/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (!text) return '';
  if (text.length > maxChars) {
    const head = text.slice(0, maxChars);
    // Prefer ending on a sentence so the cut doesn't sound like a dropout.
    const lastStop = Math.max(
      head.lastIndexOf('. '), head.lastIndexOf('。'),
      head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('다.'),
    );
    text = lastStop > maxChars * 0.5 ? head.slice(0, lastStop + 1) : head;
  }
  return text.trim();
}

/** True when a line ends a sentence — the cheap test for "prose, not a heading". */
function hasTerminator(line: string): boolean {
  for (const ch of line) if (TERMINATORS.has(ch)) return true;
  return false;
}

/**
 * The summary a line declares, or null. `요약: 고쳤습니다` yields the remainder;
 * a bare `요약` line yields '' so the caller can take the line after it.
 */
function summaryOnLine(line: string): string | null {
  for (const label of SUMMARY_LABELS) {
    if (!line.toLowerCase().startsWith(label.toLowerCase())) continue;
    const afterLabel = line.slice(label.length);
    const rest = afterLabel.replace(/^\s*[:：\-—–.]\s*/, '').trim();
    // "Summarywise …" and "요약 대신 …" are prose, not labels; require a
    // separator (or end of line) before treating the remainder as the summary.
    if (rest === afterLabel.trim() && rest !== '' && /^[\p{L}\p{N}_]/u.test(rest)) {
      continue;
    }
    return rest;
  }
  return null;
}

/**
 * The first sentence of `text`, or all of it when it has no terminator.
 * Returns the substring rather than an index so the Swift mirror (which counts
 * Characters, not UTF-16 units) cannot cut a surrogate pair differently.
 */
function firstSentence(text: string): string {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    if (!TERMINATORS.has(chars[i])) continue;
    const next = chars[i + 1];
    // "1.0" and "v1.2.3" are not sentence ends; a terminator only counts when
    // what follows is nothing, whitespace, or a closing mark.
    if (chars[i] === '.' && /\d/.test(chars[i - 1] ?? '') && /\d/.test(next ?? '')) continue;
    if (next === undefined || /[\s"'”’)\]]/.test(next)) {
      // Run out any repeated terminators ("!?", "...") so they stay together.
      let end = i + 1;
      while (end < chars.length && TERMINATORS.has(chars[end])) end += 1;
      return chars.slice(0, end).join('');
    }
  }
  return text;
}

/**
 * The one thing worth reading aloud out of a full reply: an explicit summary
 * line if the answer has one, otherwise its first sentence.
 *
 * `full: true` restores the whole readable answer for callers that opted out
 * (daemon setting `voice.speakFullReply`).
 */
export function spokenDigest(
  raw: string,
  opts: { maxChars?: number; full?: boolean } = {},
): string {
  const readable = speakableReply(raw, opts.full ? MAX_SPOKEN_CHARS : Number.MAX_SAFE_INTEGER);
  if (!readable) return '';
  if (opts.full) return readable;

  const cap = opts.maxChars ?? SPOKEN_DIGEST_MAX_CHARS;
  const lines = readable.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  let unit = '';
  for (let i = 0; i < lines.length; i += 1) {
    const summary = summaryOnLine(lines[i]);
    if (summary === null) continue;
    unit = summary || lines[i + 1] || '';
    if (unit) break;
  }

  if (!unit) {
    // Skip a leading section label ("원인", "Result") when prose follows it:
    // reading a heading alone tells the listener nothing.
    let start = 0;
    while (start < lines.length - 1 && !hasTerminator(lines[start]) && lines[start].length <= 24) {
      start += 1;
    }
    unit = firstSentence(lines[start] ?? '');
  }

  unit = unit.trim();
  if (!unit) return '';
  if (unit.length <= cap) return unit;
  // A single sentence over the cap: cut on a word boundary, not mid-word.
  const head = unit.slice(0, cap);
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > cap * 0.6 ? head.slice(0, lastSpace) : head).trim();
}

/**
 * Cross-surface parity table. Asserted by vitest against `spokenDigest` and by
 * XCTest against the Swift mirror, so the two daemons cannot drift into
 * speaking different amounts of the same reply.
 */
export const SPOKEN_DIGEST_CASES: ReadonlyArray<{
  name: string; input: string; expected: string;
}> = [
  {
    name: 'first sentence only, not the whole paragraph',
    input: '원인을 찾았습니다. 헬퍼 바이너리에 Info.plist가 없었습니다. 지금은 고쳤습니다.',
    expected: '원인을 찾았습니다.',
  },
  {
    name: 'explicit summary label wins over the opening sentence',
    input: 'VOICE 키가 죽어 있었습니다. 원인은 TCC입니다.\n요약: 헬퍼를 재빌드하면 동작합니다.',
    expected: '헬퍼를 재빌드하면 동작합니다.',
  },
  {
    name: 'bare summary label takes the line after it',
    input: 'TL;DR\nThe helper needed a usage description.\nDetails follow.',
    expected: 'The helper needed a usage description.',
  },
  {
    name: 'a heading-only first line is skipped for the prose under it',
    input: '## 원인\n번들 헬퍼에 Info.plist가 없었습니다. 그래서 TCC가 죽였습니다.',
    expected: '번들 헬퍼에 Info.plist가 없었습니다.',
  },
  {
    name: 'code fences never get recited',
    input: 'Fixed it.\n\n```ts\nconst x = 1;\n```\n',
    expected: 'Fixed it.',
  },
  {
    name: 'a version number does not end the sentence',
    input: 'Bumped it to 1.0.2 for the release. Nothing else changed.',
    expected: 'Bumped it to 1.0.2 for the release.',
  },
  {
    name: 'nothing speakable stays empty',
    input: '```\ndiff --git a b\n```',
    expected: '(code)',
  },
];
