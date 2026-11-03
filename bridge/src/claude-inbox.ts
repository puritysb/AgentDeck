/** Local Claude peer delivery. No token custody, terminal access, permission
 * answers or transcript copy leaves this module. A socket write is not delivery:
 * correlate a receiver receipt or the actual recipient's persisted user UUID. */
import { createConnection, createServer, type Server } from 'node:net';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, chmodSync, unlinkSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { VoiceDeliveryStatus } from '@agentdeck/shared';

export type InboxStatus = VoiceDeliveryStatus;
export interface InboxResult { ok: boolean; written: boolean; via: 'claude-inbox'; status: InboxStatus; reason: string }
interface Target { pid: number; path: string; transcript: string; sessionId: string }
interface Pending { target: Target; result?: InboxResult; settle: (result: InboxResult) => void; update?: (result: InboxResult) => void; poll?: ReturnType<typeof setInterval>; expiry?: ReturnType<typeof setTimeout> }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const result = (status: InboxStatus, written = true): InboxResult => ({
  ok: status === 'delivered', written, via: 'claude-inbox', status,
  reason: ({delivered:'Claude received the dictated peer message',held:'Claude is holding the peer message for approval',refused:'Claude refused the peer message',denied:'Claude approval was declined',expired:'Claude approval expired',dropped:'Claude dropped the peer message',submitted:'Peer message submitted; Claude receipt unconfirmed',unavailable:'Claude inbox unavailable'} as const)[status],
});

function privateSocket(path: string): string | undefined {
  try {
    if (!isAbsolute(path) || Buffer.byteLength(path) > 103 || /[\x00\r\n]/.test(path)) return;
    const canonical = realpathSync(path), socket = lstatSync(path), parent = lstatSync(dirname(canonical));
    if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o077) !== 0 || (parent.mode & 0o022) !== 0) return;
    if (socket.uid !== process.getuid?.() || parent.uid !== socket.uid) return;
    return canonical;
  } catch { return; }
}

