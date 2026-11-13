import { parseDeviceCredentialState, type DeviceCredentialState } from './device-credentials.js';

/** Owner custody is independent of the legacy fleet token and its compatibility ring. */
export const DEVICE_SECURITY = {version:1, file:'device-security.json', maxBytes:131072, maxIdentityBytes:32768, maxCertificateBytes:8192, subscriptionId:'device-security/v1', offerTimeoutMs:1000, ackTimeoutMs:3000, bindTimeoutMs:20000, bindRetryMs:250} as const;
export interface DeviceSecurityConfiguration {
  version:1;
  role:'owner'|'replica';
  hostname:string;
  port:number;
  pfx:string;
  password:string;
  caDER:string;
}
export interface DeviceSecurityTransfer {
  version:1;
  nonce:string;
  configuration:DeviceSecurityConfiguration;
  credentials:DeviceCredentialState | null;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function base64(value:unknown,maxBytes:number):value is string {
  return typeof value==='string' && value.length>0 && value.length<=4*Math.ceil(maxBytes/3)
    && (value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0))<=maxBytes
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
export function parseDeviceSecurityConfiguration(raw:unknown):DeviceSecurityConfiguration|null {
  if(!object(raw)||raw.version!==1||(raw.role!=='owner'&&raw.role!=='replica')
    ||typeof raw.hostname!=='string'||raw.hostname.length>253||!raw.hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ||typeof raw.port!=='number'||!Number.isInteger(raw.port)||raw.port<1024||raw.port>65535||(raw.port>=9120&&raw.port<=9139)
    ||!base64(raw.pfx,DEVICE_SECURITY.maxIdentityBytes)||!base64(raw.caDER,DEVICE_SECURITY.maxCertificateBytes)
    ||typeof raw.password!=='string'||raw.password.length<1||new TextEncoder().encode(raw.password).length>256||/[\u0000-\u001f\u007f]/.test(raw.password))return null;
  return {version:1,role:raw.role,hostname:raw.hostname,port:raw.port,pfx:raw.pfx,password:raw.password,caDER:raw.caDER};
}
export function parseDeviceSecurityTransfer(raw:unknown,nonce:string):DeviceSecurityTransfer|null {
  if(!object(raw)||raw.version!==1||!/^[a-f0-9]{32}$/.test(nonce)||raw.nonce!==nonce)return null;
  const configuration=parseDeviceSecurityConfiguration(raw.configuration);
  const credentials=raw.credentials===null?null:parseDeviceCredentialState(raw.credentials);
  if(!configuration||configuration.role!=='owner'||(raw.credentials!==null&&!credentials))return null;
  return {version:1,nonce,configuration,credentials};
}
