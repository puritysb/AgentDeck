import type { UsageModeData, UsageProviderId } from './usage.js';
import { availableUsageViews, buildProviderUsageEncoder } from './usage.js';
import { renderUsageEncoderBoth, renderUsageEncoderSingle, renderUsageEncoderTriple, renderUsageEncoderScopedSingle } from '../renderers/usage-gauge.js';
import { renderUsageSession } from '../renderers/usage-dial-renderer.js';

const scopedFor = (data: UsageModeData, provider: UsageProviderId) =>
  provider === 'claude' && data.usageStale !== true ? data.scopedLimits ?? [] : [];

export function usageDialViews(data: UsageModeData, provider: UsageProviderId): string[] {
  if (provider === 'antigravity') return ['both'];
  const views: string[] = availableUsageViews(buildProviderUsageEncoder(provider, data, true)).filter(v => v !== 'session');
  const scoped = scopedFor(data, provider);
  if (scoped.length) views.unshift('triple');
  scoped.forEach((_, i) => views.push(`scoped:${i}`));
  views.push('session');
  return views;
}

export function renderUsageDialView(data: UsageModeData, provider: UsageProviderId, received: boolean, selected: string): string {
  const views = usageDialViews(data, provider);
  const view = views.includes(selected) ? selected : views[0];
  const enc = buildProviderUsageEncoder(provider, data, received);
  if (view === 'session') return renderUsageSession(data);
  if (view === '5h' || view === '7d') return renderUsageEncoderSingle(enc, view);
  const scoped = scopedFor(data, provider);
  const raw = view === 'triple' ? scoped[0] : view.startsWith('scoped:') ? scoped[Number(view.slice(7))] : undefined;
  if (raw) {
    const cap = { label: raw.label, usedPercent: raw.percent, resetsAt: raw.resetsAt, known: true, active: raw.active === true };
    return view === 'triple' ? renderUsageEncoderTriple(enc, cap) : renderUsageEncoderScopedSingle(enc, cap);
  }
  return renderUsageEncoderBoth(enc);
}
