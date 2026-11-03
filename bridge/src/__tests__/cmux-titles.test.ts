import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CmuxDisplayNames, cmuxTitles, readCmuxTitles } from '../cmux-titles.js';
const surface = '11111111-1111-4111-8111-111111111111';
const tree = (workspace = 'Payments', title = 'Migration') => ({windows:[{workspaces:[{title:workspace,panes:[{surfaces:[{id:surface,type:'terminal',title}]}]}]}]});
const row = (pid=123, id='session-a') => ({pid,id,startedAt:'2026-11-03T00:00:00Z',tty:'ttys001',displayName:'fallback'});
let server: Server | undefined, dir: string | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); if (dir) rmSync(dir,{recursive:true,force:true}); server=undefined;dir=undefined; });
describe('cmux live display names', () => {
  it('joins current workspace and surface titles and refuses ambiguous IDs', () => {
    expect(cmuxTitles(tree()).get(surface)).toBe('Payments / Migration');
    expect(cmuxTitles(tree('Migration')).get(surface)).toBe('Migration');
    const duplicate=tree();duplicate.windows.push(...tree('Other').windows);
    expect(cmuxTitles(duplicate).has(surface)).toBe(false);
    expect(cmuxTitles({surfaces:[{id:surface,title:'wrong TUI shape'}]}).size).toBe(0);
  });
  it('updates rename and moves with stable routing IDs, and clears to the current fallback on refusal', async () => {
    let current = cmuxTitles(tree());
    const inspect=vi.fn(async () => ({surfaceId:surface}));
    const names=new CmuxDisplayNames(inspect,async () => current);
    const first=row();await names.refresh([first],100);expect(first.displayName).toBe('Payments / Migration');
    current=cmuxTitles(tree('Review','Renamed'));const moved=row();await names.refresh([moved],200);
    expect(moved).toEqual({...row(),displayName:'Review / Renamed'});expect(inspect).toHaveBeenCalledTimes(1);
    current=new Map();const refused=row();await names.refresh([refused],300);expect(refused.displayName).toBe('fallback');
    await names.refresh([row(123,'different-conversation')],400);expect(inspect).toHaveBeenCalledTimes(2);
  });
  it('isolates cmux instances and reads each socket once per snapshot', async () => {
    const inspect=vi.fn(async (pid:number) => ({surfaceId:surface,socketPath:pid===2?'/tmp/cmux-two.sock':'/tmp/cmux-one.sock'}));
    const read=vi.fn(async (path:string) => cmuxTitles(tree(path.endsWith('two.sock')?'Two':'One')));
    const sessions=[row(1),row(2),row(3),row(4)];await new CmuxDisplayNames(inspect,read).refresh(sessions);
    expect(sessions[1].displayName).toBe('Two / Migration');expect(sessions[2].displayName).toBe('One / Migration');expect(read).toHaveBeenCalledTimes(2);
  });
  it.skipIf(process.platform === 'win32')('uses one read-only method, checks response identity and bounds silent peers', async () => {
    dir=mkdtempSync(join(tmpdir(),'cmux-title-'));const path=join(dir,'control.sock');let mode='valid';
    server=createServer(socket => {socket.on('error',()=>{});socket.once('data',chunk => {
      const request=JSON.parse(chunk.toString());expect(request).toMatchObject({method:'system.tree',params:{}});
      if(mode==='silent')return;
      socket.end(JSON.stringify({id:mode==='wrong'?'other':request.id,ok:mode!=='refused',result:tree()})+'\n');
    });});
    await new Promise<void>(resolve => server!.listen(path,resolve));
    expect((await readCmuxTitles(path)).get(surface)).toBe('Payments / Migration');
    mode='wrong';expect((await readCmuxTitles(path)).size).toBe(0);
    mode='refused';expect((await readCmuxTitles(path)).size).toBe(0);
    mode='silent';const at=Date.now();expect((await readCmuxTitles(path)).size).toBe(0);expect(Date.now()-at).toBeLessThan(1500);
  });
});
