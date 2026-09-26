import type { CodexRateLimits } from './protocol.js';

/** Cross-surface display policy. Native mirrors are generated, not hand copied. */
export const USAGE_PRESENTATION = {
  heading: 'USAGE',
  providers: [
    { id: 'claude', label: 'Claude', prefixes: ['Claude'] },
    { id: 'codex', label: 'Codex', prefixes: ['ChatGPT', 'Codex'] },
    { id: 'zai', label: 'z.ai', prefixes: ['GLM Coding Plan', 'z.ai'] },
    { id: 'antigravity', label: 'Antigravity', prefixes: ['Google AI', 'Antigravity', 'AGY'] },
  ],
} as const;

export function usageSubscriptionProvider(name: string): number {
  const key = name.trim().toLowerCase();
  return USAGE_PRESENTATION.providers.findIndex(p => p.prefixes.some(prefix => key.startsWith(prefix.toLowerCase())));
}

/** Characters that may separate a provider prefix from its tier ("GLM Coding Plan · Lite"). */
export const USAGE_TIER_SEPARATORS = ' ·:-';

/** The plan tier a surface prints beside its provider's brand mark: the
 *  subscription name without the provider prefix ("ChatGPT Pro" → "Pro",
 *  "GLM Coding Plan · Lite" → "Lite"). The brand mark already names the
 *  provider, so repeating it wastes the space a missing window frees. A
 *  prefix-only name ("Claude") has no tier and yields "" — surfaces then
 *  omit it rather than print the provider twice. An unattributed name is
 *  returned whole. */
export function usageSubscriptionTier(name: string): string {
  const trimmed = name.trim();
  const key = trimmed.toLowerCase();
  for (const provider of USAGE_PRESENTATION.providers) {
    const prefix = provider.prefixes.find(v => key.startsWith(v.toLowerCase()));
    if (!prefix) continue;
    let tail = trimmed.slice(prefix.length);
    while (tail && USAGE_TIER_SEPARATORS.includes(tail[0])) tail = tail.slice(1);
    return tail.trim();
  }
  return trimmed;
}

/** A reported extra pool alone does not mean the account has exhausted quota.
 * Unknown/ended windows are -1, zero is valid. The next account snapshot restores
 * ordinary windows as soon as neither is exhausted. An exhausted reserve is
 * still meaningful (0% left), so availability is not a visibility condition. */
export function usageLunaActive(primary: number, secondary: number, reserve: number): boolean {
  return reserve >= 0 && (primary >= 100 || secondary >= 100);
}

export function selectedLunaReserve(limits?: CodexRateLimits, now = Date.now()) {
  const live = (w: CodexRateLimits['primary']) => w && !w.stale &&
    (!w.resetsAt || !Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) > now)
    ? w.usedPercent : -1;
  const reserve = limits?.lunaReserve;
  if (!reserve || (reserve.resetsAt && Date.parse(reserve.resetsAt) <= now)) return undefined;
  return usageLunaActive(live(limits?.primary), live(limits?.secondary), reserve.usedPercent) ? reserve : undefined;
}
