import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ips10RosterIndices, IPS10_ROSTER_PERIOD_MS } from '../ips10-roster.js';
import { stableCardRoster } from '../esp32-serial.js';

describe('IPS10 rotating roster', () => {
  it('visits all 1000 sessions, retains attention, and never grows the frame', () => {
    for(const attention of [0, 2, 20, 1000]) {
      const seen = new Set<number>();
      for(let page=0;page<1000;page++) {
        const rows=ips10RosterIndices(1000,attention,10,page*IPS10_ROSTER_PERIOD_MS);
        expect(rows).toHaveLength(10);expect(new Set(rows).size).toBe(10);
        for(let i=0;i<Math.min(attention,3);i++)expect(rows).toContain(i);
        rows.forEach(i=>seen.add(i));
      }
      expect(seen.size).toBe(1000);
    }
  });
  it('rotates real projected IDs and excludes dead sessions', () => {
    const rows=Array.from({length:25},(_,i)=>({id:String(i).padStart(3,'0'),alive:i!==24,state:i<2?'awaiting_permission':'processing',startedAt:new Date(i*1000).toISOString()}));
    const first=stableCardRoster(rows,10,0).map(s=>s.id);
    expect(stableCardRoster(rows,10,59999).map(s=>s.id)).toEqual(first);
    expect(stableCardRoster(rows,10,60000).map(s=>s.id)).not.toEqual(first);
    const seen=new Set(Array.from({length:4},(_,p)=>stableCardRoster(rows,10,p*60000)).flat().map(s=>s.id));
    expect(seen.size).toBe(24);expect(seen.has('024')).toBe(false);
  });
  it('keeps the generated Swift kernel synchronized and behaviorally equivalent', () => {
    execFileSync(process.execPath,['bridge/generate-ips10-roster.mjs','--check']);
    if(process.platform!=='darwin')return;
    const swift=readFileSync('apple/AgentDeck/Daemon/Modules/ESP32Serial.swift','utf8').match(/    \/\/ BEGIN GENERATED IPS10 ROSTER[\s\S]*?    \/\/ END GENERATED IPS10 ROSTER/)![0];
    const cases=[[1000,20,10,0],[1000,20,10,60000],[12,0,10,120000],[2,1,10,0],[10,10,1,180000]];
    const dir=mkdtempSync(join(tmpdir(),'ips10-roster-'));
    try {
      const path=join(dir,'main.swift');writeFileSync(path,`import Foundation\nstruct Policy {\n${swift}\n}\n`+cases.map(c=>`print(Policy.ips10RosterIndices(total:${c[0]},attention:${c[1]},cap:${c[2]},nowMs:${c[3]}).map(String.init).joined(separator:","))`).join('\n'));
      const lines=execFileSync('swift',[path],{encoding:'utf8',timeout:30000}).trim().split('\n');
      expect(lines).toEqual(cases.map(c=>ips10RosterIndices(c[0],c[1],c[2],c[3]).join(',')));
    } finally {rmSync(dir,{recursive:true,force:true});}
  },40000);
});
