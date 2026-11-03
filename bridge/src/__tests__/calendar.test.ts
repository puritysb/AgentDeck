import { parseIcsCalendar } from '../calendar-ics.js';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CALENDAR_POLICY as CP } from '../calendar-policy.generated.js';
import { outputs } from '../../../scripts/generate-calendar-policy.mjs';
import { describe, it, expect, vi } from 'vitest';
import {
  parseCalendarSettings,
  validCalendarURL,
  unfoldIcsLines,
  parseIcsInstant,
  parseIcsEvents,
  occursOn,
  buildTodayEvents,
  CalendarProvider,
  CALENDAR_CACHE_MS,
} from '../calendar.js';

// A fixed local instant: 2026-08-04 (Tue) 09:00.
const NOW = new Date(2026, 7, 4, 9, 0);

const ics = (body: string): string =>
  `BEGIN:VCALENDAR\r\n${body}\r\nEND:VCALENDAR\r\n`;

const vevent = (lines: string[]): string =>
  ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');

describe('parseCalendarSettings', () => {
  it('accepts a single url or a list, rejects everything else', () => {
    expect(parseCalendarSettings({ calendar: { ics: 'https://x/a.ics' } }))
      .toEqual({ urls: ['https://x/a.ics'] });
    expect(parseCalendarSettings({ calendar: { ics: ['https://x/a.ics', 'https://x/b.ics'] } }))
      .toEqual({ urls: ['https://x/a.ics', 'https://x/b.ics'] });
    expect(parseCalendarSettings({})).toBeNull();
    expect(parseCalendarSettings({ calendar: { ics: 'file:///etc/passwd' } })).toBeNull();
    expect(parseCalendarSettings({ calendar: { ics: 42 } })).toBeNull();
  });
});

describe('ICS parsing', () => {
  it('unfolds continuation lines', () => {
    expect(unfoldIcsLines('SUMMARY:Hello\r\n  world\r\nUID:1')).toEqual(['SUMMARY:Hello world', 'UID:1']);
  });

  it('parses date, local, and UTC instants', () => {
    expect(parseIcsInstant('20260804')).toEqual({ date: '20260804' });
    expect(parseIcsInstant('20260804T093000')).toEqual({ date: '20260804', hm: '09:30' });
    // UTC converts through the daemon clock — assert round-trip consistency
    // rather than a fixed zone.
    const z = parseIcsInstant('20260804T000000Z');
    const local = new Date(Date.UTC(2026, 7, 4, 0, 0));
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(z).toEqual({
      date: `${local.getFullYear()}${pad(local.getMonth() + 1)}${pad(local.getDate())}`,
      hm: `${pad(local.getHours())}:${pad(local.getMinutes())}`,
    });
    expect(parseIcsInstant('garbage')).toBeNull();
  });

  it('parses VEVENTs with summary escaping and TZID params', () => {
    const events = parseIcsEvents(ics(vevent([
      'UID:e1',
      'DTSTART;TZID=Asia/Seoul:20260804T140000',
      'DTEND;TZID=Asia/Seoul:20260804T150000',
      'SUMMARY:Demo\\, part 1',
    ])));
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Demo, part 1');
    expect(events[0].startDate).toBe('20260804');
    expect(events[0].startHm).toBe('14:00');
    expect(events[0].endHm).toBe('15:00');
  });
});

describe('occursOn (recurrence)', () => {
  const base = (rrule: string, start = 'DTSTART:20260707T100000') =>
    parseIcsEvents(ics(vevent(['UID:r1', start, `RRULE:${rrule}`, 'SUMMARY:R'])))[0];

  it('non-recurring: literal date only', () => {
    const e = parseIcsEvents(ics(vevent(['UID:x', 'DTSTART:20260804T100000', 'SUMMARY:S'])))[0];
    expect(occursOn(e, '20260804')).toBe(true);
    expect(occursOn(e, '20260805')).toBe(false);
  });

  it('DAILY with INTERVAL and UNTIL', () => {
    const e = base('FREQ=DAILY;INTERVAL=2');
    expect(occursOn(e, '20260804')).toBe(true);   // 28 days after 07-07
    expect(occursOn(e, '20260805')).toBe(false);  // off-interval day
    const u = base('FREQ=DAILY;UNTIL=20260801T000000');
    expect(occursOn(u, '20260804')).toBe(false);
  });

  it('WEEKLY honors BYDAY', () => {
    // 2026-08-04 is a Tuesday.
    const e = base('FREQ=WEEKLY;BYDAY=TU,TH');
    expect(occursOn(e, '20260804')).toBe(true);
    expect(occursOn(e, '20260805')).toBe(false);  // Wednesday
  });

  it('DAILY COUNT exhausts', () => {
    const e = base('FREQ=DAILY;COUNT=5');  // 07-07..07-11
    expect(occursOn(e, '20260711')).toBe(true);
    expect(occursOn(e, '20260712')).toBe(false);
    expect(occursOn(e, '20260804')).toBe(false);
  });

  it('MONTHLY and YEARLY match the start day', () => {
    const m = base('FREQ=MONTHLY', 'DTSTART:20260104T100000');
    expect(occursOn(m, '20260804')).toBe(true);
    expect(occursOn(m, '20260805')).toBe(false);
    const y = base('FREQ=YEARLY', 'DTSTART:20250804T100000');
    expect(occursOn(y, '20260804')).toBe(true);
  });

  it('EXDATE removes an instance', () => {
    const e = parseIcsEvents(ics(vevent([
      'UID:r2', 'DTSTART:20260707T100000', 'RRULE:FREQ=DAILY',
      'EXDATE:20260804T100000', 'SUMMARY:R',
    ])))[0];
    expect(occursOn(e, '20260804')).toBe(false);
    expect(occursOn(e, '20260803')).toBe(true);
  });
});

