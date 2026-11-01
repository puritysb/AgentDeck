/** Bounded RFC 5545 subset. Policy and parity vectors are shared with Swift. */
import type { GlanceEvent } from '@agentdeck/shared';
import { GLANCE_MAX_EVENTS, GLANCE_EVENT_TITLE_MAX_BYTES } from '@agentdeck/shared';
import { CALENDAR_POLICY as P } from './calendar-policy.generated.js';

type Civil = number[]; // year, month, day, hour, minute, second
interface Instant { civil: Civil; zone?: string; dateOnly: boolean }
export interface IcsEvent {
  uid: string; summary: string; startDate: string; startHm?: string; endDate?: string; endHm?: string;
  start: Instant; end?: Instant; rule?: Record<string, string>; exclusions: Instant[]; recurrence?: Instant; cancelled: boolean;
}
const utc = (c: Civil) => { const d = new Date(0); d.setUTCFullYear(c[0], c[1] - 1, c[2]); d.setUTCHours(c[3], c[4], c[5], 0); return d.getTime(); };
const fromUTC = (ms: number): Civil => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]; };
const day = (c: Civil) => utc([...c.slice(0, 3), 0, 0, 0]);
const pad = (n: number) => String(n).padStart(2, '0');
const date = (c: Civil) => `${String(c[0]).padStart(4, '0')}${pad(c[1])}${pad(c[2])}`;
const hm = (c: Civil) => `${pad(c[3])}:${pad(c[4])}`;
const defaultZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 64) formatters.clear();
    formatters.set(zone, f);
  }
  return f;
}
function parts(ms: number, zone: string): Civil {
  const p = Object.fromEntries(formatter(zone).formatToParts(ms).map(x => [x.type, x.value]));
  return [p.year, p.month, p.day, p.hour, p.minute, p.second].map(Number);
}
function decodeText(value: string): string {
  let out = '', escaped = false;
  for (const c of value) {
    if (escaped) { out += /[nN]/.test(c) ? ' ' : /[,;\\]/.test(c) ? c : '\\' + c; escaped = false; }
    else if (c === '\\') escaped = true; else out += c;
  }
  return (out + (escaped ? '\\' : '')).trim();
}
function instant(value: string, zone?: string): Instant | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
  if (!m || (zone && (m[7] || !m[4] || !/^(UTC|GMT|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(zone)))) return;
  const civil = m.slice(1, 7).map(x => Number(x ?? 0));
  if (civil[0] < P.minYear || civil[0] > P.maxYear || fromUTC(utc(civil)).some((v, i) => v !== civil[i])) return;
  if (zone) { try { formatter(zone); } catch { return; } }
  return { civil, dateOnly: !m[4], zone: m[7] ? 'UTC' : zone };
}
/** First overlap occurrence; explicit gap uses the pre-gap offset. Recurrences skip gaps. */
function resolve(t: Instant, displayZone: string, recurrence = false): number | undefined {
  const zone = t.zone ?? displayZone, wall = utc(t.civil);
  const offsets = [...new Set(P.offsetSamplesHours.map(h => { const ms = wall + h * 3600000; return utc(parts(ms, zone)) - ms; }))];
  const matches = offsets.map(o => wall - o).filter(ms => parts(ms, zone).every((v, i) => v === t.civil[i]));
  return matches.length ? Math.min(...matches) : recurrence ? undefined : wall - Math.min(...offsets);
}
function key(t: Instant, zone: string): string { return t.dateOnly ? 'D' + date(t.civil) : 'T' + resolve(t, zone); }
export function unfoldIcsLines(text: string): string[] {
  if (Buffer.byteLength(text) > P.maxBodyBytes) throw new Error('calendar_limit');
  const out: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
    else if (line) out.push(line);
    if (out.length && Buffer.byteLength(out[out.length - 1]) > P.maxLineBytes) throw new Error('calendar_limit');
  }
  return out;
}
export function parseIcsInstant(value: string): { date: string; hm?: string } | null {
  const t = instant(value); if (!t) return null;
  const c = t.zone ? parts(resolve(t, defaultZone())!, defaultZone()) : t.civil;
  return { date: date(c), ...(t.dateOnly ? {} : { hm: hm(c) }) };
}
export function parseIcsEvents(text: string, namespace = ''): IcsEvent[] {
  const lines = unfoldIcsLines(text);
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR') throw new Error('invalid_calendar');
  const out: IcsEvent[] = []; let props: Array<[string, string, string | undefined]> | undefined; let depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { if (props) throw new Error('invalid_calendar'); props = []; depth = 1; continue; }
    if (!props) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:') && line !== 'END:VEVENT') { depth--; continue; }
    if (line === 'END:VEVENT') {
      const get = (name: string) => props!.filter(p => p[0] === name);
      const one = (name: string) => { const rows = get(name); return rows.length === 1 ? rows[0] : undefined; };
      const stamp = (name: string) => { const p = one(name); return p && instant(p[1], p[2]); };
      const recurrence = stamp('RECURRENCE-ID'), start = stamp('DTSTART') ?? recurrence;
      const summary = decodeText(one('SUMMARY')?.[1] ?? '');
      const cancelled = one('STATUS')?.[1] === 'CANCELLED';
      const ruleRaw = one('RRULE')?.[1];
      const rule: Record<string, string> | undefined = ruleRaw ? Object.fromEntries(ruleRaw.split(';').map(s => s.split('='))) : undefined;
      const allowed = !rule || (ruleRaw!.split(';').every(s => /^[A-Z]+=[^=;]+$/.test(s)) && ruleRaw!.split(';').length === Object.keys(rule).length &&
        !(rule.FREQ === 'WEEKLY' && rule.BYMONTHDAY) && !(rule.FREQ === 'YEARLY' && (rule.BYDAY || rule.BYMONTHDAY)) && Object.keys(rule).every(k => (P.ruleKeys as readonly string[]).includes(k)) &&
        (P.frequencies as readonly string[]).includes(rule.FREQ) && (!rule.WKST || rule.WKST === 'MO') &&
        ['INTERVAL', 'COUNT'].every(k => !rule[k] || /^[1-9]\d{0,5}$/.test(rule[k])) &&
        (!rule.COUNT || !rule.UNTIL) && (!rule.UNTIL || instant(rule.UNTIL)) &&
        (!rule.BYDAY || rule.BYDAY.split(',').every(d => /^([+-]?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$/.test(d))) &&
        (!(rule.FREQ === 'DAILY' || rule.FREQ === 'WEEKLY') || !rule.BYDAY || rule.BYDAY.split(',').every(d => /^[A-Z]{2}$/.test(d))) &&
        (!rule.BYMONTHDAY || rule.BYMONTHDAY.split(',').every(d => /^-?([1-9]|[12]\d|3[01])$/.test(d))));
      const end = stamp('DTEND');
      const exclusions: Instant[] = []; let validExclusions = true;
      for (const p of get('EXDATE')) for (const value of p[1].split(',')) {
        const t = instant(value, p[2]); if (t) exclusions.push(t); else validExclusions = false;
      }
      if (depth === 1 && start && ['UID','SUMMARY','DTSTART','DTEND','RRULE','RECURRENCE-ID','STATUS'].every(n => get(n).length <= 1) &&
          (!get('DTSTART').length || stamp('DTSTART')) && (!recurrence || !!one('UID')?.[1]) && (summary || cancelled) && allowed && validExclusions &&
          !get('RDATE').length && !get('DURATION').length && !get('EXRULE').length &&
          (!get('DTEND').length || end) && (!get('RECURRENCE-ID').length || recurrence) &&
          !props.some(p => p[0] === 'UNSUPPORTED')) {
        out.push({ uid: namespace + '\u0000' + (one('UID')?.[1] ?? ''), summary, start, end, rule, exclusions, recurrence, cancelled,
          startDate: date(start.civil), ...(start.dateOnly ? {} : { startHm: hm(start.civil) }),
          ...(end ? { endDate: date(end.civil), ...(end.dateOnly ? {} : { endHm: hm(end.civil) }) } : {}) });
        if (out.length > P.maxEvents) throw new Error('calendar_limit');
      }
      props = undefined; continue;
    }
    if (depth !== 1) continue;
    const colon = line.indexOf(':'); if (colon < 0) continue;
    const lhs = line.slice(0, colon).split(';'), name = lhs[0].toUpperCase();
    const zone = lhs.slice(1).find(p => p.startsWith('TZID='))?.slice(5).replace(/^"|"$/g, '');
    if (lhs.some(p => p.startsWith('RANGE='))) props.push(['UNSUPPORTED', '', undefined]);
    props.push([name, line.slice(colon + 1).trim(), zone]);
  }
  if (props) throw new Error('invalid_calendar');
  return out;
}
function matches(e: IcsEvent, c: Civil, offset: number): boolean {
  const r = e.rule!, start = e.start.civil, interval = Number(r.INTERVAL ?? 1), wd = new Date(day(c)).getUTCDay();
  const monthDays = new Date(Date.UTC(c[0], c[1], 0)).getUTCDate();
  const byDay = !r.BYDAY || r.BYDAY.split(',').some(v => {
    const name = v.slice(-2); if (P.weekdays[wd] !== name) return false;
    const ord = Number(v.slice(0, -2)); return !ord || (ord > 0 ? Math.floor((c[2] - 1) / 7) + 1 === ord : -(Math.floor((monthDays - c[2]) / 7) + 1) === ord);
  });
  const byMonthDay = !r.BYMONTHDAY || r.BYMONTHDAY.split(',').some(v => c[2] === (Number(v) > 0 ? Number(v) : monthDays + Number(v) + 1));
  if (!byDay || !byMonthDay) return false;
  switch (r.FREQ) {
    case 'DAILY': return offset % interval === 0;
    case 'WEEKLY': return Math.floor((offset + (new Date(day(start)).getUTCDay() + 6) % 7) / 7) % interval === 0 && (r.BYDAY ? true : wd === new Date(day(start)).getUTCDay());
    case 'MONTHLY': return ((c[0] - start[0]) * 12 + c[1] - start[1]) % interval === 0 && (r.BYDAY || r.BYMONTHDAY ? true : c[2] === start[2]);
    case 'YEARLY': return (c[0] - start[0]) % interval === 0 && c[1] === start[1] && (r.BYDAY || r.BYMONTHDAY ? true : c[2] === start[2]);
    default: return false;
  }
}
function occurrences(e: IcsEvent, lastDay: number, zone: string, budget: { walks: number; occurrences: number }): Instant[] {
  if (!e.rule) return [e.start];
  const startDay = day(e.start.civil), span = Math.floor((lastDay - startDay) / P.dayMs);
  if (span < 0 || span > P.maxWalkDays) return [];
  const count = Number(e.rule.COUNT ?? Infinity), until = e.rule.UNTIL ? instant(e.rule.UNTIL, e.start.zone && !e.rule.UNTIL.endsWith('Z') ? e.start.zone : undefined) : undefined;
  let seen = 0; const out: Instant[] = [];
  for (let i = 0; i <= span; i++) {
    if (++budget.walks > P.maxWalkSteps) throw new Error('calendar_limit');
    const civil = [...fromUTC(startDay + i * P.dayMs).slice(0, 3), ...e.start.civil.slice(3)];
    if (!matches(e, civil, i)) continue;
    const t = { ...e.start, civil }, at = resolve(t, zone, i !== 0); if (at === undefined) continue;
    if (until && (until.dateOnly ? date(civil) > date(until.civil) : at > resolve(until, zone)!)) break;
    if (++seen > count) break;
    if (++budget.occurrences > P.maxOccurrences) throw new Error('calendar_limit');
    out.push(t);
  }
  return out;
}
export function occursOn(e: IcsEvent, dayKey: string): boolean {
  const t = instant(dayKey); if (!t) return false;
  return occurrences(e, day(t.civil), defaultZone(), { walks: 0, occurrences: 0 }).some(o => date(o.civil) === dayKey && !e.exclusions.some(x => key(x, defaultZone()) === key(o, defaultZone())));
}
export function buildTodayEvents(events: IcsEvent[], now: Date, zone = defaultZone()): GlanceEvent[] {
  formatter(zone);
  const c = parts(now.getTime(), zone), today = { civil: [...c.slice(0, 3), 0, 0, 0], dateOnly: false, zone };
  const tomorrow = { ...today, civil: fromUTC(day(c) + P.dayMs) };
  const lo = resolve(today, zone)!, hi = resolve(tomorrow, zone)!, clock = Math.floor(now.getTime() / P.minuteMs) * P.minuteMs;
  const overrides = new Set(events.filter(e => e.recurrence).map(e => e.uid + '@' + key(e.recurrence!, zone)));
  const picked: { at: number; event: GlanceEvent }[] = [], budget = { walks: 0, occurrences: 0 };
  for (const e of events) {
    if (e.cancelled) continue;
    const first = resolve(e.start, zone)!, end = e.end && resolve(e.end, zone);
    if (e.end && (e.end.dateOnly !== e.start.dateOnly || end! <= first)) continue;
    const durationDays = e.start.dateOnly ? Math.max(1, e.end ? (day(e.end.civil) - day(e.start.civil)) / P.dayMs : 1) : 0;
    const duration = end === undefined ? 0 : end - first;
    const targetDay = day(parts(hi - 1, e.start.zone ?? zone)) + P.dayMs;
    for (const t of occurrences(e, targetDay, zone, budget)) {
      if (!e.recurrence && overrides.has(e.uid + '@' + key(t, zone))) continue;
      if (!e.recurrence && e.exclusions.some(x => key(x, zone) === key(t, zone))) continue;
      const start = resolve(t, zone, !!e.rule && t.civil.some((v, i) => v !== e.start.civil[i])) ; if (start === undefined) continue;
      const finish = e.start.dateOnly ? resolve({ ...t, civil: fromUTC(day(t.civil) + durationDays * P.dayMs) }, zone)! : start + duration;
      if (start >= hi || (e.start.dateOnly ? finish <= lo : e.end ? finish <= Math.max(lo, clock) : finish < Math.max(lo, clock))) continue;
      const startC = parts(start, zone), endC = parts(finish, zone);
      const allDay = e.start.dateOnly || date(startC) !== date(endC);
      let title = ''; for (const scalar of e.summary) { if (Buffer.byteLength(title + scalar) > GLANCE_EVENT_TITLE_MAX_BYTES) break; title += scalar; }
      const event: GlanceEvent = { title };
      if (!allDay) { event.startHm = hm(startC); if (e.end) event.endHm = hm(endC); }
      picked.push({ at: allDay ? -Infinity : start, event });
    }
  }
  picked.sort((a, b) => a.at - b.at);
  const seen = new Set<string>(); return picked.map(p => p.event).filter(e => { const k = (e.startHm ?? '') + '|' + e.title; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, GLANCE_MAX_EVENTS);
}
