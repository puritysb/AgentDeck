/** Eligibility for observed task comparisons, shared by both daemons.
 * Three samples are a minimum display gate, not statistical confidence.
 * Unknown identities and plumbing/test labels are not selectable models.
 */
export const APME_COMPARISON_MIN_SAMPLES = 3;
export const APME_NON_MODEL_IDS = [
  '', 'unknown', 'mixed', 'default', '<synthetic>', 'agentdeck-fixture',
  'delivery-mirror', 'gateway-injected',
] as const;
export const APME_NON_COMPARISON_CATEGORIES = ['', 'unknown', '_empty'] as const;

export function isApmeComparisonEligible(modelId: string, category: string | null, samples: number): boolean {
  return samples >= APME_COMPARISON_MIN_SAMPLES
    && !(APME_NON_MODEL_IDS as readonly string[]).includes(modelId.trim().toLowerCase())
    && !modelId.trim().startsWith('<')
    && category != null
    && !(APME_NON_COMPARISON_CATEGORIES as readonly string[]).includes(category.trim().toLowerCase());
}
