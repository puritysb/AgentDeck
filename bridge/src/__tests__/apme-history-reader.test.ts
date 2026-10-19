import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { ApmeStore } from '../apme/store.js';
import { ApmeHistoryReader } from '../apme/history-reader.js';
import { historyProjection } from '../apme/history-projection.js';
import { ApmeCollector } from '../apme/collector.js';
import { ApmeHwSampler } from '../apme/hw-sampler.js';
import { handleApmeRequest } from '../apme/http.js';
import type { ApmeModule } from '../apme/index.js';

const compiledWorker = new URL('../../dist/apme/history-worker.js', import.meta.url);
const decode = (bytes: ArrayBuffer) => JSON.parse(new TextDecoder().decode(bytes));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('APME read-only history worker', () => {
  let dir: string;
  let store: ApmeStore;
  const readers: ApmeHistoryReader[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'apme-reader-'));
    store = new ApmeStore(join(dir, 'apme.sqlite'));
    expect(await store.init()).toBe(true);
  });
  afterEach(async () => {
    for (const reader of readers.splice(0)) reader.close();
    store.close();
    await delay(30);
    rmSync(dir, { recursive: true, force: true });
  });

  function reader(workerUrl = compiledWorker, timeoutMs = 5_000, maxPending = 8) {
    const value = new ApmeHistoryReader(store.dbPath, { workerUrl, timeoutMs, maxPending });
    readers.push(value);
    return value;
  }

  function fixture() {
    const file = join(dir, 'reader-fixture.mjs');
    writeFileSync(file, `import {parentPort} from 'node:worker_threads';
      parentPort.on('message', m => {
        if (m.params === 'crash') throw new Error('fixture crash');
        if (m.params.startsWith('block')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
        const bytes = new TextEncoder().encode(JSON.stringify({params:m.params}));
        parentPort.postMessage({id:m.id,bytes:bytes.buffer}, [bytes.buffer]);
      });`);
    return pathToFileURL(file);
  }

  it('matches task and communication DTOs through the packaged worker entry and sees later WAL writes', async () => {
    expect(existsSync(compiledWorker), 'run pnpm build before worker integration tests').toBe(true);
    const collector = new ApmeCollector(store, new ApmeHwSampler());
    collector.openRun({ sessionId: 'reader-test', agentType: 'claude-code', projectName: 'reef' });
    collector.ingestHook('reader-test', 'UserPromptSubmit', { prompt: 'Verify the reef calibration' });
    collector.noteRelation('reader-test', { relation: 'messaged', direction: 'out', phase: 'closed', peerSessionId: 'peer',
      evidence: 'test', detail: 'Please reply with calibration status', ts: Date.now(), key: 'test', messageIntent: 'request' });
    const value = reader();
    const params = 'limit=20&sort=attention&session=reader-test';
    expect(decode(await value.read('tasks', params))).toEqual(historyProjection(store, 'tasks', new URLSearchParams(params)));
    const expected = historyProjection(store, 'communications', new URLSearchParams()) as { events: unknown[] };
    expect(decode(await value.read('communications', '')).events).toEqual(expected.events);
    collector.openRun({ sessionId: 'later', agentType: 'claude-code' });
    collector.ingestHook('later', 'UserPromptSubmit', { prompt: 'A later WAL write' });
    expect(decode(await value.read('tasks', 'session=later')).total).toBe(1);
  });

  it('never migrates a read-only database or creates a missing database', async () => {
    const readonly = new ApmeStore(store.dbPath);
    expect(await readonly.init({ readOnly: true })).toBe(true);
    try {
      expect(() => readonly.insertRun({ id: 'forbidden', sessionId: 'forbidden', agentType: 'claude-code', startedAt: 1 })).toThrow(/readonly/i);
    } finally { readonly.close(); }
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const legacyPath = join(dir, 'legacy.sqlite');
    const legacy = new Database(legacyPath);
    legacy.exec('CREATE TABLE sentinel (id INTEGER)'); legacy.close();
    const oldStore = new ApmeStore(legacyPath);
    expect(await oldStore.init({ readOnly: true })).toBe(true);
    oldStore.close();
    const check = new Database(legacyPath, { readonly: true });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: 'sentinel' }]);
    check.close();
    const path = join(dir, 'missing', 'apme.sqlite');
    const missing = new ApmeStore(path);
    expect(await missing.init({ readOnly: true })).toBe(false);
    expect(existsSync(path)).toBe(false);
    missing.close();
  });

  // A GET from this machine keeps local trust whatever page sent it, so the
  // only thing between a web page and the task history is this header.
  it('answers a history read without Access-Control-Allow-Origin', async () => {
    const apme = { store, historyReader: reader(fixture()) } as ApmeModule;
    const server = createServer((req, res) => { void handleApmeRequest(req, res, apme); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/apme/tasks`, { headers: { Origin: 'https://evil.example' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('keeps HTTP health responsive during a blocked history read, then returns 503 without a synchronous fallback', async () => {
    const historyReader = reader(fixture(), 350);
    await historyReader.read('tasks', 'ready');
    const apme = { store, historyReader } as ApmeModule;
    const synchronousRead = vi.spyOn(store, 'listTaskPage');
    const server = createServer((req, res) => {
      if (req.url === '/health') { res.end('alive'); return; }
      void handleApmeRequest(req, res, apme);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const blocked = fetch(`${base}/apme/tasks?block`, { signal: AbortSignal.timeout(4_000) });
      await delay(70);
      expect(historyReader.diagnostics().pending).toBe(1);
      expect(await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_500) })).text()).toBe('alive');
      const response = await blocked;
      expect(response.status).toBe(503);
      expect(synchronousRead).not.toHaveBeenCalled();
      expect(historyReader.diagnostics().timeouts).toBe(1);
      expect(store.enabled).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('coalesces identical reads, bounds queued requests and rejects the whole stalled generation before recovering', async () => {
    const value = reader(fixture(), 5_000, 2);
    await value.read('tasks', 'ready');
    // Exercise the deadline deterministically, without imposing a 250 ms OS
    // worker-startup budget on a loaded development machine.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = value.read('tasks', 'block');
      expect(value.read('tasks', 'block')).toBe(first);
      const queued = value.read('tasks', 'queued');
      const rejected = Promise.allSettled([first, queued]);
      await expect(value.read('tasks', 'overflow')).rejects.toThrow('busy');
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await rejected).map(x => x.status)).toEqual(['rejected', 'rejected']);
      expect(value.diagnostics().pending).toBe(0);
    } finally { vi.useRealTimers(); }
    for (let i = 0; i < 20 && value.diagnostics().retiring; i++) await delay(20);
    expect(decode(await value.read('tasks', 'recovered'))).toEqual({ params: 'recovered' });
  });

  it('rejects pending requests on crash and close, with no late response crossing to a new worker', async () => {
    const value = reader(fixture());
    await expect(value.read('tasks', 'crash')).rejects.toThrow('worker');
    for (let i = 0; i < 20 && value.diagnostics().retiring; i++) await delay(20);
    expect(decode(await value.read('tasks', 'new-generation'))).toEqual({ params: 'new-generation' });
    const blocked = value.read('tasks', 'block');
    const rejected = expect(blocked).rejects.toThrow('closed');
    value.close();
    await rejected;
    await expect(value.read('communications', '')).rejects.toThrow('closed');
  });

  it('does not accumulate workers while an expired native read is still retiring', async () => {
    const terminate = Worker.prototype.terminate;
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const probe = vi.spyOn(Worker.prototype, 'terminate').mockImplementationOnce(function(this: Worker) {
      return barrier.then(() => terminate.call(this));
    });
    const value = reader(fixture(), 200);
    try {
      await value.read('tasks', 'ready');
      await expect(value.read('tasks', 'block')).rejects.toThrow('deadline');
      expect(value.diagnostics().retiring).toBe(true);
      await expect(value.read('tasks', 'another')).rejects.toThrow('unavailable');
      expect(probe).toHaveBeenCalledTimes(1);
    } finally { finish(); probe.mockRestore(); }
  });
});
