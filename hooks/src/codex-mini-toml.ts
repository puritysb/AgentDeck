// codex-mini-toml.ts — minimal lossless TOML editor for ~/.codex/config.toml.
//
// Direct port of apple/AgentDeck/Daemon/Core/MiniToml.swift. Must stay
// byte-compatible: the fence sentinels are shared between the App Store
// Swift daemon and the Node CLI bridge so a config installed by either
// side can be uninstalled / re-applied by the other.
//
// We deliberately do NOT parse TOML semantically. Codex configs contain
// user-authored keys, comments, profile tables, and MCP server tables that
// we have no business round-tripping through a semantic serializer.
// AgentDeck-managed entries live inside a fenced block:
//
//     # >>> AgentDeck managed (do not edit) <<<
//     <our keys>
//     # <<< AgentDeck managed (do not edit) >>>
//
// applyManagedBlock replaces (or appends) the fence; removeManagedBlock
// removes owned entries and retains later user additions. Outside text is preserved.

export const OPEN_FENCE = '# >>> AgentDeck managed (do not edit) <<<';
export const CLOSE_FENCE = '# <<< AgentDeck managed (do not edit) >>>';

/** Lossless editing is intentionally conservative: never guess the scope of
 * multiline strings, damaged fences, or quoted/dotted integration keys. */