describe('buildTodayEvents', () => {
  it('keeps only what is left of today, all-day first, capped and sorted', () => {
    const events = parseIcsEvents(ics([
      vevent(['UID:a', 'DTSTART:20260804T080000', 'DTEND:20260804T083000', 'SUMMARY:Past standup']),
      vevent(['UID:b', 'DTSTART:20260804T140000', 'DTEND:20260804T150000', 'SUMMARY:Demo']),
      vevent(['UID:c', 'DTSTART:20260804T100000', 'SUMMARY:Call']),
      vevent(['UID:d', 'DTSTART;VALUE=DATE:20260804', 'DTEND;VALUE=DATE:20260805', 'SUMMARY:Holiday']),
      vevent(['UID:e', 'DTSTART:20260805T090000', 'SUMMARY:Tomorrow thing']),
    ].join('\r\n')));
    expect(buildTodayEvents(events, NOW)).toEqual([
      { title: 'Holiday' },                                   // all-day first
      { startHm: '10:00', title: 'Call' },
      { startHm: '14:00', endHm: '15:00', title: 'Demo' },
    ]);  // past standup dropped, tomorrow dropped, cap = 3
  });

  it('an in-progress event survives the past filter via its end time', () => {
    const events = parseIcsEvents(ics(vevent([
      'UID:f', 'DTSTART:20260804T083000', 'DTEND:20260804T093000', 'SUMMARY:Ongoing',
    ])));
    expect(buildTodayEvents(events, NOW)).toEqual([
      { startHm: '08:30', endHm: '09:30', title: 'Ongoing' },
    ]);
  });

  it('RECURRENCE-ID override replaces the master instance', () => {
    const events = parseIcsEvents(ics([
      vevent(['UID:r', 'DTSTART:20260707T100000', 'RRULE:FREQ=DAILY', 'SUMMARY:Standup']),
      vevent(['UID:r', 'RECURRENCE-ID:20260804T100000', 'DTSTART:20260804T110000', 'SUMMARY:Standup (moved)']),
    ].join('\r\n')));
    expect(buildTodayEvents(events, NOW)).toEqual([
      { startHm: '11:00', title: 'Standup (moved)' },
    ]);
  });

  it('trims titles to the UTF-8 byte budget', () => {
    const long = '아주긴한글제목'.repeat(10);
    const events = parseIcsEvents(ics(vevent([
      'UID:g', 'DTSTART:20260804T120000', `SUMMARY:${long}`,
    ])));
    const [ev] = buildTodayEvents(events, NOW);
    expect(new TextEncoder().encode(ev.title).length).toBeLessThanOrEqual(48);
  });
});

