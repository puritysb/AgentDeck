import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, chmodSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeInbox } from '../claude-inbox.js';
let dir: string, server: Server | undefined, inbox: ClaudeInbox | undefined;
const clients = new Set<Socket>();
afterEach(async () => {
  inbox?.close(); for (const client of clients) client.destroy(); clients.clear();
  if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (dir) rmSync(dir,{recursive:true,force:true}); server=undefined;inbox=undefined;
});
async function setup(receive: (frame: any, transcript: string) => void) {
  dir=mkdtempSync(join(tmpdir(),'claude-inbox-')); chmodSync(dir,0o700);
  const sid=randomUUID(), path=join(dir,'recipient.sock'), transcript=join(dir,sid+'.jsonl');
  server=createServer(socket => {
    clients.add(socket);socket.on('close',() => clients.delete(socket));socket.on('error',() => {});
    socket.once('data',bytes => { const frame=JSON.parse(bytes.toString());receive(frame,transcript); });
  });
  await new Promise<void>((resolve,reject) => { server!.once('error',reject);server!.listen(path,resolve); });chmodSync(path,0o600);
  inbox=new ClaudeInbox();inbox.note(sid,process.pid,path,transcript);
  return {sid,path,transcript};
}
function receipt(frame: any, path: string, status: string, extra = {}) {
  const socket=createConnection(frame.from.slice(4));socket.on('error',()=>{});
  socket.on('connect',() => socket.end(JSON.stringify({type:'control',action:'peer_message_status',from:'uds:'+path,orig_msg_id:frame.msg_id,status,...extra})+'\n'));
}
describe.skipIf(process.platform === 'win32')('Claude local inbox delivery', () => {
  it('confirms the actual recipient UUID rather than a successful write or unrelated transcript row', async () => {
    const target=await setup((frame,path) => {
      expect(frame).toMatchObject({type:'user',session_id:target.sid,message:{role:'user'}});
      expect(frame).not.toHaveProperty('token');expect(frame).not.toHaveProperty('from_mode');
      appendFileSync(path,JSON.stringify({type:'user',uuid:frame.uuid,sessionId:target.sid,isMeta:false})+'\n');
      appendFileSync(path,JSON.stringify({type:'user',uuid:frame.uuid,sessionId:target.sid,isMeta:true,isSidechain:false})+'\n');
    });
    expect(await inbox!.deliver(target.sid,process.pid,'dictation')).toMatchObject({ok:true,written:true,status:'delivered'});
  });
  it('reports hold and a later correlated release without approving anything or retrying', async () => {
    let sent: any;const updated=vi.fn();
    const target=await setup(frame => {sent=frame;receipt(frame,target.path,'held');});
    expect(await inbox!.deliver(target.sid,process.pid,'dictation',updated)).toMatchObject({ok:false,written:true,status:'held'});
    receipt({...sent,msg_id:randomUUID()},target.path,'delivered');
    await new Promise(resolve => setTimeout(resolve,30));expect(updated).not.toHaveBeenCalled();
    receipt(sent,target.path,'delivered');
    await vi.waitFor(() => expect(updated).toHaveBeenCalledWith(expect.objectContaining({ok:true,status:'delivered'})));
  });
  it('distinguishes explicit refusal and never treats it as permission to use a terminal', async () => {
    const target=await setup(frame => receipt(frame,target.path,'expired',{status_detail:'refused'}));
    expect(await inbox!.deliver(target.sid,process.pid,'dictation')).toMatchObject({ok:false,written:true,status:'refused'});
  });
  it('keeps a silent receiver unconfirmed and sends one message only', async () => {
    let count=0;const target=await setup(() => { count++; });
    expect(await inbox!.deliver(target.sid,process.pid,'dictation')).toMatchObject({ok:false,written:true,status:'submitted'});
    expect(count).toBe(1);
  });
  it('rejects changed identity, symlink endpoints and mismatched transcript bindings before writing', async () => {
    let count=0;const target=await setup(() => {count++;});
    expect(await inbox!.deliver(target.sid,process.pid+1,'dictation')).toMatchObject({written:false,status:'unavailable'});
    const other=randomUUID();inbox!.note(other,process.pid,target.path,target.transcript);
    expect(await inbox!.deliver(other,process.pid,'dictation')).toMatchObject({written:false});
    const alias=join(dir,'alias.sock');symlinkSync(target.path,alias);
    inbox!.note(other,process.pid,alias,join(dir,other+'.jsonl'));
    expect(await inbox!.deliver(other,process.pid,'dictation')).toMatchObject({written:false});expect(count).toBe(0);
  });
  it('ignores an old PID end hook and closes admission on teardown', async () => {
    const target=await setup((frame,path) => appendFileSync(path,JSON.stringify({type:'user',uuid:frame.uuid,sessionId:target.sid,isMeta:true})+'\n'));
    inbox!.note(target.sid,process.pid+1,undefined,undefined,true);
    expect((await inbox!.deliver(target.sid,process.pid,'dictation')).ok).toBe(true);
    inbox!.close();inbox!.note(target.sid,process.pid,target.path,target.transcript);
    expect(await inbox!.deliver(target.sid,process.pid,'again')).toMatchObject({written:false});
  });
  it('does not send after teardown crosses the asynchronous reply-listen boundary', async () => {
    let count=0; const target=await setup(() => {count++;});
    const pending=inbox!.deliver(target.sid,process.pid,'must not arrive');
    inbox!.close();
    expect(await pending).toMatchObject({ok:false,written:false,status:'unavailable'});
    expect(count).toBe(0);
  });
  it('destroys active receipt clients on teardown even while they keep sending', async () => {
    const target=await setup(frame => receipt(frame,target.path,'held'));
    await inbox!.deliver(target.sid,process.pid,'dictation');
    const peer=createConnection(join(dir,`${process.pid}.sock`));peer.on('error',()=>{});
    await new Promise<void>(resolve => peer.once('connect',resolve));
    const chatter=setInterval(() => { if (!peer.destroyed) peer.write('{}\n'); },20);
    try {
      inbox!.close();
      await vi.waitFor(() => expect(peer.destroyed).toBe(true));
    } finally { clearInterval(chatter); peer.destroy(); }
  });
});
