/**
 * Glance schedule provider (ICS) — daemon-side module for the card-feed sleep
 * dashboard (M9 stage 2). The device never parses a calendar itself; the
 * daemon fetches the ICS feed(s), expands today's occurrences, and pre-renders
 * them into `CardFeedResponse.glance.events` (shared/src/protocol.ts § Glance).
 *
 * Config comes from settings.json — one secret-address ICS URL (Google
 * Calendar / iCloud / Fastmail all export one) or a list:
 *
 *   "calendar": { "ics": "https://calendar.google.com/calendar/ical/…/basic.ics" }
 *   "calendar": { "ics": ["https://…/basic.ics", "https://…/work.ics"] }
 *
 * No config → no schedule in the glance (never a guess).
 *
 * Deliberately dependency-free, like weather.ts. The parser covers the ICS
 * subset a personal "what's left of today" needs:
 *   - VEVENT with SUMMARY / DTSTART / DTEND, line unfolding, text unescaping
 *   - all-day events (VALUE=DATE), UTC instants (…Z), floating/TZID-local
 *     times (TZID is assumed to be the daemon's own zone — the common case for
 *     a personal calendar; a cross-zone TZID renders at its literal HH:MM)
 *   - RRULE FREQ=DAILY/WEEKLY(BYDAY)/MONTHLY(BYMONTHDAY)/YEARLY with
 *     INTERVAL / UNTIL / COUNT, expanded by bounded day-walk from DTSTART
 *   - EXDATE and RECURRENCE-ID overrides (override replaces that instance)
 */

import type { GlanceEvent } from '@agentdeck/shared';
import { GLANCE_MAX_EVENTS, GLANCE_EVENT_TITLE_MAX_BYTES } from '@agentdeck/shared';
import { trimUtf8Bytes } from './card-feed.js';

export interface CalendarSettings {
  urls: string[];
}

/** Serve from cache inside this window — schedule cadence is slower than the
 *  fastest pull cadence (900s). */
export const CALENDAR_CACHE_MS = 30 * 60 * 1000;
/** After a fetch failure, keep serving the last good parse up to this age. */
export const CALENDAR_STALE_SERVE_MS = 6 * 60 * 60 * 1000;
/** External peer await — timeout is first-line, not optional. */
export const CALENDAR_FETCH_TIMEOUT_MS = 8000;
/** Recurrence day-walk bound (~10 years) — a runaway RRULE must terminate. */
const MAX_RECURRENCE_WALK_DAYS = 3700;

export function parseCalendarSettings(settings: Record<string, unknown>): CalendarSettings | null {
  const c = settings?.calendar as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return null;
  const raw = c.ics;
  const urls = (Array.isArray(raw) ? raw : [raw])
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
  return urls.length > 0 ? { urls } : null;
}

// ── ICS parsing ──

interface IcsEvent {
  uid: string;
  summary: string;
  /** "YYYYMMDD" of DTSTART (local, see header note). */
  startDate: string;
  /** "HH:MM" or undefined for all-day / date-only starts. */
  startHm?: string;
  endDate?: string;
  endHm?: string;
  rrule?: Map<string, string>;
  exdates: Set<string>;
  /** "YYYYMMDD" this VEVENT overrides in its UID's recurrence set. */
  recurrenceId?: string;
}

/** RFC 5545 line unfolding: CRLF followed by space/tab continues the line. */
export function unfoldIcsLines(text: string): string[] {
  const raw = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      out.push(line);
    }
  }
  return out;
}

function unescapeIcsText(s: string): string {
  return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const dateKey = (d: Date): string => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const hmKey = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** One DTSTART/DTEND/EXDATE value → local date + optional HH:MM.
 *  `…Z` converts through the daemon clock; floating/TZID read literally. */
export function parseIcsInstant(value: string): { date: string; hm?: string } | null {
  const m = value.match(/^(\d{8})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, ymd, hh, mm, , zulu] = m;
  if (!hh) return { date: ymd };
  if (zulu) {
    const d = new Date(Date.UTC(
      Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)),
      Number(hh), Number(mm),
    ));
    return { date: dateKey(d), hm: hmKey(d) };
  }
  return { date: ymd, hm: `${hh}:${mm}` };
}