class TranscriptReceipt {
  private offset: number;
  private tail = '';
  constructor(private readonly target: Target, private readonly id: string) {
    try { this.offset = lstatSync(target.transcript).size; } catch { this.offset = 0; }
  }
  received(): boolean {
    let fd: number | undefined;
    try {
      fd = openSync(this.target.transcript, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.()) return false;
      if (stat.size < this.offset) { this.offset = 0; this.tail = ''; }
      if (stat.size - this.offset > 256 * 1024) { this.offset = stat.size - 256 * 1024; this.tail = ''; }
      const bytes = Buffer.alloc(Math.min(256 * 1024, stat.size - this.offset));
      const count = readSync(fd, bytes, 0, bytes.length, this.offset); this.offset += count;
      const lines = (this.tail + bytes.subarray(0, count).toString('utf8')).split('\n');
      this.tail = lines.pop() ?? ''; if (this.tail.length > 256 * 1024) this.tail = '';
      return lines.some(line => {
        try { const row = JSON.parse(line); return row.type === 'user' && row.uuid === this.id && row.sessionId === this.target.sessionId && row.isMeta === true && row.isSidechain !== true; }
        catch { return false; }
      });
    } catch { return false; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}

export class ClaudeInbox {
  private closed = false;
  private targets = new Map<string, Target>();
  private servers = new Map<string, { ready: Promise<string | undefined>; server: Server; path: string; clients: Set<import('node:net').Socket>; inode?: number }>();
  private pending = new Map<string, Pending>();

  /** Called only for trusted same-machine Claude hooks. Paths remain private,
   * outside SessionInfo, timeline, APME, diagnostics and device payloads. */
  note(sessionId: unknown, pid: number, path: unknown, transcript: unknown, ended = false): void {
    if (this.closed) return;
    if (typeof sessionId !== 'string' || !uuid.test(sessionId) || !Number.isInteger(pid) || pid <= 1) return;
    if (ended) { if (this.targets.get(sessionId)?.pid === pid) this.targets.delete(sessionId); return; }
    if (typeof path !== 'string' || typeof transcript !== 'string' || !isAbsolute(transcript) || transcript.length > 4096 || basename(transcript) !== sessionId + '.jsonl') return;
    const canonical = privateSocket(path); if (!canonical) return;
    if (this.targets.size >= 256 && !this.targets.has(sessionId)) this.targets.delete(this.targets.keys().next().value!);
    this.targets.set(sessionId, {pid,path:canonical,transcript,sessionId});
  }

  private replyServer(target: Target): Promise<string | undefined> {
    const dir = dirname(target.path), existing = this.servers.get(dir);
    if (existing) return existing.ready;
    const path = join(dir, `${process.pid}.sock`), clients = new Set<import('node:net').Socket>();
    const server = createServer(socket => {
      if (clients.size >= 8) { socket.destroy(); return; }
      clients.add(socket); let data = '';
      socket.setEncoding('utf8');
      const deadline = setTimeout(() => socket.destroy(),750); deadline.unref();
      socket.on('error', () => socket.destroy()); socket.on('close', () => { clearTimeout(deadline); clients.delete(socket); });
      socket.on('data', chunk => {
        data += chunk; if (Buffer.byteLength(data) > 4096) { socket.destroy(); return; }
        let end: number;
        while ((end = data.indexOf('\n')) >= 0) {
          const line = data.slice(0,end); data = data.slice(end+1);
          try {
            const value = JSON.parse(line), pending = this.pending.get(value.orig_msg_id);
            if (!pending || value.type !== 'control' || value.action !== 'peer_message_status' || typeof value.from !== 'string' || !value.from.startsWith('uds:')) continue;
            if (realpathSync(value.from.slice(4)) !== pending.target.path) continue;
            const status = value.status === 'expired' && value.status_detail === 'refused' ? 'refused' : value.status;
            if (['held','denied','expired','delivered','refused','dropped'].includes(status)) this.receipt(value.orig_msg_id, result(status));
          } catch { /* malformed/uncorrelated receipts prove nothing */ }
        }
      });
    });
    let resolve!: (path: string | undefined) => void;
    const ready = new Promise<string | undefined>(done => { resolve = done; });
    const entry = {ready,server,path,clients,inode:undefined as number | undefined}; this.servers.set(dir,entry);
    const timer = setTimeout(() => { server.close(); resolve(undefined); }, 750); timer.unref();
    server.on('error', () => { clearTimeout(timer); resolve(undefined); });
    // Never unlink a pre-existing endpoint. An occupied path is unavailable.
    server.listen(path, () => {
      clearTimeout(timer);
      if (this.closed) { server.close(); resolve(undefined); return; }
      try { chmodSync(path,0o600); entry.inode=lstatSync(path).ino; server.unref(); resolve(path); }
      catch { server.close(); resolve(undefined); }
    });
    server.on('close', () => { for (const client of clients) client.destroy(); });
    return ready;
  }

  private receipt(id: string, value: InboxResult): void {
    const pending = this.pending.get(id); if (!pending) return;
    const first = pending.result === undefined; pending.result = value;
    if (first) pending.settle(value); else pending.update?.(value);
    if (pending.poll) clearInterval(pending.poll);
    if (value.status !== 'held' && value.status !== 'submitted') this.remove(id);
  }
  private remove(id: string): void {
    const pending = this.pending.get(id); if (!pending) return;
    if (pending.poll) clearInterval(pending.poll); if (pending.expiry) clearTimeout(pending.expiry);
    this.pending.delete(id);
  }

  async deliver(sessionId: string, pid: number | undefined, text: string, update?: (value: InboxResult) => void): Promise<InboxResult> {
    const target = this.targets.get(sessionId);
    if (this.closed || process.platform === 'win32' || !target || target.pid !== pid || !text.trim() || Buffer.byteLength(text) > 16 * 1024 || this.pending.size >= 8 || privateSocket(target.path) !== target.path) return result('unavailable',false);
    try { process.kill(target.pid,0); } catch { return result('unavailable',false); }
    const reply = await this.replyServer(target);
    if (!reply || this.closed || this.targets.get(sessionId)?.pid !== pid || this.targets.get(sessionId)?.path !== target.path) return result('unavailable',false);
    const id = randomUUID(), transcript = new TranscriptReceipt(target,id);
    let settle!: (value: InboxResult) => void;
    const confirmed = new Promise<InboxResult>(done => { settle=done; });
    const pending: Pending = {target,settle,update}; this.pending.set(id,pending);
    const frame = JSON.stringify({type:'user',session_id:sessionId,uuid:id,msg_id:id,from:`uds:${reply}`,message:{role:'user',content:`AgentDeck dictated peer message:\n${text.trim()}`}}) + '\n';
    let written = false;
    const sent = await new Promise<boolean>(resolve => {
      const socket = createConnection({path:target.path}); let done=false;
      const finish = (ok:boolean) => { if (done) return; done=true; clearTimeout(timer); socket.destroy(); resolve(ok); };
      const timer = setTimeout(() => finish(false),750);
      socket.on('error',() => finish(false));
      socket.on('connect',() => {
        if (this.closed || !this.pending.has(id)) { finish(false); return; }
        // Any attempted write makes a retry unsafe, including a partial/error.
        written=true; socket.end(frame,() => finish(true));
      });
    });
    if (!written) { this.remove(id); return result('unavailable',false); }
    if (this.pending.has(id) && !pending.result) {
      const stopAt = Date.now()+30_000;
      pending.poll=setInterval(() => {
        if (transcript.received()) this.receipt(id,result('delivered'));
        else if (Date.now() >= stopAt) { if (pending.poll) clearInterval(pending.poll); }
      },150); pending.poll.unref();
    }
    if (this.pending.has(id)) { pending.expiry=setTimeout(() => this.remove(id),15*60_000); pending.expiry.unref(); }
    // A failed write after connect is ambiguous too; never type a duplicate.
    if (!sent) { const value=result('submitted'); if (!pending.result) { pending.result=value; settle(value); } }
    const timer = setTimeout(() => {
      if (!pending.result) { const value=result('submitted'); pending.result=value; settle(value); }
    },2000);
    const value = await confirmed; clearTimeout(timer); return value;
  }

  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) { this.pending.get(id)?.settle(result('submitted')); this.remove(id); }
    for (const entry of this.servers.values()) {
      for (const client of entry.clients) client.destroy();
      entry.server.close();
      try { if (entry.inode === lstatSync(entry.path).ino) unlinkSync(entry.path); } catch { /* replaced/missing */ }
    }
    this.servers.clear(); this.targets.clear();
  }
}
