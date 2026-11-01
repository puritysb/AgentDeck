import { OPENCODE_QUESTION_RULES } from './session-utils.js';

export interface OpenCodeQuestionPrompt {
  question: string;
  options: Array<{ label: string; description?: string; index: number }>;
  /** Current device contract selects exactly one label from one question. */
  replyable: boolean;
}

/** Preserve labels verbatim: the upstream reply API takes labels, not indices. */
export function openCodeQuestionPrompt(value: unknown): OpenCodeQuestionPrompt | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > OPENCODE_QUESTION_RULES.maxQuestions) return;
  const groups: OpenCodeQuestionPrompt[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const q = raw as Record<string, unknown>;
    if (q.multiple !== undefined && typeof q.multiple !== 'boolean') return;
    const question = typeof q.question === 'string' && q.question.trim() ? q.question
      : typeof q.header === 'string' ? q.header : '';
    if (!question.trim() || question.length > OPENCODE_QUESTION_RULES.maxText) return;
    if (!Array.isArray(q.options) || q.options.length > OPENCODE_QUESTION_RULES.maxOptions) return;
    const options: OpenCodeQuestionPrompt['options'] = [];
    for (const [index, item] of q.options.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      const option = item as Record<string, unknown>;
      if (typeof option.label !== 'string' || !option.label.trim() || option.label.length > OPENCODE_QUESTION_RULES.maxLabel) return;
      options.push({ label: option.label, index,
        ...(typeof option.description === 'string' ? { description: option.description.slice(0, OPENCODE_QUESTION_RULES.maxText) } : {}) });
    }
    groups.push({ question, options, replyable: q.multiple !== true && options.length > 0
      && new Set(options.map(o => o.label)).size === options.length });
  }
  const first = groups[0];
  return { ...first, replyable: value.length === 1 && first.replyable };
}
