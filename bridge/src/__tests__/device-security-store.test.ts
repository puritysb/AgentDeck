import { afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceSecurityStore } from '../device-security-store.js';
const dirs:string[]=[];
const store=()=>{const dir=mkdtempSync(join(tmpdir(),'device-custody-'));dirs.push(dir);return new DeviceSecurityStore(dir);};
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
const config={version:1,role:'owner',hostname:'agentdeck-test.local',port:9443,pfx:'dGVzdA==',password:'test-only',caDER:'dGVzdA=='};
const nonce='1'.repeat(32);
it('moves authority after a fresh seal and leaves the prior profile inactive across restart',()=>{
  const a=store(),b=store();a.install(config);
  const issued=a.credentials.issue('Dock',['sessions.read']);
  const transfer=a.seal(nonce);expect(new DeviceSecurityStore(a.directory).read()?.role).toBe('replica');
  expect(()=>a.seal(nonce)).toThrow('not-owner');
  b.adopt(transfer,nonce);expect(b.read()?.role).toBe('owner');expect(b.credentials.authenticate(issued.token)).not.toBeNull();
  b.credentials.revoke(issued.device.id);
  a.adopt(b.seal('2'.repeat(32)),'2'.repeat(32));expect(a.credentials.authenticate(issued.token)).toBeNull();
});
it('rejects stale, mismatched and missing custody rather than restoring a credential',()=>{
  const a=store(),b=store();a.install(config);a.credentials.issue('Dock',['sessions.read']);
  const transfer=a.seal(nonce)!;
  expect(()=>b.adopt(transfer,'2'.repeat(32))).toThrow('invalid-device-security-transfer');
  expect(b.read()).toBeNull();
  b.adopt(transfer,nonce);
  expect(()=>b.adopt({...transfer,credentials:null},nonce)).toThrow('custody-missing');
});
it('does not replace configured identity or recover from corrupt authority',()=>{
  const a=store();a.install(config);
  expect(()=>a.install({...config,hostname:'other.local'})).toThrow('already-configured');
  writeFileSync(join(a.directory,'device-security.json'),'{broken');
  expect(()=>a.read()).toThrow('unavailable');expect(()=>a.seal(nonce)).toThrow('unavailable');
});