describe('CalendarProvider', () => {
  const BODY = ics(vevent(['UID:p', 'DTSTART:20260804T140000', 'SUMMARY:Demo']));

  it('fetches, caches, and re-filters cached parses against the current clock', async () => {
    const fetchImpl = vi.fn(async () => new Response(BODY, { status: 200 }));
    const p = new CalendarProvider(fetchImpl as unknown as typeof fetch);
    const cfg = { urls: ['https://x/a.ics'] };
    const t0 = NOW.getTime();
    expect(await p.get(cfg, t0)).toEqual([{ startHm: '14:00', title: 'Demo' }]);
    expect(await p.get(cfg, t0 + CALENDAR_CACHE_MS - 1000)).toEqual([{ startHm: '14:00', title: 'Demo' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Same cache, later clock: the 14:00 event has passed.
    const evening = new Date(2026, 7, 4, 18, 0).getTime();
    // (cache expired by then — refetch serves the same body)
    expect(await p.get(cfg, evening)).toEqual([]);
  });

  it('resolves undefined when unconfigured or on a cold failure', async () => {
    const failing = vi.fn(async () => { throw new Error('down'); });
    const p = new CalendarProvider(failing as unknown as typeof fetch);
    expect(await p.get(null)).toBeUndefined();
    expect(await p.get({ urls: ['https://x/a.ics'] }, NOW.getTime())).toBeUndefined();
  });
});

const calendarVectors = JSON.parse(readFileSync('shared/calendar-vectors.json', 'utf8')) as Array<{ name: string; ics: string; nowMs: number; zone: string; expected: unknown; expectedSkipped?: Record<string, number> }>;
describe('shared calendar contract', () => {
  it.each(calendarVectors.filter(v => v.expectedSkipped))('reports content-free omissions: $name', v => {
    const parsed = parseIcsCalendar(v.ics);
    expect(parsed.skippedByReason).toEqual(v.expectedSkipped);
    expect(parsed.skippedEvents).toBe(1);
  });
  it('keeps generated policy and wire bounds current', () => { for (const {path, expected} of outputs()) expect(readFileSync(path, 'utf8')).toBe(expected); });
  it.each(calendarVectors)('$name', v => { expect(buildTodayEvents(parseIcsEvents(v.ics), new Date(v.nowMs), v.zone)).toEqual(v.expected); });
  it.skipIf(process.platform !== 'darwin')('executes the actual Swift parser on every shared vector', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-swift-'));
    try {
      const binary = join(dir, 'calendar');
      execFileSync('swiftc', ['-module-cache-path',join(dir,'modules'),'-parse-as-library','apple/AgentDeck/Daemon/Server/CalendarPolicy.generated.swift','apple/AgentDeck/Daemon/Server/CalendarICS.swift','apple/AgentDeck/Daemon/Server/CalendarConnection.swift','apple/AgentDeck/Daemon/Server/CalendarProvider.swift','bridge/src/__tests__/fixtures/calendar-main.swift','-o',binary], { timeout:120000 });
      const native = JSON.parse(execFileSync(binary, { input:JSON.stringify(calendarVectors),encoding:'utf8',timeout:30000 }));
      expect(native).toEqual(calendarVectors.map(v => v.expected));
      const omitted = calendarVectors.filter(v => v.expectedSkipped);
      expect(JSON.parse(execFileSync(binary, ['--diagnostics'], {input:JSON.stringify(omitted),encoding:'utf8',timeout:15000}))).toEqual(omitted.map(v => v.expectedSkipped));
      expect(JSON.parse(execFileSync(binary, ['--provider-diagnostics'], {input:JSON.stringify(omitted),encoding:'utf8',timeout:15000}))).toEqual(omitted.map(v => ({status:'fresh', fetchedAt:v.nowMs, skippedEvents:1,skippedByReason:v.expectedSkipped})));
      const urls = JSON.parse(readFileSync('shared/calendar-url-vectors.json','utf8')) as Array<{value:string;valid:boolean}>;
      expect(JSON.parse(execFileSync(binary,['--urls'],{input:JSON.stringify(urls),encoding:'utf8',timeout:15000}))).toEqual(urls.map(v => v.valid));
      const cases = JSON.parse(readFileSync('shared/calendar-cache-vectors.json','utf8'));
      const swiftCache = JSON.parse(execFileSync(binary, ['--cache'], { input:JSON.stringify(cases),encoding:'utf8',timeout:30000 }));
      expect(swiftCache).toEqual(cases.map((v: any) => v.steps.map((s: any) => ({ status:s.status, requests:s.requests, ...(s.events === undefined ? {} : {events:s.events}), ...(s.stamp === undefined ? {} : {fetchedAt:v.nowMs+s.stamp}) }))));
    } finally { rmSync(dir,{recursive:true,force:true}); }
  },150000);
});

describe('calendar cache contract', () => {
  const cases = JSON.parse(readFileSync('shared/calendar-cache-vectors.json','utf8')) as Array<{name:string;body:string;nowMs:number;steps:Array<{delta:number;fail?:boolean;disabled?:boolean;source?:string;status:string;events?:unknown;stamp?:number;requests:number}>}>;
  it.each(cases)('$name', async v => {
    let fail = false;
    const fetcher = vi.fn(async () => { if (fail) throw new Error('secret URL must not reach logs'); return new Response(v.body); });
    const logs:string[] = [], provider = new CalendarProvider(fetcher as typeof fetch, s => logs.push(s));
    for (const s of v.steps) {
      fail = s.fail === true;
      const cfg = s.disabled ? null : { urls:['https://calendar.invalid/' + (s.source ?? 'a')], timeZone:'UTC' };
      const snapshot = await provider.snapshot(cfg,v.nowMs+s.delta);
      const { skippedEvents, skippedByReason, ...visible } = snapshot;
      if (snapshot.events) { expect(skippedEvents).toBe(0); expect(skippedByReason).toEqual({unsupported_zone:0,unsupported_rule:0,invalid_event:0}); }
      expect({...visible, requests:fetcher.mock.calls.length}).toEqual({status:s.status,requests:s.requests,...(s.events === undefined ? {} : {events:s.events}),...(s.stamp === undefined ? {} : {fetchedAt:v.nowMs+s.stamp})});
    }
    expect(logs.every(s => s === '[calendar] fetch failed')).toBe(true);
  });
  it('never publishes a revoked in-flight result or borrows another source job', async () => {
    let resolve!: (r:Response)=>void;
    const provider = new CalendarProvider((() => new Promise<Response>(r => { resolve = r; })) as typeof fetch);
    const pending = provider.snapshot({urls:['https://calendar.invalid/secret']},NOW.getTime());
    await provider.snapshot(null,NOW.getTime());
    resolve(new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR'));
    expect(await pending).toEqual({status:'disabled'});
  });
});

it('validates the same explicit source URL scope', () => {
  const urls = JSON.parse(readFileSync('shared/calendar-url-vectors.json','utf8')) as Array<{value:string;valid:boolean}>;
  for (const v of urls) expect(validCalendarURL(v.value),v.value).toBe(v.valid);
});

describe('calendar network bounds', () => {
  it('keeps concurrent sources isolated even when a cancelled transport returns late', async () => {
    const resolvers: Array<(response:Response)=>void> = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => resolvers.push(resolve)));
    const p = new CalendarProvider(fetcher as typeof fetch);
    const cfg = (id:string) => ({urls:['https://calendar.invalid/'+id],timeZone:'UTC'});
    const a = p.snapshot(cfg('A'),NOW.getTime()), b = p.snapshot(cfg('B'),NOW.getTime());
    const body = (title:string) => ics(vevent(['UID:x','DTSTART;VALUE=DATE:20260804','SUMMARY:'+title]));
    resolvers[0](new Response(body('secret A')));
    expect(await a).toEqual({status:'disabled'});
    resolvers[1](new Response(body('B')));
    expect((await b).events).toEqual([{title:'B'}]);
    expect((await p.snapshot(cfg('B'),NOW.getTime())).events).toEqual([{title:'B'}]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('bounds silent requests with an abort deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = ((_url:unknown, init?:RequestInit) => new Promise<Response>((_resolve,reject) => init!.signal!.addEventListener('abort',() => reject(new Error('aborted'))))) as typeof fetch;
      const p = new CalendarProvider(fetcher);
      const pending = p.snapshot({urls:['https://calendar.invalid/silent']},NOW.getTime());
      await vi.advanceTimersByTimeAsync(CP.timeoutMs+1);
      expect(await pending).toEqual({status:'unknown'});
    } finally { vi.useRealTimers(); }
  });
  it('refuses oversized and malformed successful replies without logging secret-bearing errors', async () => {
    for (const body of ['<html>not a calendar</html>', 'x'.repeat(CP.maxBodyBytes+1)]) {
      const p = new CalendarProvider((async () => new Response(body)) as typeof fetch);
      expect(await p.snapshot({urls:['https://calendar.invalid/private']},NOW.getTime())).toEqual({status:'unknown'});
    }
  });
});


describe('content-free calendar diagnostics', () => {
  it('reports skipped entries without another network request and clears them on disconnect', async () => {
    const fixture = calendarVectors.find(v => v.name === 'unknown-zone' && v.expectedSkipped !== undefined)!;
    const fetcher = vi.fn(async () => new Response(fixture.ics));
    const provider = new CalendarProvider(fetcher as typeof fetch);
    expect(provider.diagnostics(fixture.nowMs)).toEqual({status:'disabled'});
    const result = await provider.snapshot({urls:['https://calendar.invalid/private-source'],timeZone:'UTC'},fixture.nowMs);
    expect(result).toEqual({status:'fresh',events:[],fetchedAt:fixture.nowMs,skippedEvents:1,skippedByReason:fixture.expectedSkipped});
    expect(provider.diagnostics(fixture.nowMs)).toEqual({status:'fresh',fetchedAt:fixture.nowMs,skippedEvents:1,skippedByReason:fixture.expectedSkipped});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(provider.diagnostics(fixture.nowMs + CP.staleMs)).toEqual({status:'unknown'});
    await provider.snapshot(null,fixture.nowMs);
    expect(provider.diagnostics(fixture.nowMs)).toEqual({status:'disabled'});
  });
});
