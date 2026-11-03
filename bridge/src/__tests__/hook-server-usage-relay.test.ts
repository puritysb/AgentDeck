/**
 * `/usage` is the relay SOURCE that sibling daemons pull from — the one place a
 * session bridge's usage numbers cross a process (and daemon-implementation)
 * boundary. These pin the contract that numbers and their age travel together.
 *
 * `fetchedAt` is `BridgeCore.lastApiFetchTime`, which advances only on a live
 * reading. Once a failed fetch stopped laundering itself as a fresh one, the
 * pair {numbers, fetchedAt: 0} became reachable for the first time: a bridge
 * whose only cached usage came from a failed fetch's stale-cache fallback.
 *
 * Neither relay consumer handles that pair. Node's `fetchUsageViaHttp` computes
 * a huge age and skips the sibling (harmless). Swift's `fetchUsageViaHTTP`
 * guards its whole block on `fetchedAt > 0`, so a 0 skips the 5-minute age gate
 * AND leaves the key off the dict it returns — `parseRelayedUsage` then reads no
 * `fetchedAt` and falls to `lastApiFetchTime = Date()`, stamping unknown-age
 * numbers as just-fetched. Closing it at the producer covers both consumers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'net';
import { HookServer } from '../hook-server.js';
import type { VoiceManager } from '../voice.js';

const servers: HookServer[] = [];

async function startServer(): Promise<{ server: HookServer; port: number }> {
  const server = new HookServer();
  servers.push(server);
  await server.listen(0);
  // `listen(0)` binds an ephemeral port; read it back off the raw server.
  const raw = (server as unknown as { server: { address(): AddressInfo | string | null } }).server;
  const addr = raw.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, port };
}

const sampleUsage = () => ({ fiveHourPercent: 41, sevenDayPercent: 73 });

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

describe('POST /voice/transcribe — binary payload boundary', () => {
  it('rejects parsed JSON arrays and length-shaped objects without transcribing', async () => {
    const { server, port } = await startServer();
    const transcribeFile = vi.fn();
    server.setVoiceManager({ transcribeFile } as unknown as VoiceManager);
    for (const body of [new Array(100).fill(1), { length: 100 }, { type: 'Buffer', data: new Array(100).fill(1) }]) {
      const response = await fetch(`http://127.0.0.1:${port}/voice/transcribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  it('continues accepting binary audio and passes the exact bytes to transcription', async () => {
    const { server, port } = await startServer();
    const bytes = Buffer.alloc(128, 7);
    const transcribeFile = vi.fn(async (path: string) => {
      expect(readFileSync(path)).toEqual(bytes);
      return 'fixture transcription';
    });
    server.setVoiceManager({ transcribeFile } as unknown as VoiceManager);
    const response = await fetch(`http://127.0.0.1:${port}/voice/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'fixture transcription' });
    expect(transcribeFile).toHaveBeenCalledOnce();
  });
});

describe('GET /usage — relay source contract', () => {
  it('serves numbers together with a positive fetchedAt', async () => {
    const { server, port } = await startServer();
    const fetchedAt = Date.now();
    server.onApiUsage(() => ({ usage: sampleUsage(), fetchedAt }));

    const body = await (await fetch(`http://127.0.0.1:${port}/usage`)).json();

    expect(body.status).toBe('ok');
    expect(body.usage).toEqual(sampleUsage());
    expect(body.fetchedAt).toBe(fetchedAt);
  });

  it('withholds numbers that carry no timestamp (fetchedAt 0)', async () => {
    // The regression: a bridge holding cached numbers it never freshly fetched
    // must not present itself as a relay source. Serving `usage` here is what
    // reaches Swift's defensive `lastApiFetchTime = Date()` branch.
    const { server, port } = await startServer();
    server.onApiUsage(() => ({ usage: sampleUsage(), fetchedAt: 0 }));

    const body = await (await fetch(`http://127.0.0.1:${port}/usage`)).json();

    expect(body.status).toBe('ok');
    expect(body.usage).toBeNull();
    expect(body.fetchedAt).toBe(0);
  });

  it('reports the same empty shape when no usage source is registered', async () => {
    // The two "nothing to relay" cases must be byte-identical on the wire, so a
    // consumer needs exactly one branch for them.
    const { port } = await startServer();

    const body = await (await fetch(`http://127.0.0.1:${port}/usage`)).json();

    expect(body).toEqual({ status: 'ok', usage: null, fetchedAt: 0 });
  });
});
