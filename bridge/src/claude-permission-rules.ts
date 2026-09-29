/**
 * Loader half of the observed-session PreToolUse device-approval gate.
 *
 * The PREDICTION ("would Claude Code actually prompt for this call?") lives in
 * `@agentdeck/shared` (`shared/src/claude-permission-rules.ts`), generated
 * into the Swift daemon and pinned by shared/claude-permission-vectors.json.
 * This module only reads the settings files Claude Code reads for a cwd and
 * hands the merged rules to that predictor.
 *
 * HISTORY (why precision-first): the first PreToolUse gate held EVERY gated
 * tool call, so tools Claude auto-approves (allowlist rules, acceptEdits,
 * session "always allow") still popped Allow/Deny on devices — the reported
 * false-attention bug that got the gate removed (DEVELOPMENT_LOG 2026-05).
 * The reinstated gate only ever holds calls the shared predictor is CONFIDENT
 * Claude will prompt for. Every uncertainty resolves to "don't hold": a
 * missed hold just means the user answers in the terminal (the pre-gate
 * status quo), while a false hold nags the user with a popup Claude never
 * asked for AND stalls the agent for the whole hold timeout.
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  evaluatePermissionRules as evaluateSharedRules,
  NEVER_PROMPT_TOOLS,
  PROMPT_PRONE_TOOLS,
  type MergedPermissionRules,
  type PermissionRuleVerdict,
} from '@agentdeck/shared';
import { debug } from './logger.js';

export type RuleVerdict = PermissionRuleVerdict;
type MergedRules = MergedPermissionRules;

export function isNeverPromptTool(tool: string): boolean {
  return NEVER_PROMPT_TOOLS.has(tool);
}

export function isPromptProneTool(tool: string): boolean {
  return PROMPT_PRONE_TOOLS.has(tool);
}

interface CacheEntry {
  rules: MergedRules | null;
  loadedAt: number;
}

const RULES_CACHE_TTL_MS = 10_000;
const rulesCache = new Map<string, CacheEntry>();

/** Test seam: isolates rule loading from the developer's real ~/.claude. */
let homeOverride: string | null = null;
export function _setHomeOverrideForTests(path: string | null): void {
  homeOverride = path;
  rulesCache.clear();
}

function settingsCandidates(cwd: string | undefined): string[] {
  const home = homeOverride ?? homedir();
  const files = [
    // Enterprise managed policy (rare; parse failure here must also disable holds)
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
  ];
  if (cwd) {
    files.push(join(cwd, '.claude', 'settings.json'));
    files.push(join(cwd, '.claude', 'settings.local.json'));
  }
  return files;
}

/**
 * Load and merge permission rules from every settings file Claude Code reads
 * for this cwd. Returns null ("unknown") when any EXISTING file fails to
 * parse — we can no longer trust our picture of the allowlist, so the caller
 * must not hold anything.
 */
export function loadMergedPermissionRules(cwd: string | undefined): MergedRules | null {
  const key = cwd ?? '';
  const cached = rulesCache.get(key);
  if (cached && Date.now() - cached.loadedAt < RULES_CACHE_TTL_MS) return cached.rules;

  const merged: MergedRules = { allow: [], deny: [], ask: [] };
  let unknown = false;
  for (const file of settingsCandidates(cwd)) {
    let exists = false;
    try { exists = statSync(file).isFile(); } catch { exists = false; }
    if (!exists) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const perms = parsed?.permissions as Record<string, unknown> | undefined;
      if (perms && typeof perms === 'object') {
        for (const bucket of ['allow', 'deny', 'ask'] as const) {
          const arr = perms[bucket];
          if (Array.isArray(arr)) {
            for (const r of arr) if (typeof r === 'string') merged[bucket].push(r);
          }
        }
      }
    } catch {
      debug('permission', `settings parse failed: ${file} — disabling holds for cwd=${cwd ?? '?'}`);
      unknown = true;
      break;
    }
  }
  const rules = unknown ? null : merged;
  rulesCache.set(key, { rules, loadedAt: Date.now() });
  return rules;
}

/** Test helper. */
export function _clearRulesCache(): void {
  rulesCache.clear();
}

/**
 * Predict Claude's permission-rule verdict for a tool call against the
 * settings files that apply to `cwd`. See the shared predictor for the
 * verdict semantics; `permissionMode` lets it apply the `acceptEdits`
 * filesystem auto-approvals.
 */
export function evaluatePermissionRules(
  tool: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string | undefined,
  permissionMode?: string,
): RuleVerdict {
  const command = typeof toolInput?.command === 'string' ? toolInput.command : undefined;
  return evaluateSharedRules(tool, command, loadMergedPermissionRules(cwd), { permissionMode });
}
