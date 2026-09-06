import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ files: new Map<string, string>(), credentials: '', recover: vi.fn() }));
vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>(),
  readFileSync: vi.fn((path: string) => {
    if (String(path).endsWith('.credentials.json')) return io.credentials;
    const data = io.files.get(String(path));
    if (data === undefined) throw Error('ENOENT');
    return data;
  }),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn((path: string, data: string) => io.files.set(String(path), data)),
}));
vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof import('child_process')>(),
  execSync: vi.fn(() => io.credentials),
}));
vi.mock('../claude-usage-recovery.js', () => ({ claudeUsageRecovery: { recover: io.recover } }));

let api: typeof import('../usage-api.js');
const live = { five_hour: { utilization: 12 }, seven_day: { utilization: 34 } };
const token = (name: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: name, expiresAt } });
const cachePath = () => [...io.files.keys()].find(p => p.endsWith('usage-cache.json'))!;

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  vi.stubEnv('AGENTDECK_CLAUDE_USAGE_RECOVERY', '1');
  io.files.clear(); io.recover.mockReset();
  io.credentials = token('initial', Date.now() + 3600_000);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(live))));
  api = await import('../usage-api.js');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('usage fetching and recovery', () => {
  // The 429 branch stamped `retryAfter` onto the snapshot read at the START of
  // the call, so a fresher reading another bridge wrote in between was rolled
  // back — a throttle response silently reverting live quota numbers (#286).
  it('stamps retryAfter onto the cache as it is now, not the snapshot it started with', async () => {
    const cacheFile = api.USAGE_CACHE_FILE;
    io.files.set(cacheFile, JSON.stringify({ data: { fiveHour: 1 }, fetchedAt: Date.now() - 10 * 60_000 }));
    vi.stubGlobal('fetch', vi.fn(async () => {
      // Another bridge polls the same file mid-call and writes a live reading.
      io.files.set(cacheFile, JSON.stringify({ data: { fiveHour: 99 }, fetchedAt: Date.now() }));
      return new Response('slow down', { status: 429, headers: { 'retry-after': '60' } });
    }));
    await api.fetchUsageFromApi();
    const written = JSON.parse(io.files.get(cacheFile)!);
    expect(written.data.fiveHour).toBe(99);
    expect(written.retryAfter).toBe(Date.now() + 60_000);
  });

  it('recovers an expired credential and retries with the newly read token in the same poll', async () => {
    io.credentials = token('expired', Date.now() - 1);
    api.enableClaudeUsageRecovery();
    io.recover.mockImplementation(async () => { io.credentials = token('renewed', Date.now() + 3600_000); });
    const result = await api.fetchUsageFromApi();
    expect(io.recover).toHaveBeenCalledWith('expired');
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer renewed' });
    expect(result?.fresh).toBe(true);
    expect(api.getTokenStatus()).toBe('valid');
  });

  it('does not claim success when CLI exits but leaves credentials expired', async () => {
    io.credentials = token('expired', Date.now() - 1);
    api.enableClaudeUsageRecovery();
    io.recover.mockResolvedValue(undefined);
    expect(await api.fetchUsageFromApi()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(api.getTokenStatus()).toBe('expired');
  });

  // Windows/Linux `CLAUDE_CODE_OAUTH_TOKEN` and `claude setup-token` credentials
  // carry no expiry at all, so the 401 memory is the ONLY signal that can open
  // the recovery branch for them. Gating the branch on `expiresAt` made this
  // combination silently unrecoverable.
  it('recovers a server-rejected credential that records no local expiry', async () => {
    io.credentials = JSON.stringify({ claudeAiOauth: { accessToken: 'noexp' } });
    api.enableClaudeUsageRecovery();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
    await api.fetchUsageFromApi();
    expect(io.recover).not.toHaveBeenCalled();
    io.recover.mockImplementation(async () => { io.credentials = token('renewed', Date.now() + 3600_000); });
    vi.setSystemTime(Date.now() + 60_000); // past the auth-failure backoff
    const result = await api.fetchUsageFromApi();
    expect(io.recover).toHaveBeenCalledWith('noexp');
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: 'Bearer renewed' });
    expect(result?.fresh).toBe(true);
  });

  it('recovers a server-rejected token even when its local expiry is in the future', async () => {
    api.enableClaudeUsageRecovery();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
    await api.fetchUsageFromApi();
    io.recover.mockImplementation(async () => { io.credentials = token('renewed', Date.now() + 3600_000); });
    expect((await api.fetchUsageFromApi())?.fresh).toBe(true);
    expect(io.recover).toHaveBeenCalledOnce();
  });

  it.each([false, true])('retries a transient 401 with an unchanged valid token (recovery=%s)', async enabled => {
    if (enabled) api.enableClaudeUsageRecovery();
    io.recover.mockResolvedValue(undefined); // missing CLI or no rotation necessary
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
    await api.fetchUsageFromApi();
    await api.fetchUsageFromApi();
    expect(fetch).toHaveBeenCalledTimes(1); // honor the normal auth backoff
    vi.advanceTimersByTime(45_000);
    expect((await api.fetchUsageFromApi())?.fresh).toBe(true);
    expect(api.getTokenStatus()).toBe('valid');
  });

  it('does not loop on a 403 by spending quota on authentication probes', async () => {
    api.enableClaudeUsageRecovery();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 403 }));
    await api.fetchUsageFromApi(); await api.fetchUsageFromApi();
    expect(io.recover).not.toHaveBeenCalled();
    expect(api.getTokenStatus()).toBe('unknown');
  });

  it('never spawns recovery from a session bridge or when opted out', async () => {
    io.credentials = token('expired', Date.now() - 1);
    await api.fetchUsageFromApi();
    api.enableClaudeUsageRecovery(); vi.stubEnv('AGENTDECK_CLAUDE_USAGE_RECOVERY', '0');
    await api.fetchUsageFromApi();
    expect(io.recover).not.toHaveBeenCalled();
  });

  it('uses a token with five minutes remaining rather than inventing early expiry', async () => {
    io.credentials = token('valid', Date.now() + 300_000);
    expect((await api.fetchUsageFromApi())?.fresh).toBe(true);
  });

  it('keeps Retry-After separate from freshness, including after module restart', async () => {
    await api.fetchUsageFromApi();
    const fetchedAt = JSON.parse(io.files.get(cachePath())!).fetchedAt;
    vi.advanceTimersByTime(120_000);
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '600' } }));
    expect((await api.fetchUsageFromApi())?.fresh).toBe(false);
    expect(JSON.parse(io.files.get(cachePath())!).fetchedAt).toBe(fetchedAt);
    vi.resetModules(); api = await import('../usage-api.js');
    vi.advanceTimersByTime(120_000);
    expect((await api.fetchUsageFromApi())?.fresh).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(480_000);
    expect((await api.fetchUsageFromApi())?.fresh).toBe(true);
  });

  it('honors Retry-After even without an existing cache', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '600' } }));
    await api.fetchUsageFromApi();
    vi.advanceTimersByTime(120_000); await api.fetchUsageFromApi();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates simultaneous API polls', async () => {
    await Promise.all([api.fetchUsageFromApi(), api.fetchUsageFromApi()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('backs off from failures even without a successful cache and recovers on rotation', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(Error('offline'));
    await api.fetchUsageFromApi(); await api.fetchUsageFromApi();
    expect(fetch).toHaveBeenCalledTimes(1);
    io.credentials = token('new', Date.now() + 3600_000);
    expect((await api.fetchUsageFromApi())?.fresh).toBe(true);
  });
});