export function parseIcsEvents(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Partial<IcsEvent> & { exdates: Set<string> } | null = null;
  for (const line of unfoldIcsLines(text)) {
    if (line === 'BEGIN:VEVENT') {
      cur = { exdates: new Set() };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.summary && cur.startDate) {
        events.push({ ...cur, uid: cur.uid ?? '', summary: cur.summary, startDate: cur.startDate,
          exdates: cur.exdates });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const lhs = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = lhs.split(';')[0].toUpperCase();
    if (name === 'SUMMARY') cur.summary = unescapeIcsText(value.trim());
    else if (name === 'UID') cur.uid = value.trim();
    else if (name === 'DTSTART') {
      const t = parseIcsInstant(value.trim());
      if (t) { cur.startDate = t.date; if (t.hm !== undefined) cur.startHm = t.hm; }
    } else if (name === 'DTEND') {
      const t = parseIcsInstant(value.trim());
      if (t) { cur.endDate = t.date; if (t.hm !== undefined) cur.endHm = t.hm; }
    } else if (name === 'RRULE') {
      cur.rrule = new Map(value.split(';').map((kv) => {
        const eq = kv.indexOf('=');
        return [kv.slice(0, eq).toUpperCase(), kv.slice(eq + 1)] as [string, string];
      }));
    } else if (name === 'EXDATE') {
      for (const v of value.split(',')) {
        const t = parseIcsInstant(v.trim());
        if (t) cur.exdates.add(t.date);
      }
    } else if (name === 'RECURRENCE-ID') {
      const t = parseIcsInstant(value.trim());
      if (t) cur.recurrenceId = t.date;
    }
  }
  return events;
}

// ── Recurrence: does this event occur on `day`? ──

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const dayFromKey = (key: string): Date =>
  new Date(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)));
const daysBetween = (a: Date, b: Date): number =>
  Math.round((b.getTime() - a.getTime()) / 86_400_000);

/** Occurrence check by bounded day-walk from DTSTART — one predicate per
 *  FREQ, counting matches so COUNT/UNTIL terminate exactly. */
export function occursOn(ev: IcsEvent, dayKey: string): boolean {
  if (!ev.rrule) return ev.startDate === dayKey;
  if (ev.exdates.has(dayKey)) return false;
  const freq = ev.rrule.get('FREQ') ?? '';
  const interval = Math.max(1, Number(ev.rrule.get('INTERVAL') ?? '1') || 1);
  const count = Number(ev.rrule.get('COUNT') ?? '0') || 0;
  const untilRaw = ev.rrule.get('UNTIL');
  const until = untilRaw ? parseIcsInstant(untilRaw)?.date : undefined;
  if (until && dayKey > until) return false;
  if (dayKey < ev.startDate) return false;

  const start = dayFromKey(ev.startDate);
  const target = dayFromKey(dayKey);
  const span = daysBetween(start, target);
  if (span < 0 || span > MAX_RECURRENCE_WALK_DAYS) return false;

  const byday = (ev.rrule.get('BYDAY') ?? '').split(',').filter(Boolean)
    .map((d) => d.replace(/^[+-]?\d+/, ''));  // ordinal BYDAY (1MO) → plain weekday
  const bymonthday = Number(ev.rrule.get('BYMONTHDAY') ?? '0') || start.getDate();

  const matches = (d: Date, daysFromStart: number): boolean => {
    switch (freq) {
      case 'DAILY':
        return daysFromStart % interval === 0;
      case 'WEEKLY': {
        const wd = WEEKDAY_CODES[d.getDay()];
        const inSet = byday.length > 0 ? byday.includes(wd) : d.getDay() === start.getDay();
        // Interval counts weeks from DTSTART's week (weeks begin on Monday).
        const mondayOffset = (dd: Date): number => (dd.getDay() + 6) % 7;
        const weeks = Math.floor((daysFromStart + mondayOffset(start)) / 7);
        return inSet && weeks % interval === 0;
      }
      case 'MONTHLY': {
        const months = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
        return d.getDate() === bymonthday && months % interval === 0;
      }
      case 'YEARLY':
        return d.getMonth() === start.getMonth() && d.getDate() === start.getDate()
          && (d.getFullYear() - start.getFullYear()) % interval === 0;
      default:
        return false;
    }
  };

  if (!matches(target, span)) return false;
  if (count > 0) {
    // The target only counts if it is within the first COUNT occurrences.
    let seen = 0;
    for (let i = 0; i <= span; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (matches(d, i)) {
        seen++;
        if (seen > count) return false;
      }
    }
  }
  return true;
}

// ── Today's glance events ──

/** Expand all feeds' events into today's remaining schedule: all-day first,
 *  then by start time; events already over are dropped; recurrence overrides
 *  (RECURRENCE-ID) replace their master instance. */
