/** Opt-in Glance ICS context. URLs and parsed event copy are memory-only here;
 * native configuration stores secrets in Keychain, never in Pocket learning. */
import type { GlanceEvent } from '@agentdeck/shared';
import { CALENDAR_POLICY as P } from './calendar-policy.generated.js';
import { buildTodayEvents, parseIcsCalendar, emptyCalendarSkipped, type CalendarSkipped, type IcsEvent } from './calendar-ics.js';
export { unfoldIcsLines, parseIcsInstant, parseIcsEvents, parseIcsCalendar, occursOn, buildTodayEvents } from './calendar-ics.js';
export interface CalendarSettings { urls: string[]; timeZone?: string }
export const CALENDAR_CACHE_MS = P.cacheMs;
export const CALENDAR_STALE_SERVE_MS = P.staleMs;
export const CALENDAR_FETCH_TIMEOUT_MS = P.timeoutMs;
export function normalizeCalendarURL(input: string): string | null {
  try {
    const raw = input.startsWith(P.subscriptionScheme) ? P.subscriptionTransport + input.slice(P.subscriptionScheme.length) : input;
    if (!(raw.startsWith('https://') || raw.startsWith('http://')) || /%(?![0-9a-fA-F]{2})/.test(raw) || !raw || Buffer.byteLength(raw) > P.maxUrlBytes || /[\s\x00-\x1f\x7f\\#]/.test(raw)) return null;
    const u = new URL(raw);
    const authority = raw.match(/^[A-Za-z]+:\/\/([^/?#]+)/)?.[1];
    if (!authority || authority.includes('@')) return null;
    if (u.protocol === 'http:' && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/.test(raw)) return null;
    return u.hostname && !u.username && !u.password && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname))) ? raw : null;
  } catch { return null; }
}
export function validCalendarURL(raw: string): boolean { return normalizeCalendarURL(raw) !== null; }
export function parseCalendarSettings(settings: Record<string, unknown>): CalendarSettings | null {
  const c = settings.calendar as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return null;
  const urls = Array.isArray(c.ics) ? c.ics : [c.ics];
  if (!urls.length || urls.length > P.maxSources || !urls.every((s): s is string => typeof s === 'string' && validCalendarURL(s))) return null;
  const zone = c.timeZone;
  if (zone !== undefined) { if (typeof zone !== 'string') return null; try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { return null; } }
  return { urls: urls.map(s => normalizeCalendarURL(s)!), ...(zone === undefined ? {} : { timeZone: zone as string }) };
}
export interface CalendarSnapshot { status: 'disabled' | 'fresh' | 'stale' | 'unknown'; events?: GlanceEvent[]; fetchedAt?: number; skippedEvents?: number; skippedByReason?: CalendarSkipped }
export class CalendarProvider {
  private cache?: { at: number; events: IcsEvent[]; skippedByReason: CalendarSkipped; skippedEvents: number };
  private inflight?: Promise<void>;
  private controller?: AbortController;
  private key?: string;
  private generation = 0;
  private failedAt?: number;
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly log: (msg: string) => void = () => {}) {}
  clear(): void { this.generation++; this.controller?.abort(); this.controller = undefined; this.inflight = undefined; this.cache = undefined; this.key = undefined; this.failedAt = undefined; }
  async snapshot(cfg: CalendarSettings | null, now = Date.now()): Promise<CalendarSnapshot> {
    const validated = cfg && parseCalendarSettings({ calendar: { ics: cfg.urls, timeZone: cfg.timeZone } });
    if (!validated) { this.clear(); return { status: cfg ? 'unknown' : 'disabled' }; }
    const key = JSON.stringify(validated);
    if (key !== this.key) { this.clear(); this.key = key; }
    const generation = this.generation;
    const age = this.cache ? now - this.cache.at : Infinity;
    const retry = this.failedAt !== undefined && now >= this.failedAt && now - this.failedAt < P.retryMs;
    if (!(age >= 0 && age < P.cacheMs) && !retry) {
      if (!this.inflight) {
        const ctl = new AbortController(); this.controller = ctl;
        this.inflight = this.fetchFresh(validated, now, generation, ctl);
      }
      await this.inflight;
    }
    if (this.key !== key || this.generation !== generation) return { status: 'disabled' };
    const cached = this.cache, elapsed = cached ? now - cached.at : Infinity;
    if (!cached || elapsed < 0 || elapsed >= P.staleMs) return { status: 'unknown' };
    try { return { status: elapsed < P.cacheMs ? 'fresh' : 'stale', events: buildTodayEvents(cached.events, new Date(now), validated.timeZone), fetchedAt: cached.at, skippedEvents: cached.skippedEvents, skippedByReason: { ...cached.skippedByReason } }; }
    catch { return { status: 'unknown' }; }
  }
  diagnostics(now = Date.now()): Omit<CalendarSnapshot, 'events'> {
    if (!this.key) return { status: 'disabled' };
    const cached = this.cache, age = cached ? now - cached.at : Infinity;
    if (!cached || age < 0 || age >= P.staleMs) return { status: 'unknown' };
    return { status: age < P.cacheMs ? 'fresh' : 'stale', fetchedAt: cached.at, skippedEvents: cached.skippedEvents, skippedByReason: { ...cached.skippedByReason } };
  }
  async get(cfg: CalendarSettings | null, now = Date.now()): Promise<GlanceEvent[] | undefined> { return (await this.snapshot(cfg, now)).events; }
  private async fetchFresh(cfg: CalendarSettings, now: number, generation: number, ctl: AbortController): Promise<void> {
    const timer = setTimeout(() => ctl.abort(), P.timeoutMs);
    try {
      const all: IcsEvent[] = []; const skippedByReason = emptyCalendarSkipped(); let skippedEvents = 0;
      for (const [index, url] of cfg.urls.entries()) {
        const res = await this.fetchImpl(url, { signal: ctl.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'text/calendar' } });
        if (res.status !== 200 || !res.body) throw new Error('calendar_fetch');
        const reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const r = await reader.read(); if (r.done) break;
            size += r.value.length; if (size > P.maxBodyBytes) throw new Error('calendar_limit'); chunks.push(r.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = Buffer.concat(chunks);
        const parsed = parseIcsCalendar(new TextDecoder('utf-8', { fatal: true }).decode(bytes), String(index));
        all.push(...parsed.events); skippedEvents += parsed.skippedEvents;
        for (const reason of P.skipReasons) skippedByReason[reason] += parsed.skippedByReason[reason];
        if (all.length + skippedEvents > P.maxEvents || ctl.signal.aborted) throw new Error('calendar_limit');
      }
      // Validate expansion before replacing good data, not only on its first read.
      buildTodayEvents(all, new Date(now), cfg.timeZone);
      if (generation === this.generation && !ctl.signal.aborted) { this.cache = { at: now, events: all, skippedByReason, skippedEvents }; this.failedAt = undefined; }
    } catch {
      if (generation === this.generation) { this.failedAt = now; this.log('[calendar] fetch failed'); }
    } finally { clearTimeout(timer); if (generation === this.generation) { this.inflight = undefined; this.controller = undefined; } }
  }
}
