/**
 * APME settings loader.
 *
 * Reads `~/.agentdeck/settings.json` and returns a fully resolved APME config
 * merged with cost-sensitive defaults. The contract is intentionally strict:
 *
 *   - Default judge backend = Foundation Models via the Swift daemon, then
 *     the bundled CLI Swift helper, with explicit MLX fallback when neither
 *     Foundation Models path is available.
 *   - `backend: "api"` (Anthropic API via @anthropic-ai/sdk) is supported on
 *     both daemons but strictly OPT-IN: the user must set it explicitly and
 *     provide a credential (`apme.judge.apiKey`, ANTHROPIC_API_KEY, or an
 *     `ant auth login` profile). No code path selects it automatically.
 *   - `sampleRate` + `onlyWhenDisagreement` gate how often layer 2 runs at all.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debug } from '../logger.js';

export type ApmeJudgeBackend = 'mlx' | 'api' | 'openclaw' | 'foundationModels' | 'openai';

export interface ApmeJudgeConfig {
  backend: ApmeJudgeBackend;
  /** Model id at the chosen backend (e.g. "qwen3-30b", "claude-opus-4-6").
   *  Unused for `foundationModels` — Apple picks the on-device model. */
  model: string;
  /** Fraction of closed runs that trigger a layer-2 judge call (0..1). */
  sampleRate: number;
  /** Only judge runs where layer-1 signal is ambiguous (tests flaky / mixed). */
  onlyWhenDisagreement: boolean;
  /** Optional custom endpoint (MLX server URL, OpenClaw gateway, etc).
   *  For `foundationModels` this is the Swift daemon's `/apme/judge/foundation-models`
   *  endpoint — defaults to the daemon on the standard discovery path. */
  endpoint?: string;
  /** Anthropic API key for `backend:"api"`. Falls back to the standard SDK
   *  credential chain (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth
   *  login` profile) when unset. Mirrors the Swift ApmeJudgeApi loader, which
   *  reads the same settings.json field. */
  apiKey?: string;
  /** When `foundationModels` is unavailable, retry via local MLX instead of
   *  skipping the eval. Default `true` on the Node bridge so CLI-only setups
   *  still get zero-cost local evals when the Swift daemon is not running. */
  fallbackToMlx?: boolean;
}

export interface ApmeDeterministicConfig {
  enabled: boolean;
  /** Hard ceiling per command step (seconds). */
  timeoutSec: number;
  /** Language-specific command overrides. Unset keys fall back to defaults. */
  commands: Partial<Record<'typescript' | 'swift' | 'kotlin', {
    lint?: string;
    build?: string;
    test?: string;
  }>>;
}

export interface ApmeConfig {
  enabled: boolean;
  deterministic: ApmeDeterministicConfig;
  judge: ApmeJudgeConfig;
  /** Models the user actually has access to — fed into the recommender. */
  availableModels: string[];
}

/** Cost-sensitive defaults: Foundation Models first, local MLX fallback, no API calls. */
export const DEFAULT_APME_CONFIG: ApmeConfig = {
  enabled: true,
  deterministic: {
    enabled: true,
    timeoutSec: 180,
    commands: {},
  },
  judge: {
    backend: 'foundationModels',
    // Legacy MLX placeholder retained so sanitizeForMlx() and older settings
    // loaders still resolve through llm.mlx / probe / MLX_FALLBACK_MODEL.
    model: 'qwen3-30b',
    sampleRate: 1.0,
    onlyWhenDisagreement: false,
    fallbackToMlx: true,
  },
  availableModels: [],
};

function getSettingsPath(): string {
  const dir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
  return join(dir, 'settings.json');
}

/**
 * Load APME config from `~/.agentdeck/settings.json`, merging any `apme` block
 * on top of the cost-sensitive defaults. Missing or malformed settings fall
 * back silently — the bridge must keep booting.
 */
