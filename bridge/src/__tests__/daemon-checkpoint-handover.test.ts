import { afterEach, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { requestDaemonStandDown } from '../session-registry.js';
import { DaemonCheckpointStore } from '../daemon-checkpoint.js';
import { AutonomousPocketEngine } from '../pocket-autonomy.js';
import { OutboxIdempotencyLedger } from '../card-feed.js';
const original = process.env.AGENTDECK_DATA_DIR, dirs: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'handover-')); dirs.push(path); return path; };
afterEach(() => {
  if (original === undefined) delete process.env.AGENTDECK_DATA_DIR; else process.env.AGENTDECK_DATA_DIR = original;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function peer(handler: (req: IncomingMessage, res: ServerResponse) => void, body: (port: number) => Promise<void>) {
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await body((server.address() as { port: number }).port); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
it('treats a refused/unknown owner as a refusal, never legacy endpoint absence', async () => {
  const requests: string[] = [];
  await peer((req, res) => { requests.push(req.url!); res.writeHead(503); res.end('{}'); }, async port => {
    await expect(requestDaemonStandDown(port)).rejects.toThrow('refused');
  });
  expect(requests).toEqual(['/stand-down']);
});
it('commits a prepared lease only after its exact checkpoint is durably staged', async () => {
  const source = directory(), target = directory(); process.env.AGENTDECK_DATA_DIR = target;
  const store = new DaemonCheckpointStore(source, new AutonomousPocketEngine({ persist: false }), new OutboxIdempotencyLedger(), {snapshot:()=>({version:1,pins:[],pixoo:{devices:[],autoDiscover:false}}),adopt:()=>{}});
  const payload = store.capture(true); let durableAtCommit = false, commitBody = '';
  await peer((req, res) => {
    if (req.url === '/stand-down') { res.end(JSON.stringify({ lease: 'fixture', continuity: payload })); return; }
    durableAtCommit = isDeepStrictEqual(JSON.parse(readFileSync(join(target, 'daemon-checkpoint-peer.json'), 'utf8')), JSON.parse(payload));
    req.on('data', bytes => { commitBody += bytes; }); req.on('end', () => res.end('{}'));
  }, async port => { expect(await requestDaemonStandDown(port)).toBe(true); });
  expect(durableAtCommit).toBe(true);
  expect(JSON.parse(commitBody)).toEqual({ lease: 'fixture', checkpointId: store.id });
});
it('leaves the current owner uncommitted when local checkpoint persistence is unavailable', async () => {
  const source = directory(), target = join(directory(), 'not-a-directory'); writeFileSync(target, 'preserve');
  process.env.AGENTDECK_DATA_DIR = target;
  const store = new DaemonCheckpointStore(source, new AutonomousPocketEngine({ persist: false }), new OutboxIdempotencyLedger(), {snapshot:()=>({version:1,pins:[],pixoo:{devices:[],autoDiscover:false}}),adopt:()=>{}});
  const requests: string[] = [];
  await peer((req, res) => { requests.push(req.url!); res.end(JSON.stringify({ lease: 'fixture', continuity: store.capture(true) })); },
    async port => { await expect(requestDaemonStandDown(port)).rejects.toThrow(); });
  expect(requests).toEqual(['/stand-down']);
  expect(readFileSync(target, 'utf8')).toBe('preserve');
});

it('refuses a prepared peer without configuration support before commit', async () => {
  const source = directory(), target = directory(); process.env.AGENTDECK_DATA_DIR = target;
  const store = new DaemonCheckpointStore(source, new AutonomousPocketEngine({persist:false}), new OutboxIdempotencyLedger());
  const requests: string[] = [];
  await peer((req,res)=>{ requests.push(req.url!); res.end(JSON.stringify({lease:'old-peer',continuity:store.capture(true)})); },
    async port=>{ await expect(requestDaemonStandDown(port)).rejects.toThrow('Configuration handover unsupported'); });
  expect(requests).toEqual(['/stand-down']);
});
