/** Linear scans for delimiters in untrusted agent/model output. */
export function trimCharacters(text: string, leading: string, trailing = leading): string {
  let start = 0, end = text.length;
  while (start < end && leading.includes(text[start])) start += 1;
  while (end > start && trailing.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

export function firstTagContent(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const end = text.indexOf(close, start + open.length);
  return end < 0 ? undefined : text.slice(start + open.length, end);
}

export function stripThinkBlocks(text: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('<think>', cursor);
    if (start < 0) { pieces.push(text.slice(cursor)); break; }
    pieces.push(text.slice(cursor, start));
    const end = text.indexOf('</think>', start + 7);
    if (end < 0) break;
    cursor = end + 8;
  }
  return pieces.join('');
}

export function stripCodeFences(text: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('```', cursor);
    if (start < 0) { pieces.push(text.slice(cursor)); break; }
    const end = text.indexOf('```', start + 3);
    if (end < 0) { pieces.push(text.slice(cursor)); break; }
    pieces.push(text.slice(cursor, start));
    let body = start + 3;
    while (body < end && /[A-Za-z0-9_]/.test(text[body])) body += 1;
    if (text[body] === '\n') body += 1;
    pieces.push(text.slice(body, end));
    cursor = end + 3;
  }
  return pieces.join('');
}

/** Prefix and suffix must start on the same line; suffix may contain whitespace. */
export function hasOrderedTerms(text: string, prefix: RegExp, suffix: RegExp): boolean {
  const left = new RegExp(prefix.source, prefix.flags.replace(/[gy]/g, '') + 'g');
  const right = new RegExp(suffix.source, suffix.flags.replace(/[gy]/g, '') + 'g');
  let end = right.exec(text);
  for (let start = left.exec(text); start && end; start = left.exec(text)) {
    const after = start.index + start[0].length;
    while (end && end.index < after) end = right.exec(text);
    if (!end) return false;
    let separator = after;
    while (separator < end.index && !'\r\n\u2028\u2029'.includes(text[separator])) separator += 1;
    if (separator === end.index) return true;
    // Skip the rest of this line, retaining the already-found suffix.
    left.lastIndex = separator + 1;
  }
  return false;
}