export function buildTodayEvents(events: IcsEvent[], now: Date): GlanceEvent[] {
  const today = dateKey(now);
  const nowHm = hmKey(now);
  const overridden = new Set(
    events.filter((e) => e.recurrenceId).map((e) => `${e.uid}@${e.recurrenceId}`),
  );

  const picked: { allDay: boolean; startHm: string; ev: GlanceEvent }[] = [];
  for (const e of events) {
    let onToday: boolean;
    if (e.recurrenceId) {
      onToday = e.startDate === today;  // override instance: literal date only
    } else {
      onToday = occursOn(e, today) && !(e.uid && overridden.has(`${e.uid}@${today}`));
      // Multi-day timed event started earlier and still running → show as all-day.
      if (!onToday && !e.rrule && e.startDate < today && (e.endDate ?? e.startDate) >= today) {
        picked.push({ allDay: true, startHm: '', ev: { title: trimTitle(e.summary) } });
        continue;
      }
    }
    if (!onToday) continue;
    const allDay = e.startHm === undefined;
    if (!allDay) {
      const endHm = e.endHm && e.startDate === (e.endDate ?? e.startDate) ? e.endHm : undefined;
      // Drop events that already ended (what's LEFT of today).
      if ((endHm ?? e.startHm!) < nowHm) continue;
      const ev: GlanceEvent = { startHm: e.startHm!, title: trimTitle(e.summary) };
      if (endHm) ev.endHm = endHm;
      picked.push({ allDay: false, startHm: e.startHm!, ev });
    } else {
      // DTEND of an all-day event is exclusive; a single-day event ends tomorrow.
      picked.push({ allDay: true, startHm: '', ev: { title: trimTitle(e.summary) } });
    }
  }

  picked.sort((a, b) =>
    a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.startHm.localeCompare(b.startHm));
  // Dedup (same title + time can arrive from two feeds).
  const seen = new Set<string>();
  const out: GlanceEvent[] = [];
  for (const p of picked) {
    const key = `${p.ev.startHm ?? ''}|${p.ev.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p.ev);
    if (out.length >= GLANCE_MAX_EVENTS) break;
  }
  return out;
}

const trimTitle = (s: string): string => trimUtf8Bytes(s, GLANCE_EVENT_TITLE_MAX_BYTES);

// ── Provider (fetch + cache), mirroring WeatherProvider ──

interface CacheEntry {
  key: string;
  at: number;
  events: IcsEvent[];
}

export class CalendarProvider {
  private cache: CacheEntry | null = null;
  private inflight: Promise<IcsEvent[] | undefined> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Today's remaining glance events for `cfg`, from cache when fresh.
   *  Resolves `undefined` when unconfigured or when no parse (fresh or
   *  stale-servable) exists — the glance simply omits the schedule. Today's
   *  filter always runs against the CURRENT clock, so a cached parse still
   *  drops events as they pass. Never throws. */
  async get(cfg: CalendarSettings | null, now: number = Date.now()): Promise<GlanceEvent[] | undefined> {
    if (!cfg) return undefined;
    const key = cfg.urls.join('\n');
    const cached = this.cache;
    if (cached && cached.key === key && now - cached.at < CALENDAR_CACHE_MS) {
      return buildTodayEvents(cached.events, new Date(now));
    }
    if (this.inflight) {
      const ev = await this.inflight;
      return ev ? buildTodayEvents(ev, new Date(now)) : undefined;
    }
    this.inflight = this.fetchFresh(cfg, key, now).finally(() => { this.inflight = null; });
    const ev = await this.inflight;
    return ev ? buildTodayEvents(ev, new Date(now)) : undefined;
  }

  private async fetchFresh(cfg: CalendarSettings, key: string, now: number): Promise<IcsEvent[] | undefined> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CALENDAR_FETCH_TIMEOUT_MS);
    try {
      const all: IcsEvent[] = [];
      for (const url of cfg.urls) {
        const res = await this.fetchImpl(url, { signal: ctl.signal });
        if (!res.ok) throw new Error(`ics HTTP ${res.status}`);
        all.push(...parseIcsEvents(await res.text()));
      }
      this.cache = { key, at: now, events: all };
      return all;
    } catch (err) {
      this.log(`[calendar] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      const cached = this.cache;
      if (cached && cached.key === key && now - cached.at < CALENDAR_STALE_SERVE_MS) return cached.events;
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
