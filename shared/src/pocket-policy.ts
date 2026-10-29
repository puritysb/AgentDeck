import { CARD_MAX_CHOICES, CARD_MAX_CONTEXT_LINES } from './protocol.js';

/** Adaptive Pocket policy SSOT. Native constants are generated; behavioral
 * parity is exercised against the real Node engine, including UTF-16 hashes. */
export const POCKET_POLICY = {
  stateRev: 1, hourBuckets: 6, bucketHours: 4,
  noResponseMs: 86_400_000, keepSeenMs: 1_209_600_000,
  keepPendingMs: 604_800_000, surveyIntervalMs: 604_800_000,
  surveyFeedbackInterval: 12, initialSurveyFeedback: 2, pendingLimit: 64,
  persistDelayMs: 50,
  defaultMaxCards: 2, minCards: 1, maxCards: 3,
  defaultExploration: 0.65, maxExploration: 2,
  ignoredWeight: 0.15, positivePrior: 1, totalPrior: 2,
  explorationTotalPrior: 2, explorationShownPrior: 1,
  affinityWeight: 0.25, cooldownMs: 21_600_000, cooldownPenalty: 0.45,
  unseenBonus: 0.35, usageThreshold: 80,
  agendaPriority: 0.9, weatherPriority: 1, usagePriority: 0.85,
  lowUsagePriority: 0.45, attentionPriority: 0.95, progressPriority: 0.7,
  resumePriority: 0.55, overviewPriority: 0.35, preferencePriority: 2,
  usefulReward: 1, moreReward: 2, lessPenalty: 2,
  preferenceReward: 2, surpriseReward: 1,
  attentionLines: 3, overviewLines: 4,
  titleBytes: 24, questionBytes: 160, contextBytes: 96,
  choiceIdBytes: 31, choiceLabelBytes: 40,
  maxChoices: CARD_MAX_CHOICES, contextLines: CARD_MAX_CONTEXT_LINES,
} as const;

export const POCKET_KINDS = ['agenda', 'weather', 'usage', 'attention', 'progress', 'resume', 'overview', 'preference'] as const;
export type PocketContentKind = typeof POCKET_KINDS[number];
export const POCKET_CARD_ID_PATTERN = '^module:(?:pulse:auto:overview|quest:auto:preference|nudge:auto:(?:agenda|weather|usage|attention|progress|resume)):[0-9]{8}:[0-9a-f]{8}$';

/** Never persist arbitrary card copy carried in a forged/legacy identifier. */
export function pocketKindForCardId(id: string): PocketContentKind | undefined {
  return new RegExp(POCKET_CARD_ID_PATTERN).test(id) ? id.split(':')[3] as PocketContentKind : undefined;
}
