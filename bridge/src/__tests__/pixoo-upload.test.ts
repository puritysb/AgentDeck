import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearStaticPicId, getHttpGifId, pixooReplySucceeded, pushFrames, setBrightness, stopProbeTimer } from '../pixoo/pixoo-client.js';
import { PIXOO_LOOP_POLICY as P } from '../pixoo/pixoo-loop-policy.generated.js';

let server: http.Server | undefined;
afterEach(async () => { vi.restoreAllMocks(); stopProbeTimer(); clearStaticPicId('127.0.0.1'); if(server) await new Promise<void>(r=>server!.close(()=>r()));server=undefined; });
async function fixture(reply:(command:any)=>Record<string,unknown>) {
  const requests:any[]=[];
  server=http.createServer((req,res)=>{
    let body='';req.on('data',data=>body+=data);req.on('end',()=>{
      const command=JSON.parse(body);requests.push(command);
      res.writeHead(200,{'Content-Type':'application/json','Connection':'close'});res.end(JSON.stringify(reply(command)));
    });
  });
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as import('node:net').AddressInfo).port;
  const request=http.request.bind(http);
  vi.spyOn(http,'request').mockImplementation(((opts:any,callback:any)=>request({...opts,port},callback)) as typeof http.request);
  return requests;
}
const frame=()=>new Uint8Array(P.frameBytes).fill(40);
describe('Pixoo bounded upload transport',()=>{
  it('accepts only explicit success acknowledgements, not unknown or error replies',()=>{
    for(const reply of [null,{}, {error_code:1},{error_code:false},{errorCode:'0'}]) expect(pixooReplySucceeded(reply)).toBe(false);
    expect(pixooReplySucceeded({error_code:0})).toBe(true);expect(pixooReplySucceeded({errorCode:0})).toBe(true);
    expect(P.gammaLUT).toEqual(Array.from({length:256},(_,i)=>Math.round(Math.pow(i/255,0.7)*255)));
  });
  it('aborts the first failed frame and resynchronizes the next PicID',async()=>{
    let fail=true;
    const requests=await fixture(c=>c.Command==='Draw/GetHttpGifId'?{error_code:0,PicId:30}:{error_code:fail&&c.PicOffset===1?1:0});
    expect(await pushFrames('127.0.0.1',[frame(),frame(),frame()],200)).toBe(false);
    expect(requests.filter(c=>c.Command==='Draw/SendHttpGif').map(c=>c.PicOffset)).toEqual([0,1]);
    fail=false;expect(await pushFrames('127.0.0.1',[frame(),frame()],200)).toBe(true);
    expect(requests.filter(c=>c.Command==='Draw/GetHttpGifId')).toHaveLength(2);
    const uploads=requests.filter(c=>c.Command==='Draw/SendHttpGif');
    expect(uploads.every(c=>Buffer.from(c.PicData,'base64').length===P.frameBytes)).toBe(true);
  });
  it('requires a successful counter reset before wrapping to PicID one',async()=>{
    let reject=true;
    const requests=await fixture(c=>c.Command==='Draw/GetHttpGifId'?{error_code:0,PicId:249}:c.Command==='Draw/ResetHttpGifId'?{error_code:reject?1:0}:{error_code:0});
    expect(await pushFrames('127.0.0.1',[frame()],1000)).toBe(false);
    expect(requests.some(c=>c.Command==='Draw/SendHttpGif')).toBe(false);
    reject=false;expect(await pushFrames('127.0.0.1',[frame()],1000)).toBe(true);
    expect(requests.filter(c=>c.Command==='Draw/SendHttpGif')[0].PicID).toBe(1);
  });
  it('never invents PicID zero from an unreadable reply',async()=>{
    let unknown=true;
    const requests=await fixture(c=>c.Command==='Draw/GetHttpGifId'&&unknown?{}:{error_code:0,PicId:30});
    expect(await getHttpGifId('127.0.0.1')).toBeNull();
    expect(await pushFrames('127.0.0.1',[frame()],1000)).toBe(false);
    expect(requests.some(c=>c.Command==='Draw/SendHttpGif')).toBe(false);
    unknown=false;expect(await setBrightness('127.0.0.1',100)).toBe(true);
  });
  it('does not send later frames after dim/cancellation and rejects excess frame packs',async()=>{
    let allowed=true;
    const requests=await fixture(c=>{if(c.Command==='Draw/SendHttpGif') allowed=false;return {error_code:0,PicId:40};});
    expect(await pushFrames('127.0.0.1',[frame(),frame()],200,()=>allowed)).toBe(false);
    expect(requests.filter(c=>c.Command==='Draw/SendHttpGif')).toHaveLength(1);
    const count=requests.length;
    expect(await pushFrames('127.0.0.1',Array.from({length:41},frame),200)).toBe(false);
    expect(await pushFrames('127.0.0.1',[new Uint8Array(1)],200)).toBe(false);
    expect(requests).toHaveLength(count);
    expect(await pushFrames('127.0.0.1',[frame()],1000)).toBe(true);
    expect(requests.filter(c=>c.Command==='Draw/GetHttpGifId')).toHaveLength(2);
  });
});
