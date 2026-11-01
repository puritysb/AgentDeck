import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PixooBakedRenderer, type PixooBakeInput } from '../pixoo/pixoo-baked.js';
import { PIXOO_LOOP_POLICY as P } from '../pixoo/pixoo-loop-policy.generated.js';
import { outputs as policyOutputs } from '../../../scripts/generate-pixoo-loop-policy.mjs';
import { outputs as sourceOutputs } from '../../../scripts/generate-pixoo-baked.mjs';
import { buildSendHttpGifCommands } from '../pixoo/pixoo-client.js';

const vectors = JSON.parse(readFileSync('shared/pixoo-baked-vectors.json','utf8')) as Array<{name:string;input:PixooBakeInput}>;
describe('common fixed Pixoo baked core', () => {
  it('keeps policy and bundled fixed pixel source current and self-contained', async () => {
    for (const {path,expected} of [...policyOutputs(),...await sourceOutputs()]) expect(readFileSync(path,'utf8')).toBe(expected);
  });
  it.each(vectors)('$name has bounded frames, motion and a closed palindrome', ({input}) => {
    const frames = new PixooBakedRenderer().render(input);
    expect(frames).toHaveLength(input.loop === false ? 1 : P.uniqueFrames*2-2);
    expect(frames.every(f=>f.length===P.frameBytes)).toBe(true);
    if (input.loop !== false) for(let i=1;i<7;i++) expect(frames[i]).toEqual(frames[14-i]);
    const commands = buildSendHttpGifCommands(frames,31,frames.length>1?P.picSpeedMs:1000);
    expect(commands.every(c=>Buffer.from(c.PicData,'base64').length===P.frameBytes)).toBe(true);
    expect(new Set(commands.map(c=>c.PicID)).size).toBe(1);
    expect(commands.map(c=>c.PicOffset)).toEqual(frames.map((_,i)=>i));
  });
  it('matches the original canonical renderer with a fresh seeded simulation', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(vectors[0].input.nowMs);
    let seed=P.randomSeed;
    vi.spyOn(Math,'random').mockImplementation(()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;});
    try {
      const {renderPixooLoop}=await import('../pixoo/pixoo-renderer.js');
      const input=vectors[0].input;
      expect(new PixooBakedRenderer().render(input)).toEqual(renderPixooLoop(input.state,input.usage,input.sessions,input.nowMs));
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it('caches at most one loop and protects the cache from mutable overlays', () => {
    const renderer=new PixooBakedRenderer(), input=vectors[0].input;
    const first=renderer.render(input), original=first[0][0]; first[0][0]^=255;
    expect(renderer.render({...input,nowMs:input.nowMs+1})[0][0]).toBe(original);
    renderer.clear(); expect(renderer.render(input)[0][0]).toBe(original);
    expect(()=>renderer.render({...input,sessions:Array(33).fill({})})).toThrow('pixoo_bake_limit');
    expect(()=>renderer.render({...input,usage:{extra:'x'.repeat(P.maxInputBytes)} as any})).toThrow('pixoo_bake_limit');
  });
  it.skipIf(process.platform!=='darwin')('compares every RGB byte with the actual Swift/JavaScriptCore renderer', () => {
    const dir=mkdtempSync(join(tmpdir(),'pixoo-baked-'));
    try {
      const binary=join(dir,'render');
      execFileSync('swiftc',['-module-cache-path',join(dir,'modules'),'-parse-as-library',
        'apple/AgentDeck/Daemon/Modules/PixooLoopPolicy.generated.swift','apple/AgentDeck/Daemon/Modules/PixooBakedRenderer.swift',
        'bridge/src/__tests__/fixtures/pixoo-baked-main.swift','-o',binary],{timeout:120000});
      const inputs=vectors.map(v=>v.input);
      const actual=JSON.parse(execFileSync(binary,['apple/AgentDeck/Resources/generated/pixoo-baked.generated.js'],
        {input:JSON.stringify(inputs),encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024}));
      const renderer=new PixooBakedRenderer();
      expect(actual).toEqual(inputs.map(i=>renderer.render(i).map(f=>Buffer.from(f).toString('base64'))));
      const signatureInputs=inputs.map(i=>{const copy={...i};delete copy.subagents;return copy;});
      const signatures=JSON.parse(execFileSync(binary,['apple/AgentDeck/Resources/generated/pixoo-baked.generated.js','--signatures'],
        {input:JSON.stringify(signatureInputs),encoding:'utf8',timeout:30000}));
      expect(signatures).toEqual(signatureInputs.map(i=>renderer.signature(i)));
    } finally {rmSync(dir,{recursive:true,force:true});}
  },180000);
});