export function configEditIssue(text: string): string | undefined {
  if (!scanStatements(text)) return 'incomplete TOML string or collection; kept unchanged';
  const lines = statements(text);
  const opens = lines.filter(l => l === OPEN_FENCE).length;
  const closes = lines.filter(l => l === CLOSE_FENCE).length;
  if (opens !== closes || opens > 1 || (opens === 1 && lines.indexOf(OPEN_FENCE) > lines.indexOf(CLOSE_FENCE))) {
    return 'incomplete or duplicate AgentDeck fence';
  }
  const fence = locateFence(lines);
  if (fence && retainedFenceContent(lines.slice(fence.start + 1, fence.end - 1)).some(isOwnedCommand)) {
    return 'modified AgentDeck hook table requires manual configuration; kept unchanged';
  }
  const outside = removeManagedBlock(text);
  let inTable = false;
  for (const line of statements(outside)) {
    const code = withoutComment(line).trim();
    if (/^\[\[?\s*["'](?:features|hooks|otel)["']/.test(code)
      || (!inTable && /^(?:["'](?:features|hooks|otel|notify)["']\s*[.=]|(?:features|hooks|otel)\s*[.=])/.test(code))) {
      return 'quoted, inline or dotted integration keys require manual configuration';
    }
    if (code.startsWith('[')) inTable = true;
  }
  return undefined;
}

export function existingFeaturesEnableHooks(text: string): boolean {
  let inFeatures = false;
  let values = 0;
  let enabled = false;
  for (const line of statements(removeManagedBlock(text))) {
    const code = withoutComment(line).trim();
    if (code.startsWith('[')) inFeatures = /^\[\s*features\s*\]$/.test(code);
    else if (inFeatures && /^hooks\s*=/.test(code)) {
      values++;
      enabled = /^hooks\s*=\s*true$/.test(code);
    }
  }
  return values === 1 && enabled;
}

function withoutComment(line: string): string {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && c === '\\') { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** Replace the AgentDeck-managed fenced block (or append one when none
 *  exists). The body is wrapped between OPEN_FENCE / CLOSE_FENCE so
 *  removeManagedBlock can strip it cleanly later. Returns the full
 *  updated TOML text. */
export function applyManagedBlock(text: string, body: string): string {
  const lines = statements(removeManagedBlock(text));
  const replacement = [OPEN_FENCE, ...(body.length ? statements(body) : []), CLOSE_FENCE];
  // notify is a ROOT key. Put the block after user root keys but before
  // their first table; an appended block silently scopes notify to a table.
  const firstTable = lines.findIndex(isTableHeader);
  lines.splice(firstTable < 0 ? lines.length : firstTable, 0, ...replacement);
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}

/** Remove generated entries and preserve foreign data inside the fence. Idempotent — no-op when
 *  the fence is absent. */
export function removeManagedBlock(text: string): string {
  const lines = statements(text);
  const fenceRange = locateFence(lines);
  if (!fenceRange || lines[fenceRange.end - 1] !== CLOSE_FENCE) return text;
  const retained = retainedFenceContent(lines.slice(fenceRange.start + 1, fenceRange.end - 1));
  lines.splice(fenceRange.start, fenceRange.end - fenceRange.start, ...retained);
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}

/** Detect a top-level `<key> = ...` definition outside the fence. Codex
 *  `notify` is a top-level key; if the user already wrote one our fenced
 *  `notify` would be a duplicate-key TOML error. */
export function hasTopLevelKeyOutsideFence(text: string, key: string): boolean {
  const escaped = escapeRegex(key);
  const regex = new RegExp(`^\\s*${escaped}\\s*=`);
  let insideFence = false;
  let insideTable = false;
  for (const line of statements(text)) {
    if (line === OPEN_FENCE) { insideFence = true; continue; }
    if (line === CLOSE_FENCE) { insideFence = false; continue; }
    if (insideFence) continue;
    const trimmed = withoutComment(line).trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      insideTable = true;
      continue;
    }
    if (insideTable) continue;
    if (regex.test(withoutComment(line))) return true;
  }
  return false;
}

/** Detect a `[<table>]`, `[<table>.subkey]`, or matching array-of-table
 *  header outside the fence. Codex `[otel]` / `[features]` tables collide
 *  with the fence we'd write. Hook arrays are handled separately because
 *  multiple `[[hooks.<Event>]]` entries are explicitly mergeable. */
export function hasTableOutsideFence(text: string, table: string): boolean {
  const escaped = escapeRegex(table);
  // Match exactly `[otel]`, `[otel.something]`, `[[otel.something]]`,
  // but not `[otelfoo]`. Whitespace inside brackets is permissive.
  const regex = new RegExp(`^\\s*\\[\\[?\\s*${escaped}(?=\\s*[.\\]])`);
  let insideFence = false;
  for (const line of statements(text)) {
    if (line === OPEN_FENCE) { insideFence = true; continue; }
    if (line === CLOSE_FENCE) { insideFence = false; continue; }
    if (insideFence) continue;
    if (table === 'hooks' && isCodexHookStateHeader(line)) continue;
    if (regex.test(withoutComment(line))) return true;
  }
  return false;
}

/** Detect user-authored hook table shapes that cannot safely coexist with
 *  AgentDeck's lifecycle arrays. Official `[[hooks.<Event>]]` and nested
 *  `[[hooks.<Event>.hooks]]` arrays are mergeable and therefore allowed;
 *  regular `[hooks]` / `[hooks.<...>]` tables remain a conflict. Codex's
 *  generated `[hooks.state]` trust cache is metadata and is also ignored. */
export function hasIncompatibleHookTableOutsideFence(text: string): boolean {
  const anyHookHeader = /^\s*\[\[?\s*hooks(?:\.[^\]]+)?\s*\]\]?\s*$/;
  const mergeableLifecycleArray =
    /^\s*\[\[\s*hooks\.[A-Za-z0-9_-]+(?:\.hooks)?\s*\]\]\s*$/;
  let insideFence = false;
  for (const line of statements(text)) {
    if (line === OPEN_FENCE) { insideFence = true; continue; }
    if (line === CLOSE_FENCE) { insideFence = false; continue; }
    if (insideFence || isCodexHookStateHeader(line)) continue;
    if (!anyHookHeader.test(withoutComment(line))) continue;
    if (mergeableLifecycleArray.test(withoutComment(line))) continue;
    return true;
  }
  return false;
}

/** Quote a string as a TOML basic string. Escape backslash, double quote,
 *  and control characters so the output is always single-line safe. */
export function quoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  out += '"';
  return out;
}

// ─── internals ──────────────────────────────────────────────────────────

/** Logical TOML statements with their original spelling. Headers/fences inside
 * strings or collections are data, never insertion/removal boundaries. */
function scanStatements(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let pending: string[] = [], quote = '', multiline = false, depth = 0;
  for (const line of lines) {
    pending.push(line);
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (quote === '"' && c === '\\') { i++; continue; }
        if (c === quote) {
          if (!multiline) quote = '';
          else if (line.slice(i, i + 3) === quote.repeat(3)) {
            // TOML allows one or two quotes immediately before the closing triple.
            while (line[i + 1] === c) i++;
            quote = ''; multiline = false;
          }
        }
      } else if (c === '#') break;
      else if (c === '"' || c === "'") {
        quote = c; multiline = line.slice(i, i + 3) === c.repeat(3);
        if (multiline) i += 2;
      } else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { if (--depth < 0) return undefined; }
    }
    if (quote && !multiline) return undefined;
    if (!quote && depth === 0) { out.push(pending.join(text.includes('\r\n') ? '\r\n' : '\n')); pending = []; }
  }
  return pending.length ? undefined : out;
}

function statements(text: string): string[] {
  return scanStatements(text) ?? [text];
}

interface FenceRange { start: number; end: number; }

function locateFence(lines: string[]): FenceRange | null {
  const start = lines.indexOf(OPEN_FENCE);
  if (start === -1) return null;
  // Find first close fence at-or-after start. Defensive against truncated
  // files: if no close fence is found, treat everything from the open
  // fence to the end as managed.
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === CLOSE_FENCE) { end = i; break; }
  }
  if (end === -1) end = lines.length - 1;
  return { start, end: end + 1 };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isOwnedCommand(line: string): boolean {
  if (!/^command\s*=/.test(line.trim())) return false;
  if (line.includes('/hooks/codex_')) return true;
  const encoded = line.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1];
  return !!encoded && Buffer.from(encoded, 'base64').toString('utf16le').includes('/hooks/codex_');
}

