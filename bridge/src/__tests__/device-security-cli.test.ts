import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerDeviceSecurityCommands } from '../device-security-cli.js';
import { findDaemonPortAsync } from '../session-registry.js';
vi.mock('../session-registry.js',()=>({findDaemonPortAsync:vi.fn()}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it.each([{port:9120},{port:9120,httpPort:9140}])('uses the discovered HTTP endpoint %j',async owner=>{
  vi.mocked(findDaemonPortAsync).mockResolvedValue(owner);
  const fetcher=vi.fn(async()=>new Response('{}',{status:200}));vi.stubGlobal('fetch',fetcher);
  vi.spyOn(console,'log').mockImplementation(()=>{});
  const program=new Command();registerDeviceSecurityCommands(program);
  await program.parseAsync(['node','agentdeck','device-security','status']);
  expect(fetcher.mock.calls.map(call=>(call as unknown[])[0])).toEqual([
    `http://127.0.0.1:${owner.httpPort??owner.port}/device-security/status`,
    `http://127.0.0.1:${owner.httpPort??owner.port}/device-security/devices`,
  ]);
});
it('refuses an unavailable owner without sending a request',async()=>{
  vi.mocked(findDaemonPortAsync).mockResolvedValue(null);
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const program=new Command();registerDeviceSecurityCommands(program);
  await expect(program.parseAsync(['node','agentdeck','device-security','status'])).rejects.toThrow('No local daemon');
  expect(fetcher).not.toHaveBeenCalled();
});
