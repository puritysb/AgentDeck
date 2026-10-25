import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { readCodexAuthStatus, resolveChatGptRenewalDate } from '../codex-auth.js';

const vectors = JSON.parse(fs.readFileSync('shared/codex-renewal-vectors.json', 'utf8')) as {
  name: string; activeUntil: string | null; now: string; expected: string | null;
}[];

describe('resolveChatGptRenewalDate', () => {
  it.each(vectors)('$name', ({ activeUntil, now, expected }) => {
    expect(resolveChatGptRenewalDate(activeUntil ?? undefined, new Date(now))).toBe(expected ?? undefined);
  });
});

describe('readCodexAuthStatus renewal source', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  function authWithWindow(until: string | undefined, start?: string): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
    const payload = { 'https://api.openai.com/auth': {
      chatgpt_plan_type: 'pro',
      chatgpt_subscription_active_start: start,
      chatgpt_subscription_active_until: until,
    } };
    const raw = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      id_token: `test.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test`,
    } });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(raw);
  }

  it('does not turn a multi-month auth snapshot into a two-month billing cycle', () => {
    authWithWindow('2026-10-10T12:28:05+00:00', '2026-08-10T00:09:48+00:00');
    expect(readCodexAuthStatus()).toMatchObject({
      planType: 'pro', subscriptionActiveUntil: '2026-11-10T12:28:05.000Z',
    });
  });

  it('prefers a future reported end over any monthly estimate', () => {
    authWithWindow('2026-12-11T00:46:22+00:00', '2026-08-10T00:09:48+00:00');
    expect(readCodexAuthStatus()?.subscriptionActiveUntil).toBe('2026-12-11T00:46:22+00:00');
  });

  it('can estimate from a past end without a start', () => {
    authWithWindow('2026-10-10T12:28:05Z');
    expect(readCodexAuthStatus()?.subscriptionActiveUntil).toBe('2026-11-10T12:28:05.000Z');
  });

  it('does not invent a date when only a start is known', () => {
    authWithWindow(undefined, '2026-08-10T00:09:48Z');
    expect(readCodexAuthStatus()?.subscriptionActiveUntil).toBeUndefined();
  });
});
