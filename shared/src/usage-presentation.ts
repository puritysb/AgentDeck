import type { CodexCredits, CodexRateLimits } from './protocol.js';

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
  const reserve = limits?.lunaReserve;
  if (!reserve || (reserve.resetsAt && Date.parse(reserve.resetsAt) <= now)) return undefined;
  return usageLunaActive(liveCodexPercent(limits?.primary, now), liveCodexPercent(limits?.secondary, now), reserve.usedPercent)
    ? reserve : undefined;
}

/** Purchased credits are worth a reading only while they are what the account
 * is spending: an ordinary window is exhausted AND a balance remains. A zero
 * balance with an exhausted window means nothing is being drawn down, so the
 * reading is hidden rather than shown as "0". Windows use the same -1 sentinel
 * as usageLunaActive; an unknown balance is -1 and an unlimited one +Infinity. */
export function usageCreditsActive(primary: number, secondary: number, balance: number): boolean {
  return balance > 0 && (primary >= 100 || secondary >= 100);
}

/** The numeric balance `usageCreditsActive` reads. Codex reports the balance
 * as a string ("62500"); `hasCredits: false` is an explicit zero. */
export function codexCreditBalance(credits?: CodexCredits): number {
  if (!credits) return -1;
  if (credits.unlimited === true) return Infinity;
  if (credits.hasCredits === false) return 0;
  const text = credits.balance?.trim();
  const n = text ? Number(text) : NaN;
  return Number.isFinite(n) ? n : -1;
}

/** Remaining credits while they replace an exhausted plan window. */
export interface SelectedCodexCredits {
  /** Remaining balance; +Infinity when unlimited. */
  balance: number;
  /** When the exhausted plan window resets and credits stop being spent. */
  regularResetsAt?: string;
}

/** Codex's live-window rule: a stale or already-reset window is unknown (-1). */
function liveCodexPercent(w: CodexRateLimits['primary'], now: number): number {
  return w && !w.stale &&
    (!w.resetsAt || !Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) > now)
    ? w.usedPercent : -1;
}

/** The credits reading every surface shows once a plan window is exhausted.
 * Where a surface has room for one Codex reading only, this takes precedence
 * over the Luna reserve: credits are what the account is actually spending. */
export function selectedCodexCredits(limits?: CodexRateLimits, now = Date.now()): SelectedCodexCredits | undefined {
  const balance = codexCreditBalance(limits?.credits);
  const primary = liveCodexPercent(limits?.primary, now);
  const secondary = liveCodexPercent(limits?.secondary, now);
  if (!usageCreditsActive(primary, secondary, balance)) return undefined;
  const exhausted = [limits?.primary, limits?.secondary]
    .filter((w) => w && liveCodexPercent(w, now) >= 100 && w.resetsAt && Number.isFinite(Date.parse(w.resetsAt)))
    .map((w) => w!.resetsAt!)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  // The LATEST exhausted reset: credits are spent until every exhausted window
  // is back, so the earlier reset would promise relief too soon.
  return { balance, regularResetsAt: exhausted[0] };
}

/** Compact, never-overstating credit balance: truncated (not rounded) to one
 * decimal below 10, whole units below 1000, then K / M with one decimal below
 * 100 of the unit. Integer-only arithmetic so every generated mirror agrees:
 * 7.49 → "7.4", 950.9 → "950", 62500 → "62.5K", 125000 → "125K",
 * 1250000 → "1.2M". Unlimited is "∞". */
export const CREDIT_BALANCE_UNITS = [
  { divisor: 1_000_000, suffix: 'M' },
  { divisor: 1_000, suffix: 'K' },
] as const;

export function formatCreditBalance(balance: number): string {
  if (balance === Infinity) return '\u221E';
  if (!Number.isFinite(balance) || balance <= 0) return '0';
  for (const { divisor, suffix } of CREDIT_BALANCE_UNITS) {
    if (balance < divisor) continue;
    const tenths = Math.floor((balance * 10) / divisor);
    if (tenths >= 1000) return `${Math.floor(tenths / 10)}${suffix}`;
    return tenths % 10 ? `${Math.floor(tenths / 10)}.${tenths % 10}${suffix}` : `${Math.floor(tenths / 10)}${suffix}`;
  }
  if (balance >= 10) return `${Math.floor(balance)}`;
  const tenths = Math.floor(balance * 10);
  return tenths % 10 ? `${Math.floor(tenths / 10)}.${tenths % 10}` : `${Math.floor(tenths / 10)}`;
}