function generatedComment(line: string): boolean {
  return /^# (?:Codex lifecycle hooks\.|each snippet forwards|Optional turn-complete notification|Codex appends the JSON payload|so the 4th array element|powershell -File binds|it concatenates trailing argv|OTel trace exporter|Schema: \[otel\.)/.test(line.trim());
}

/** A fence is a location, not ownership: toml_edit inserts later user keys
 * into it. Remove only the generated keys; keep foreign sections in scope.
 * A features table extended by Codex becomes user-owned, including hooks=true. */
function retainedFenceContent(lines: string[]): string[] {
  const groups: string[][] = [[]];
  for (const line of lines) {
    if (isTableHeader(line) && !/^\[\[hooks\.[^.]+\.hooks\]\]$/.test(withoutComment(line).trim())) groups.push([]);
    groups[groups.length - 1].push(line);
  }
  const out: string[] = [];
  for (const group of groups) {
    const kept = group.filter(l => l.trim() && !generatedComment(l));
    const data = kept.filter(l => withoutComment(l).trim());
    if (!data.length) { out.push(...kept); continue; }
    const header = withoutComment(data[0]).trim();
    if (!isTableHeader(data[0])) {
      out.push(...kept.filter(l => !(/^notify\s*=/.test(withoutComment(l).trim()) && (l.includes('agentdeck-notify') || l.includes('codex-notify.ps1')))));
    } else if (/^\[\s*features\s*\]$/.test(header)) {
      if (data.slice(1).some(l => !/^hooks\s*=\s*true$/.test(withoutComment(l).trim()))) out.push(...kept);
      else out.push(...kept.filter(l => !withoutComment(l).trim()));
    } else if (/^\[\[hooks\.[^.]+\]\]$/.test(header)) {
      // Generated lifecycle entries contain only these fields. Any extension
      // belongs to the user and keeps the complete table context.
      const commands = data.filter(l => /^command\s*=/.test(l.trim()));
      const owned = commands.length > 0 && commands.every(isOwnedCommand);
      if (!owned || data.slice(1).some(l => !/^(?:\[\[hooks\.|(?:matcher|type|command|timeout|notify)\s*=)/.test(withoutComment(l).trim()))) out.push(...kept);
    } else if (header === '[otel.trace_exporter.otlp-http]') {
      const owned = data.some(l => /^endpoint\s*=\s*"http:\/\/127\.0\.0\.1:\d+\/otel\/v1\/traces"$/.test(withoutComment(l).trim()));
      if (!owned || data.slice(1).some(l => !/^(?:endpoint|protocol)\s*=/.test(withoutComment(l).trim()))) out.push(...kept);
    } else out.push(...kept);
  }
  return out;
}

function isCodexHookStateHeader(line: string): boolean {
  const trimmed = withoutComment(line).trim();
  return trimmed === '[hooks.state]' || (trimmed.startsWith('[hooks.state.') && trimmed.endsWith(']'));
}

function isTableHeader(line: string): boolean {
  const trimmed = withoutComment(line).trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']');
}
