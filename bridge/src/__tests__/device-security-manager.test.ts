import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_SECURITY } from '@agentdeck/shared';
import { DeviceSecurityManager } from '../device-security-manager.js';
const mocks=vi.hoisted(()=>({start:vi.fn(),stop:vi.fn(async()=>{})}));
vi.mock('../device-tls-server.js',()=>({DeviceTLSServer:class {start=mocks.start;stop=mocks.stop;}}));
const dirs:string[]=[];
function manager(){
  const dir=mkdtempSync(join(tmpdir(),'device-bind-test-'));dirs.push(dir);
  const value=new DeviceSecurityManager(dir,async()=>({sessions:[],usage:{}}));
  value.store.install({version:1,role:'owner',hostname:'localhost',port:9443,pfx:'dGVzdA==',password:'test-only',caDER:'dGVzdA=='});
  return value;
}
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true}));});
it('waits through a departing native bind without replacing its identity',async()=>{
  vi.useFakeTimers();const value=manager(),identity=value.store.read();
  mocks.start.mockRejectedValueOnce(Object.assign(new Error('busy'),{code:'EADDRINUSE'})).mockResolvedValue(9443);
  const pending=value.start();await vi.advanceTimersByTimeAsync(DEVICE_SECURITY.bindRetryMs);await pending;
  expect(mocks.start).toHaveBeenCalledTimes(2);expect(value.status().state).toBe('listening');expect(value.store.read()).toEqual(identity);
  await value.stop();
});
it('stops bounded retries on shutdown without starting a late listener',async()=>{
  vi.useFakeTimers();const value=manager();
  mocks.start.mockRejectedValue(Object.assign(new Error('busy'),{code:'EADDRINUSE'}));
  const pending=value.start();const rejected=expect(pending).rejects.toThrow('stopped');
  await vi.advanceTimersByTimeAsync(0);
  expect(value.status().state).toBe('starting'); // Pending ownership must not look like TLS is disabled.
  const stopped=value.stop();
  await vi.advanceTimersByTimeAsync(DEVICE_SECURITY.bindRetryMs);await rejected;await stopped;
  expect(mocks.start).toHaveBeenCalledTimes(1);expect(value.status().state).toBe('disabled');expect(vi.getTimerCount()).toBe(0);
});
it('leaves an occupied port alone after the deadline and refuses other bind errors immediately',async()=>{
  vi.useFakeTimers();const value=manager();
  mocks.start.mockRejectedValue(Object.assign(new Error('busy'),{code:'EADDRINUSE'}));
  const pending=value.start();const rejected=expect(pending).rejects.toThrow('busy');
  await vi.advanceTimersByTimeAsync(DEVICE_SECURITY.bindTimeoutMs);await rejected;
  expect(value.status().state).toBe('unavailable');expect(vi.getTimerCount()).toBe(0);
  mocks.start.mockReset().mockRejectedValue(Object.assign(new Error('denied'),{code:'EACCES'}));
  await expect(value.start()).rejects.toThrow('denied');expect(mocks.start).toHaveBeenCalledOnce();await value.stop();
});
