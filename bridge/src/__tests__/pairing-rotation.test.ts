import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const registry = vi.hoisted(() => ({probe:vi.fn(),ownership:vi.fn(),info:vi.fn()}));
vi.mock('../session-registry.js', () => ({readDaemonInfo:registry.info,findDaemonPort:()=>null,probeDaemonHealth:registry.probe}));
vi.mock('../auth.js', () => ({localPeerOwnership:registry.ownership}));
import { rotateActivePairingToken } from '../pairing-rotation.js';
const metadata = (revision:number) => ({version:1,revision,eventId:revision === 0 ? '' : String(revision).repeat(32)});
const health = (revision:number) => ({mode:'daemon',pid:123,pairingRotation:true,pairingRetirement:metadata(revision)});
let post: ReturnType<typeof vi.fn>;
beforeEach(() => {
  registry.probe.mockReset().mockResolvedValueOnce(health(0)).mockResolvedValueOnce(health(1));
  registry.ownership.mockReset().mockReturnValue('same-user');
  registry.info.mockReset().mockReturnValue({httpPort:19123});
  post = vi.fn(async () => new Response(JSON.stringify({rotated:true,scope:'active-owner',globalRevocation:'incomplete',pairingRetirement:metadata(1)})));
  vi.stubGlobal('fetch',post);
});
afterEach(() => vi.unstubAllGlobals());
describe('active owner rotation', () => {
  it('rotates the confirmed owner with a bounded local-only request and verifies its receipt', async () => {
    await rotateActivePairingToken();
    expect(post).toHaveBeenCalledTimes(1);
    const [url,options] = post.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('http://127.0.0.1:19123/pair/rotate');
    expect(JSON.parse(options.body as string)).toEqual({confirm:true,minimumRevision:0});
    expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.redirect).toBe('error');
  });
  it.each(['other-user','unknown'])('refuses ownership %s before mutation', async owner => {
    registry.ownership.mockReturnValue(owner);
    await expect(rotateActivePairingToken()).rejects.toThrow('confirm'); expect(post).not.toHaveBeenCalled();
  });
  it.each(['19123@evil.example','19123/path',{},NaN,19123.5,0,65536,-1])('refuses malformed file-supplied port %s before any network request', async port => {
    registry.info.mockReturnValue({httpPort:port});
    await expect(rotateActivePairingToken()).rejects.toThrow('Invalid active daemon port');
    expect(registry.probe).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it.each([null,{mode:'bridge'}, {...health(0),pairingRotation:false}, {...health(0),pairingRetirement:null}])('refuses absent or legacy owners', async initial => {
    registry.probe.mockReset().mockResolvedValue(initial);
    await expect(rotateActivePairingToken()).rejects.toThrow(); expect(post).not.toHaveBeenCalled();
  });
  it('never retries an ambiguous transport failure or mutates a fallback profile', async () => {
    post.mockRejectedValue(new Error('lost response'));
    await expect(rotateActivePairingToken()).rejects.toThrow(); expect(post).toHaveBeenCalledTimes(1);
  });
  it('requires same-owner readback and never treats a lost receipt as success', async () => {
    registry.probe.mockReset().mockResolvedValueOnce(health(0)).mockResolvedValueOnce({...health(1),pid:456});
    await expect(rotateActivePairingToken()).rejects.toThrow('may have committed'); expect(post).toHaveBeenCalledTimes(1);
  });
  it('accepts a later confirmed rotation without writing an older snapshot back to disk', async () => {
    registry.probe.mockReset().mockResolvedValueOnce(health(0)).mockResolvedValueOnce(health(2));
    await rotateActivePairingToken(); expect(post).toHaveBeenCalledTimes(1);
  });
  it('refuses a conflicting readback at the receipt revision', async () => {
    registry.probe.mockReset().mockResolvedValueOnce(health(0)).mockResolvedValueOnce({...health(1),pairingRetirement:{...metadata(1),eventId:'f'.repeat(32)}});
    await expect(rotateActivePairingToken()).rejects.toThrow('may have committed');
  });
});
