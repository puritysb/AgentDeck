import { describe, expect, it, vi } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vectors from '../../../shared/pairing-credential-vectors.json';
import { readCredentialState } from '../pairing-credential-store.js';

const run = promisify(execFile);
describe.skipIf(process.platform !== 'darwin')('actual Swift and Node pairing retirement', () => {
  it('replays shared vectors and serializes concurrent cross-runtime rotations without reviving legacy tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pairing-retirement-'));
    try {
      const binary = join(root, 'native');
      execFileSync('swiftc', ['-swift-version','6','-module-cache-path',join(root,'modules'),'-parse-as-library',
        'apple/AgentDeck/Daemon/Server/PairingCredentialRules.generated.swift','apple/AgentDeck/Daemon/Server/AuthManager.swift',
        'apple/AgentDeck/App/AgentDeckPaths.swift','bridge/src/__tests__/fixtures/pairing-retirement-main.swift','-o',binary], {timeout:120000});
      expect(JSON.parse(execFileSync(binary, ['--vectors'], {input:JSON.stringify(vectors),encoding:'utf8',timeout:15000}))).toEqual(vectors.map(v => v.expected));
      const dir = join(root,'profile');
      const first = JSON.parse((await run(binary,['--rotate',dir],{timeout:15000})).stdout);
      const env = {...process.env,AGENTDECK_DATA_DIR:dir};
      const node = "const fs=await import('node:fs'); const path=await import('node:path'); const auth=await import('./bridge/dist/auth.js'); auth.getPairingCredentials(); const dir=process.env.AGENTDECK_DATA_DIR; fs.writeFileSync(path.join(dir,'ready-node'),''); const deadline=Date.now()+10000; while(!fs.existsSync(path.join(dir,'gate-go'))){if(Date.now()>deadline)throw new Error('barrier timeout');await new Promise(r=>setTimeout(r,10));} auth.rotateToken();";
      const pending = [run(process.execPath,['--input-type=module','-e',node],{env,timeout:15000}),run(binary,['--rotate-barrier',dir],{timeout:15000})];
      // Both processes hold the same cached pre-rotation revision before either
      // is released. The second writer must reread under the shared OS lock.
      for (const job of pending) void job.catch(() => {});
      try {
        await vi.waitFor(() => { expect(existsSync(join(dir,'ready-node'))).toBe(true); expect(existsSync(join(dir,'ready-swift'))).toBe(true); },{timeout:10000,interval:20});
      } finally { writeFileSync(join(dir,'gate-go'),''); }
      await Promise.all(pending);
      const current = readCredentialState(dir)!;
      expect(current.revision).toBe(3); expect(current.accepted).toEqual([]); expect(current.token).not.toBe(first.token);
      writeFileSync(join(dir,'auth-token'),'a'.repeat(32)+'\n');
      writeFileSync(join(dir,'auth-token-accepted'),first.token+'\n');
      const restarted = JSON.parse((await run(binary,['--reject-legacy',dir],{timeout:15000})).stdout);
      expect(restarted).toEqual(current);
      const check = "const a=await import('./bridge/dist/auth.js'); if(a.validateToken('a'.repeat(32))||a.validateToken(process.env.RETIRED_TOKEN)||!a.validateToken(a.getOrCreateToken()))process.exit(2);console.log(JSON.stringify(a.getPairingCredentials()));";
      expect(JSON.parse((await run(process.execPath,['--input-type=module','-e',check],{env:{...env,RETIRED_TOKEN:first.token},timeout:15000})).stdout)).toEqual(current);
      expect(readFileSync(join(dir,'auth-credentials.lock.sqlite')).includes(Buffer.from(current.token))).toBe(false);
      // Real handover between distinct profiles, in both directions. Seed the
      // receiver explicitly so no test can inherit this host's real profile.
      const peer = join(root,'peer-profile'); mkdirSync(peer);
      writeFileSync(join(peer,'auth-token'),'a'.repeat(32)+'\n');
      writeFileSync(join(peer,'auth-token-accepted'),'b'.repeat(32)+'\n');
      const adopted = JSON.parse(execFileSync(binary,['--adopt',peer],{
        input:JSON.stringify({token:current.token,metadata:current,rejected:['a'.repeat(32),'b'.repeat(32)]}),encoding:'utf8',timeout:15000,
      }));
      expect(adopted).toEqual(current);
      const next = JSON.parse((await run(binary,['--rotate',peer],{timeout:15000})).stdout);
      expect(next.revision).toBe(current.revision+1); expect(next.accepted).toEqual([]);
      const adoptBack = "const fs=await import('node:fs'); const a=await import('./bridge/dist/auth.js'); const state=JSON.parse(fs.readFileSync(0,'utf8')); a.adoptPeerToken(state.token,state); if(a.validateToken(process.env.RETIRED_TOKEN)||!a.validateToken(state.token)||a.getAcceptedTokens().length)process.exit(2);console.log(JSON.stringify(a.getPairingCredentials()));";
      expect(JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',adoptBack],{
        input:JSON.stringify(next),env:{...env,RETIRED_TOKEN:current.token},encoding:'utf8',timeout:15000,
      }))).toEqual(next);
      for (const invalid of ['{broken', 'missing', '', 'x'.repeat(8193), Buffer.from([0xff])]) {
        writeFileSync(join(dir,'auth-credentials.json'),invalid);
        expect(JSON.parse((await run(binary,['--unavailable',dir],{timeout:15000})).stdout)).toEqual({available:false});
        expect(readFileSync(join(dir,'auth-credentials.json'))).toEqual(Buffer.from(invalid));
      }
    } finally { rmSync(root,{recursive:true,force:true}); }
  },150000);
});
