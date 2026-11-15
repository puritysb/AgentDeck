import { randomBytes } from 'node:crypto';
import { DEVICE_SECURITY, DEVICE_CREDENTIALS } from '@agentdeck/shared';
import { localPeerOwnership } from './auth.js';
import { DeviceSecurityStore } from './device-security-store.js';
import { getDataDir } from './session-registry.js';
import type { IncumbentHealth } from './daemon-takeover.js';

/** Called only when takeover has been decided, before stopping the incumbent.
 * An old daemon without this capability retains its existing legacy behavior. */
export async function captureDeviceSecurity(port:number,health:IncumbentHealth):Promise<boolean>{
  const status=health.deviceSecurity;
  if(!status||status.state==='disabled')return true;
  if (status.version !== 1 || localPeerOwnership(health.pid) !== 'same-user') return false;

  const store = new DeviceSecurityStore(getDataDir());
  try {
    if (health.isSwift && status.state === 'replica') {
      // Swift can serve the main port while Node retains durable TLS custody.
      // A replica has nothing to seal. Require the profile Node will start with
      // to contain the owner identity and to be able to read its credential store.
      if (store.read()?.role !== 'owner') return false;
      store.credentials.snapshot();
      return true;
    }
    if (status.state !== 'listening') return false;

    const nonce = randomBytes(16).toString('hex');
    const response=await fetch(`http://127.0.0.1:${port}/device-security/seal`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce}),signal:AbortSignal.timeout(15000),redirect:'error',
    });
    if(!response.ok||!response.body)return false;
    const maximum=DEVICE_SECURITY.maxBytes+DEVICE_CREDENTIALS.maxBytes+1024;
    let count=0;const chunks:Uint8Array[]=[];
    // Exiting async iteration cancels its reader; calling body.cancel() here
    // would operate on a locked stream.
    for await(const chunk of response.body){count+=chunk.length;if(count>maximum)return false;chunks.push(chunk);}
    const receipt=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(receipt.pid!==health.pid||localPeerOwnership(receipt.pid)!=='same-user')return false;
    store.adopt(receipt.transfer,nonce);
    return true;
  }catch{return false;}
}
