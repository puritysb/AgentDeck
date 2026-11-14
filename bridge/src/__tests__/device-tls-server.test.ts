import { X509Certificate } from 'node:crypto';
import { createServer as createTCPServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:https';
import { DeviceCredentialStore } from '../device-credential-store.js';
import { inspectDeviceTLS } from '../device-security-cli.js';
import { DeviceTLSServer } from '../device-tls-server.js';
import { DeviceSecurityManager } from '../device-security-manager.js';

let dir: string, store: DeviceCredentialStore, server: DeviceTLSServer, port: number, ca: Buffer;
let collect: () => Promise<{sessions:unknown; usage:unknown}>;
const sample = {sessions:[{id:'session1', agentType:'claude-code', state:'idle', alive:true, projectName:'Project', authToken:'secret', cwd:'/private/project', options:[{text:'secret'}]}],
  usage:{usageStale:false, fiveHourPercent:23, apiKey:'secret', codexRateLimits:{capturedAt:'2026-11-13T15:00:00Z', token:'secret', primary:{usedPercent:10, stale:false, token:'secret'}}}};
function get(token?: string, path = '/device/snapshot', options: {method?:string; origin?:string; hostname?:string} = {}): Promise<{status:number; body:string}> {
  return new Promise((resolve,reject) => {
    const req = request({host:'127.0.0.1', port, servername:options.hostname ?? 'localhost', ca, path,
      method:options.method ?? 'GET', agent:false, timeout:7000,
      headers:{...(token ? {Authorization:`Bearer ${token}`} : {}), ...(options.origin ? {Origin:options.origin} : {})}}, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({status:res.statusCode!, body}));
    });
    req.on('error',reject); req.on('timeout',()=>req.destroy(new Error('test request timeout'))); req.end();
  });
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(),'agentdeck-tls-test-'));
  const key = join(dir,'key.pem'), cert = join(dir,'cert.pem'), pfx = join(dir,'identity.p12');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1',
    '-subj','/CN=localhost','-sha256','-addext','subjectAltName=DNS:localhost','-addext','extendedKeyUsage=serverAuth'],{timeout:15000,stdio:'pipe'});
  execFileSync('openssl',['pkcs12','-export','-inkey',key,'-in',cert,'-out',pfx,'-passout','pass:test-only','-keypbe','PBE-SHA1-3DES','-certpbe','PBE-SHA1-3DES'],{timeout:15000,stdio:'pipe'});
  ca = readFileSync(cert); store = new DeviceCredentialStore(dir);
  collect = async () => sample;
  server = new DeviceTLSServer({pfx:readFileSync(pfx),passphrase:'test-only'},store,()=>collect());
  port = await server.start(0,'127.0.0.1');
});
afterAll(async () => { await server?.stop(); if(dir) rmSync(dir,{recursive:true,force:true}); });
describe('isolated TLS device listener', () => {
  it('requires TLS hostname validation and an independent device credential even on loopback', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('machine-token')).status).toBe(401);
    const {token} = store.issue('Dock',['sessions.read']);
    await expect(get(token,'/device/snapshot',{hostname:'wrong.local'})).rejects.toThrow();
    const response = await get(token); expect(response.status).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.events.map((e:{type:string})=>e.type)).toEqual(['surface_welcome','sessions_list']);
    for(const forbidden of ['secret','cwd','options','usage_update']) expect(response.body).not.toContain(forbidden);
  });
  it('derives the pinned firmware policy from a verified live TLS handshake', async () => {
    const trust = await inspectDeviceTLS({hostname:'localhost',port,caDER:new X509Certificate(ca).raw.toString('base64')});
    expect(trust.sha256).toBe(new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase());
    expect(trust.not_before).toHaveLength(6); expect(trust.not_after).toHaveLength(6);
    expect(trust.provisioned_at[0]).toBe(new Date().getUTCFullYear());
  });
  it('exports only allowlisted fields for usage authority', async () => {
    const {token} = store.issue('Quota dock',['usage.read']);
    const response = await get(token); expect(response.status).toBe(200);
    expect(response.body).not.toContain('sessions_list'); expect(response.body).not.toContain('secret');
    expect(JSON.parse(response.body).events[1].codexRateLimits.primary.stale).toBe(false);
  });
  it('has no command, browser, upgrade or URL-token route', async () => {
    const {token} = store.issue('Dock',['sessions.read']);
    for(const path of ['/health','/shutdown','/pair/open','/hooks/Stop','/device/snapshot?token='+token]) expect((await get(token,path)).status).toBe(400);
    expect((await get(token,'/device/snapshot',{method:'POST'})).status).toBe(400);
    expect((await get(token,'/device/snapshot',{origin:'https://example.org'})).status).toBe(400);
  });
  it('checks revocation again before a delayed snapshot leaves the process', async () => {
    const {token,device} = store.issue('Revoked dock',['sessions.read']);
    let release!: (value:typeof sample)=>void, entered!:()=>void;
    const ready = new Promise<void>(resolve=>entered=resolve);
    collect = () => { entered(); return new Promise(resolve=>release=resolve); };
    try {
      const pending = get(token); await ready;
      store.revoke(device.id); release(sample);
      expect((await pending).status).toBe(401);
      expect((await get(token)).status).toBe(401);
    } finally { collect = async () => sample; }
  });
  it('fails closed when snapshot collection throws synchronously', async () => {
    const {token}=store.issue('Dock',['sessions.read']);
    collect=()=>{throw new Error('collector unavailable');};
    try {expect((await get(token)).status).toBe(503);} finally {collect=async()=>sample;}
  });
  it('runs local installation, individual issue/revoke and sealed handover without exposing owner routes to browsers', async () => {
    const profile=join(dir,'managed');
    const manager=new DeviceSecurityManager(profile,async()=>sample,'127.0.0.1');
    const http=createHTTPServer((req,res)=>{if(!manager.handle(req,res)){res.writeHead(404);res.end();}});
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
    const ownerPort=(http.address() as {port:number}).port;
    const probe=createTCPServer();
    await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
    const tlsPort=(probe.address() as {port:number}).port;
    await new Promise<void>(resolve=>probe.close(()=>resolve()));
    const call=(path:string,body?:unknown,origin?:string)=>fetch(`http://127.0.0.1:${ownerPort}/device-security/${path}`,{
      method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000),
    });
    const priorPort=port;
    try {
      await manager.start();expect(manager.status().state).toBe('disabled');
      expect((await call('issue',{name:'Browser',scopes:['sessions.read']},'https://evil.example')).status).toBe(403);
      const configuration={version:1,role:'owner',hostname:'localhost',port:tlsPort,
        pfx:readFileSync(join(dir,'identity.p12')).toString('base64'),password:'test-only',caDER:new X509Certificate(ca).raw.toString('base64')};
      expect((await call('install',configuration)).status).toBe(200);
      expect(manager.status().state).toBe('listening');
      const issued=await (await call('issue',{name:'Managed dock',scopes:['sessions.read']})).json() as {token:string;id:string};
      port=tlsPort;expect((await get(issued.token)).status).toBe(200);
      const listing=await (await call('devices')).text();expect(listing).not.toContain(issued.token);expect(listing).not.toContain('verifier');
      expect((await call('revoke',{id:issued.id})).status).toBe(200);expect((await get(issued.token)).status).toBe(401);
      const receipt=await (await call('seal',{nonce:'a'.repeat(32)})).json() as {pid:number;transfer:unknown};
      expect(receipt.pid).toBe(process.pid);expect(receipt.transfer).toBeTruthy();expect(manager.status().state).toBe('replica');
      expect((await call('issue',{name:'Inactive',scopes:['sessions.read']})).status).toBe(409);
      await manager.start();expect(manager.status().state).toBe('replica');
    } finally {
      port=priorPort;await manager.stop();
      http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));
    }
  });
});

