import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { beforeEach, expect, it, vi } from 'vitest';
import { LIMITS } from '../contracts.js';
import { sendPublic } from '../webhook.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));

beforeEach(() => { vi.resetAllMocks(); });
function transport(status: number, data: string) {
  vi.mocked(request).mockImplementation(((_url: URL, _options: unknown, receive: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const res = new PassThrough() as PassThrough & { statusCode: number };
      res.statusCode = status; receive(res); res.end(data);
    };
    return req;
  }) as typeof request);
}
it('pins vetted DNS answers for both Node lookup modes while preserving the TLS hostname', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  transport(200, '{}');
  await sendPublic('https://receiver.example/event', '{}', {});
  const [url, opts] = vi.mocked(request).mock.calls[0] as any;
  expect(url.hostname).toBe('receiver.example'); expect(opts.agent).toBe(false);
  expect(opts.signal).toBeInstanceOf(AbortSignal);
  const all = vi.fn(), one = vi.fn();
  opts.lookup('receiver.example', { all: true }, all);
  opts.lookup('receiver.example', {}, one);
  expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
  expect(one).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  expect(lookup).toHaveBeenCalledTimes(1);
});
it('blocks mixed public/private DNS answers before any application bytes are sent', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] as never);
  await expect(sendPublic('https://receiver.example/', '{}', {})).rejects.toThrow('Non-public');
  expect(request).not.toHaveBeenCalled();
});
it('rechecks resolution on a subsequent attempt and refuses rebinding', async () => {
  vi.mocked(lookup).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
  transport(503, '');
  await sendPublic('https://receiver.example/', '{}', {});
  await expect(sendPublic('https://receiver.example/', '{}', {})).rejects.toThrow('Non-public');
  expect(request).toHaveBeenCalledTimes(1);
});
it('returns redirects without following them and bounds the callback response', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  transport(302, 'redirect');
  expect((await sendPublic('https://receiver.example/', '{}', {})).status).toBe(302);
  expect(request).toHaveBeenCalledTimes(1);
  transport(200, 'x'.repeat(LIMITS.callbackResponseBytes + 1));
  await expect(sendPublic('https://receiver.example/', '{}', {})).rejects.toThrow('too large');
});
