import { describe, it, expect, vi } from 'vitest';
import {
  parseCalendarSettings,
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