it.skipIf(process.platform !== 'darwin')('serves the same device authority over the actual Swift TLS listener', async () => {
  const binary = join(dir,'native');
  const files = ['DeviceCredentialRules','DeviceCredentialStore','DeviceSnapshotRules','DeviceTLSServer','DeviceTLSIdentity','DeviceSecurityRules','DeviceSecurityStore','PairingCredentialRules.generated']
    .map(name=>'apple/AgentDeck/Daemon/Server/'+name+'.swift');
  execFileSync('swiftc',['-swift-version','6','-module-cache-path',join(dir,'modules'),'-parse-as-library',...files,
    'apple/AgentDeck/App/AgentDeckPaths.swift','apple/AgentDeck/Daemon/Core/DaemonActor.swift',
    'bridge/src/__tests__/fixtures/device-credential-main.swift','-o',binary],{timeout:120000});
  const der = join(dir,'ca.der'); writeFileSync(der,new X509Certificate(ca).raw);
  const probe=createTCPServer();
  await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const nativePort=(probe.address() as {port:number}).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const native=spawn(binary,['serve',dir,join(dir,'identity.p12'),der,String(nativePort)],{stdio:['ignore','pipe','pipe']});
  const priorPort=port;
  try {
    await new Promise<void>((resolve,reject)=>{
      let output='',errors=''; const timer=setTimeout(()=>reject(new Error('native TLS startup timeout: '+errors)),10000);
      native.stderr.on('data',chunk=>errors+=chunk);
      native.once('exit',code=>{clearTimeout(timer);reject(new Error('native TLS exited '+code+': '+errors));});
      native.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY')){clearTimeout(timer);resolve();}});
    });
    port=nativePort;
    expect((await get()).status).toBe(401);
    const issued=store.issue('Native TLS test',['sessions.read']);
    const response=await get(issued.token); expect(response.status).toBe(200);
    expect(response.body).toContain('native-session'); expect(response.body).not.toContain('must-not-leak');
    expect((await get(issued.token,'/shutdown')).status).toBe(400);
    await expect(get(issued.token,'/device/snapshot',{hostname:'wrong.local'})).rejects.toThrow();
    store.revoke(issued.device.id);expect((await get(issued.token)).status).toBe(401);
  } finally {
    port=priorPort;native.kill('SIGTERM');
    if(native.exitCode===null && native.signalCode===null) await new Promise<void>(resolve=>native.once('exit',()=>resolve()));
  }
},130000);