export function loadApmeConfig(): ApmeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(getSettingsPath(), 'utf-8'));
  } catch {
    return { ...DEFAULT_APME_CONFIG };
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_APME_CONFIG };
  const apme = (raw as { apme?: unknown }).apme;
  if (!apme || typeof apme !== 'object') return { ...DEFAULT_APME_CONFIG };

  const a = apme as Partial<ApmeConfig> & { judge?: Partial<ApmeJudgeConfig> };
  const judge: ApmeJudgeConfig = {
    ...DEFAULT_APME_CONFIG.judge,
    ...(a.judge ?? {}),
  };
  // Clamp pathological values.
  judge.sampleRate = Math.max(0, Math.min(1, Number(judge.sampleRate) || 0));

  // Any forced backend change MUST also wipe backend-specific endpoint/model
  // so we don't end up calling, e.g., callMlx() against an Anthropic URL or
  // a model id that only exists on the original backend. resetBackendCoupledFields
  // restores the backend's own defaults; the user can re-state per-backend
  // overrides cleanly in settings.json.
  const resetBackendCoupledFields = (reason: string): void => {
    debug('APME', `${reason} — also resetting judge.endpoint and judge.model to mlx defaults to avoid cross-backend leakage.`);
    judge.endpoint = undefined;
    judge.model = DEFAULT_APME_CONFIG.judge.model;
  };

  if (!['mlx', 'api', 'openclaw', 'foundationModels', 'openai'].includes(judge.backend)) {
    resetBackendCoupledFields(`unknown judge.backend=${judge.backend}, falling back to mlx`);
    judge.backend = 'mlx';
  }
  // The 'api' backend is implemented on the Node bridge via the official
  // @anthropic-ai/sdk (2026-07-12; it used to be a stub that was silently
  // downgraded to MLX here). It stays strictly OPT-IN per the cost-sensitive
  // defaults policy: nothing selects it automatically, and the probe reports
  // 'unavailable' with setup guidance when no credential is present. Swift
  // parity: apple/AgentDeck/Daemon/Apme/ApmeJudgeApi.swift.
  judge.fallbackToMlx = Boolean(judge.fallbackToMlx);

  const det: ApmeDeterministicConfig = {
    ...DEFAULT_APME_CONFIG.deterministic,
    ...((a as { deterministic?: Partial<ApmeDeterministicConfig> }).deterministic ?? {}),
  };
  det.timeoutSec = Math.max(5, Math.min(1800, Number(det.timeoutSec) || DEFAULT_APME_CONFIG.deterministic.timeoutSec));
  det.commands = det.commands ?? {};

  const merged: ApmeConfig = {
    enabled: a.enabled ?? DEFAULT_APME_CONFIG.enabled,
    deterministic: det,
    judge,
    availableModels: Array.isArray(a.availableModels) ? a.availableModels : [],
  };
  return merged;
}

/**
 * Decide whether layer-2 (LLM judge) should run for this run, based on the
 * sampleRate + disagreement gates. `deterministicPassed` reflects layer-1 outcome.
 */
/** Whether the configured judge backend can ever succeed on this platform.
 *  `foundationModels` (Apple Intelligence via the Swift daemon / bundled
 *  Swift helper) and `mlx` (Apple-Silicon local server) are darwin-only —
 *  on any other platform every call fails, and because a failed judge
 *  leaves the run without eval rows, the daemon's 30s eval timer would
 *  retry it forever (collecting the git diff each cycle). Skip cleanly
 *  instead; per the cost-sensitive defaults contract no reachable backend
 *  is auto-selected — the user opts into `openai` (Ollama / LM Studio /
 *  vLLM / OpenRouter) or `api` via settings.json. */
export function judgeBackendSupported(
  judge: ApmeJudgeConfig,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'darwin') return true;
  return judge.backend !== 'foundationModels' && judge.backend !== 'mlx';
}

export function shouldJudge(cfg: ApmeJudgeConfig, deterministicPassed: boolean | null): boolean {
  if (cfg.sampleRate <= 0) return false;
  if (cfg.onlyWhenDisagreement) {
    // Judge when layer-1 signal is missing or already flagged as failure.
    // Clear passes are skipped — they're the least informative samples.
    if (deterministicPassed === true) return false;
  }
  return Math.random() < cfg.sampleRate;
}
