/**
 * Timeline summarizer — uses local LLM to create concise 1-line summaries
 * of OpenClaw chat responses for timeline display.
 *
 * Tries: on-device Foundation Models → the configured resident MLX model →
 * heuristic fallback. Non-blocking — caller should fire-and-forget,
 * update entry when ready.
 *
 * The provider order is the Node mirror of Swift's `TimelineSummarizer`
 * `.auto` chain (FoundationModels → MLX → heuristic). It was
 * MLX-first for a long time, which meant a CLI-only user on macOS 26 with
 * Apple Intelligence available still got heuristic rows unless they also ran
 * an MLX server — the same machine summarized differently depending on which
 * daemon happened to be up. Keep the two chains in the same order.
 *
 * The Ollama tier was removed 2026-08-22: it hard-pinned `qwen2.5:7b`, a
 * model two generations behind anything the model-eval fleet measures, and
 * the Settings UI never offered it as a choice. MLX rides whatever model the
 * server actually serves (probed), so it cannot go stale the same way.
 */

import { debug, log } from './logger.js';
import { SUMMARY_SYSTEM_PROMPT, cleanLLMOutput, mlxChatUrl, loadMlxSettings, guardedMlxFetch } from '@agentdeck/shared';
import { callFoundationModelsHelper, probeFoundationModelsHelper } from './foundation-models-helper.js';
export { extractTopicHint } from '@agentdeck/shared';

const TIMEOUT_MS = 30_000; // 30s — first inference needs model load time
const MAX_INPUT_CHARS = 2000;

let fmAvailable: boolean | null = null;
let mlxAvailable: boolean | null = null;
let fmFailedAt = 0;
let mlxFailedAt = 0;
const RETRY_INTERVAL_MS = 60_000; // retry failed providers after 60s

/** Reset the cached provider availability (tests only). */
export function clearSummarizerProviderCacheForTests(): void {
  fmAvailable = null;
  mlxAvailable = null;
  fmFailedAt = 0;
  mlxFailedAt = 0;
}

/**
 * Summarize a chat response into a concise 1-line Korean summary.
 * Returns null if summarization fails (caller should use fallback).
 */
export async function summarizeResponse(text: string): Promise<string | null> {
  if (!text || text.length < 20) return null;

  const input = text.length > MAX_INPUT_CHARS
    ? text.slice(0, MAX_INPUT_CHARS) + '...'
    : text;

  let mlxJustFailed = false;

  // Try on-device Foundation Models first — no server for the user to run,
  // and it is the same helper process the APME judge already keeps warm.
  // A miss here is not an error state: off-macOS, on macOS < 26, or with
  // Apple Intelligence disabled the probe simply reports unavailable and the
  // chain moves on. Only MLX failing is worth telling the user about
  // (that is what the user opts into by installing it).
  if (fmAvailable !== false || (Date.now() - fmFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callFoundationModels(input);
      if (result) {
        if (fmAvailable === false) debug('summarizer', 'Foundation Models recovered');
        fmAvailable = true;
        return result;
      }
    } catch (err) {
      fmAvailable = false;
      fmFailedAt = Date.now();
      debug('summarizer', `Foundation Models not available: ${String(err)}`);
    }
  }

  // Try the resident MLX model next (retry after RETRY_INTERVAL_MS)
  if (mlxAvailable !== false || (Date.now() - mlxFailedAt > RETRY_INTERVAL_MS)) {
    try {
      const result = await callMLX(input);
      if (result) {
        if (mlxAvailable === false) {
          // MLX recovered — note the transition.
          debug('summarizer', 'MLX recovered');
        }
        mlxAvailable = true;
        return result;
      }
    } catch (err) {
      mlxJustFailed = mlxAvailable !== false; // first time we observe failure
      mlxAvailable = false;
      mlxFailedAt = Date.now();
      debug('summarizer', `MLX not available: ${String(err)}`);
    }
  }

  // Surface backend-down state to the user — but ONLY on the transition
  // (first time we observe the provider failing) and via `log`, NOT
  // `logError`. The summarizer is *optional* — when the user hasn't
  // installed MLX, the heuristic row is the intended UX. Routing
  // through `log` means PTY mode (`agentdeck claude`) suppresses it
  // entirely (the message would otherwise bleed into Claude's terminal
  // session and read as a critical error). Daemon/CLI surfaces still see
  // it in stderr as a regular `[agentdeck]` info line.
  if (mlxJustFailed) {
    log(
      `[timeline] LLM summary backend offline (on-device Foundation Models: ${fmAvailable === false ? 'unavailable' : 'not reached'}, MLX:8800).`,
      'Timeline rows will use heuristic summaries.',
      'Install MLX (`mlx_vlm.server`) to get LLM-summarized chat_end rows.',
    );
  }

  return null;
}

// extractTopicHint and cleanLLMOutput moved to @agentdeck/shared/timeline-summarizer

/** On-device summary via the bundled Swift helper (Apple Intelligence).
 *  Throws when the helper is unavailable so the caller falls to MLX; the
 *  helper owns its own request timeout, so there is no unbounded await here. */
async function callFoundationModels(input: string): Promise<string | null> {
  // Probe only on the first attempt: the probe is a full health round-trip to
  // the helper, and after that the generate call is its own liveness check.
  // (`fmAvailable` is null exactly once — the caller flips it either way.)
  if (fmAvailable === null) {
    const status = await probeFoundationModelsHelper();
    if (!status.available) throw new Error(status.reason ?? 'helper unavailable');
  }

  const text = await callFoundationModelsHelper(input, SUMMARY_SYSTEM_PROMPT);
  const result = cleanLLMOutput(text);
  if (result) debug('summarizer', `Foundation Models summary: ${result}`);
  return result;
}

async function callMLX(input: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const model = loadMlxSettings().model;

  try {
    const resp = await guardedMlxFetch(mlxChatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        enable_thinking: false,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        max_tokens: 100,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`MLX ${resp.status}`);

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const result = cleanLLMOutput(content);
    if (result) debug('summarizer', `MLX summary: ${result}`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

