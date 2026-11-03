/**
 * Shared timeline summarizer utilities — extractTopicHint and cleanLLMOutput.
 * Used by both bridge/src/timeline-summarizer.ts and plugin/src/timeline-summarizer.ts.
 */

import { cleanRawText } from './timeline.js';
import { stripThinkBlocks, trimCharacters } from './text-scanning.js';

export const SUMMARY_SYSTEM_PROMPT = `You are a timeline summarizer. Given an AI assistant's response text, produce a single-line Korean summary (max 80 characters) of what was accomplished. Focus on the result, not the process. No quotes, no markdown, no punctuation at the end. Output ONLY the summary line, nothing else. Examples:
- 봇마당 인박스에 AI 에이전트 운영 팁 3건 수집
- 주간 모델 사용량 리포트: glm-5 28회 최다
- GitHub 이슈 #10428 검토 완료, PR #16831 대기 중
- HBF 뉴스 9월~2월분 한글 정리 완료`;

/**
 * Extract a topic hint from the first few tokens of a response.
 * Used for immediate chat_start enrichment before LLM summarization.
 *
 * Korean handling: politeness-only responses ("네, 확인했습니다.") used to be
 * stripped to empty and return null, leaving the timeline showing bare
 * "Completed". Now the strip falls back to the pre-strip candidate so the
 * row shows something meaningful.
 */
export function extractTopicHint(text: string): string | null {
  return extractTopicHintWithKind(text).hint;
}

export type TopicHintKind = 'topic' | 'fallback' | null;

/**
 * Same as `extractTopicHint` but tells the caller whether the result was a
 * substantive topic (kind='topic') or just a politeness-fallback /
 * first-sentence fallback (kind='fallback'). Lets emitters set
 * `summaryKind: 'heuristic'` only when there's real content, vs `'none'`
 * when we're scraping the bottom of the barrel.
 */
export function extractTopicHintWithKind(
  text: string,
): { hint: string | null; kind: TopicHintKind } {
  if (!text || text.length < 5) return { hint: null, kind: null };

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Find first non-markdown, non-code-fence, non-empty line
  let candidate: string | null = null;
  let inCodeFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (/^#{1,6}\s*$/.test(line)) continue;

    const stripped = cleanRawText(line)
      .replace(/^[-*]\s+/, '')
      .replace(/^>\s+/, '')
      .trim();

    if (stripped.length >= 3) {
      candidate = stripped;
      break;
    }
  }

  if (!candidate) return { hint: null, kind: null };

  const snippet = candidate.length > 80 ? candidate.slice(0, 77) + '...' : candidate;

  // Try stripping leading Korean polite closers — "네, …" / "확인했습니다."
  let cleaned = snippet
    .replace(/^네[,.]?\s*/i, '')
    .replace(/^(완료했습니다\.\s*|알겠습니다\.\s*|확인했습니다\.\s*)/i, '')
    .trim();

  if (cleaned.length >= 3) {
    return { hint: cleaned, kind: 'topic' };
  }

  // Strip left only the EXTRA content beside the polite closer. If polite
  // closer was the entire candidate, fall back to the candidate itself —
  // "네, 확인했습니다." beats showing just "Completed".
  if (snippet.length >= 3) {
    return { hint: snippet, kind: 'fallback' };
  }

  return { hint: null, kind: null };
}

/**
 * Last-resort fallback when the response yielded no usable hint and the
 * caller has the prompt text — produce a snippet of the prompt instead of
 * literal "Completed". Returns the first sentence (up to `maxLen` chars,
 * ending at `.` `!` `?` or newline) or null when prompt is too short.
 */
export function promptSnippetFallback(prompt: string | null | undefined, maxLen = 60): string | null {
  if (!prompt) return null;
  const trimmed = prompt.trim();
  if (trimmed.length < 3) return null;
  // Cut at the first sentence terminator, otherwise at a hard line break.
  const stop = trimmed.search(/[.!?。、]|\n/);
  let snippet = stop > 0 ? trimmed.slice(0, stop) : trimmed;
  snippet = snippet.trim();
  if (snippet.length === 0) snippet = trimmed;
  if (snippet.length > maxLen) snippet = snippet.slice(0, maxLen - 1).trim() + '…';
  return snippet;
}

/** Clean LLM output — strip thinking, quotes, markdown artifacts */
export function cleanLLMOutput(content: string): string | null {
  let cleaned = stripThinkBlocks(content).trim();

  // If output has multiple lines, take the last non-empty line
  // (thinking text tends to come first, summary last)
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    // Find the last line that looks like Korean summary (contains Korean chars)
    const koreanLine = lines.reverse().find(l => /[\uAC00-\uD7AF]/.test(l));
    cleaned = koreanLine || lines[lines.length - 1];
  }

  // Strip surrounding quotes, markdown list markers
  cleaned = trimCharacters(cleaned.replace(/^[-*]\s*/, ''), '"\'`\u201C\u201D\u2018\u2019')
    .replace(/[.\u3002]$/, '') // remove trailing period
    .trim();

  if (!cleaned || cleaned.length < 3) return null;
  // Truncate to 80 chars if needed
  if (cleaned.length > 80) cleaned = cleaned.slice(0, 77) + '...';
  return cleaned;
}
