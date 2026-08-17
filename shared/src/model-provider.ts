/**
 * Which company's endpoint is this model actually answering from — the third
 * identity axis, next to the harness (`agentType`) and the model (`modelName`).
 *
 * Three axes, not two, because they vary independently:
 *
 *   - **harness**  — which CLI/app is driving (Claude Code, Codex, OpenCode …).
 *     It decides the hook set, the transcript format, the steering path and the
 *     creature. `agentType` carries it.
 *   - **model**    — which weights answered. `modelName` carries it.
 *   - **provider** — whose endpoint served those weights. Nothing carried it.
 *
 * A `claude-glm` session is Claude Code (same binary, same hooks, same
 * transcript) pointed at z.ai by `ANTHROPIC_BASE_URL`. Minting a `claude-glm`
 * *agentType* for it would be wrong twice over: it conflates the harness with
 * the endpoint, and — because every surface's agent handling is an allow-list —
 * a value no client predates renders as nothing at all. The model field already
 * says `glm-5.3`. What was missing is the one-bit fact a reader actually wants:
 * *this Claude is not talking to Anthropic*.
 *
 * Polarity, per the unknown-agent rule: every mapping here is an ALLOW-list.
 * An unrecognized model returns `'unknown'`, which means "no information" and
 * renders as nothing — never as some other company's name. A deny-list would
 * dress every model released after this file as whatever the fallback bucket
 * happened to be.
 */

/** Companies whose endpoints AgentDeck can name. `'unknown'` is the honest
 *  answer for anything else and must render as no badge, never as a guess. */
export type ModelProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'alibaba'
  | 'xai'
  | 'mistral'
  | 'meta'
  | 'unknown';

/** Display names. Kept beside the ids so a surface never spells one itself. */
export const MODEL_PROVIDER_LABELS: Readonly<Record<ModelProvider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  zai: 'z.ai',
  moonshot: 'Moonshot',
  deepseek: 'DeepSeek',
  alibaba: 'Qwen',
  xai: 'xAI',
  mistral: 'Mistral',
  meta: 'Meta',
  unknown: '',
};

/** Substrings that identify a provider from a model id, most specific first.
 *  Order matters only where one family's name contains another's. */
export const MODEL_MARKERS: ReadonlyArray<readonly [ModelProvider, readonly string[]]> = [
  ['anthropic', ['claude', 'opus', 'sonnet', 'haiku', 'fable']],
  // `codex-mini` is an OpenAI model id; the Codex *harness* is matched
  // separately by `harnessNativeProvider`.
  ['openai', ['gpt-', 'gpt.', 'o1-', 'o3-', 'o4-', 'codex-', 'davinci', 'chatgpt']],
  ['google', ['gemini', 'gemma', 'palm-']],
  ['zai', ['glm', 'z-ai', 'zai']],
  ['moonshot', ['kimi', 'moonshot']],
  ['deepseek', ['deepseek']],
  ['alibaba', ['qwen', 'qwq']],
  ['xai', ['grok']],
  ['mistral', ['mistral', 'magistral', 'devstral', 'codestral', 'mixtral']],
  ['meta', ['llama']],
];

/** Vendor prefixes as they appear in `provider/model` ids (`zai/glm-5.2`). */
export const VENDOR_PREFIXES: Readonly<Record<string, ModelProvider>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  'google-vertex': 'google',
  zai: 'zai',
  'z-ai': 'zai',
  zhipu: 'zai',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  deepseek: 'deepseek',
  alibaba: 'alibaba',
  qwen: 'alibaba',
  xai: 'xai',
  mistral: 'mistral',
  meta: 'meta',
};

/**
 * Name the provider behind a model id, or `'unknown'` when nothing matches.
 *
 * Accepts every id shape the wire actually carries: bare (`glm-5.3`), vendored
 * (`zai/glm-5.2`), and display-formatted (`GLM-5.2 (1M)`, `gpt-5.6-sol high`).
 */
export function modelProvider(modelName?: string | null): ModelProvider {
  const raw = (modelName ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';

  // `vendor/model` — the vendor half is authoritative when we recognize it.
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const vendor = VENDOR_PREFIXES[raw.slice(0, slash)];
    if (vendor) return vendor;
  }

  const id = slash > 0 ? raw.slice(slash + 1) : raw;
  for (const [provider, markers] of MODEL_MARKERS) {
    for (const marker of markers) {
      if (id.includes(marker)) return provider;
    }
  }
  return 'unknown';
}

/**
 * The provider each harness talks to when nobody has redirected it.
 *
 * Allow-list, and deliberately short: `openclaw`, `opencode`, `antigravity` and
 * `kiro` are multi-provider by design, so they HAVE no native provider and are
 * absent here — which is what stops them from wearing a permanent "off-harness"
 * badge for doing exactly what they are for.
 */
export const HARNESS_NATIVE_PROVIDERS: Readonly<Record<string, ModelProvider>> = {
  claude: 'anthropic',
  'claude-code': 'anthropic',
  codex: 'openai',
  'codex-cli': 'openai',
  'codex-app': 'openai',
};

/** The provider a harness talks to unredirected, or `'unknown'`. */
export function harnessNativeProvider(agentType?: string | null): ModelProvider {
  return HARNESS_NATIVE_PROVIDERS[(agentType ?? '').trim().toLowerCase()] ?? 'unknown';
}

/**
 * The provider to badge on a session row, or `null` for "say nothing".
 *
 * Non-null only when BOTH sides are known and they disagree — i.e. a harness
 * with a native provider is demonstrably answering from somewhere else. Two
 * unknowns must never combine into a claim: absence of evidence is not evidence
 * of redirection, and a badge on every unrecognized model would be noise on
 * exactly the rows we know least about.
 */
export function offHarnessProvider(
  agentType?: string | null,
  modelName?: string | null,
): ModelProvider | null {
  const native = harnessNativeProvider(agentType);
  if (native === 'unknown') return null;
  const actual = modelProvider(modelName);
  if (actual === 'unknown' || actual === native) return null;
  return actual;
}

/** Badge text for a session row — `''` when there is nothing to say. */
export function offHarnessProviderLabel(
  agentType?: string | null,
  modelName?: string | null,
): string {
  const provider = offHarnessProvider(agentType, modelName);
  return provider ? MODEL_PROVIDER_LABELS[provider] : '';
}
