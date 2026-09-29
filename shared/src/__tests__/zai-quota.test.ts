// Guards the z.ai quota-rules SSOT (zai-quota.ts):
//  1. shared/zai-quota-vectors.json replays through the TS implementation —
//     the same file is replayed by the Swift suite
//     (apple/AgentDeckTests/ZaiQuotaRulesVectorsTests.swift), so a vector is a
//     behavioral contract both producers must keep, and
//  2. the generated Swift mirror on disk matches what the generator emits from
//     the current source — a hand edit or a skipped
//     `pnpm generate-zai-quota-rules` fails here in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ZAI_MCP_WINDOW_MINUTES,
  ZAI_PLAN_DISPLAY_NAMES,
  ZAI_SESSION_WINDOW_MINUTES,
  ZAI_WEEKLY_WINDOW_MINUTES,
  formatZaiPlanName,
  zaiKeyLooksPayAsYouGo,
  zaiQuotaFromLimits,
} from '../zai-quota.js';
import { emitKotlin, emitSwift } from '../../../scripts/generate-zai-quota-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const vectors = JSON.parse(
  readFileSync(`${repoRoot}shared/zai-quota-vectors.json`, 'utf8'),
) as {
  quota: Array<{ note: string; limits: unknown; level: unknown; expected: Record<string, unknown> }>;
  paygKeys: Array<{ note: string; key: string | null; payg: boolean }>;
};

/** Swift produces the wire snapshot; Kotlin formats plan names on the consumer
 *  side (the ChatGPTPlan precedent) — both mirrors are byte-gated. */
const MIRRORS: Array<[string, (rules: unknown) => string]> = [
  ['apple/AgentDeck/Model/ZaiQuotaRules.generated.swift', emitSwift],
  ['android/app/src/main/kotlin/dev/agentdeck/util/ZaiQuotaRules.generated.kt', emitKotlin],
];

const rules = {
  sessionWindowMinutes: ZAI_SESSION_WINDOW_MINUTES,
  weeklyWindowMinutes: ZAI_WEEKLY_WINDOW_MINUTES,
  mcpWindowMinutes: ZAI_MCP_WINDOW_MINUTES,
  planNames: ZAI_PLAN_DISPLAY_NAMES,
};

describe('zai quota vectors (shared with the Swift suite)', () => {
  for (const v of vectors.quota) {
    it(v.note, () => {
      expect(zaiQuotaFromLimits(v.limits, v.level)).toEqual(v.expected);
    });
  }
});

describe('zai pay-as-you-go key detection', () => {
  for (const v of vectors.paygKeys) {
    it(v.note, () => {
      expect(zaiKeyLooksPayAsYouGo(v.key)).toBe(v.payg);
    });
  }
  it('an unknown tier still displays, never drops', () => {
    expect(formatZaiPlanName('team')).toBe('Team');
    expect(formatZaiPlanName('MAX')).toBe('Max');
    expect(formatZaiPlanName(null)).toBeUndefined();
  });
});

describe('generated mirrors in sync', () => {
  for (const [rel, emit] of MIRRORS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(emit(rules));
    });
  }

  it('carries the window constants so a unit slip cannot hide', () => {
    const swift = emitSwift(rules);
    expect(swift).toContain(`sessionWindowMinutes: Int = ${ZAI_SESSION_WINDOW_MINUTES}`);
    expect(swift).toContain(`weeklyWindowMinutes: Int = ${ZAI_WEEKLY_WINDOW_MINUTES}`);
    expect(swift).toContain(`mcpWindowMinutes: Int = ${ZAI_MCP_WINDOW_MINUTES}`);
    // 300/10080/43200 minutes = 5h / 7d / ~30d — the slot grammar the
    // length-based consumers (ESP32 primary=5H/secondary=7D labels) rely on.
    expect(ZAI_SESSION_WINDOW_MINUTES).toBe(300);
    expect(ZAI_WEEKLY_WINDOW_MINUTES).toBe(10080);
    expect(ZAI_MCP_WINDOW_MINUTES).toBeGreaterThan(ZAI_WEEKLY_WINDOW_MINUTES);
  });
});
