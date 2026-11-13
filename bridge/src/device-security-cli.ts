import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { networkInterfaces } from 'node:os';
import { connect, type DetailedPeerCertificate } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { getLanIp, DEVICE_SECURITY } from '@agentdeck/shared';
import { findDaemonPortAsync } from './session-registry.js';

async function ownerRequest(path:string,body?:unknown):Promise<any>{
  const owner=await findDaemonPortAsync();if(!owner)throw new Error('No local daemon is available');
  const port=owner.httpPort??owner.port;
  const response=await fetch(`http://127.0.0.1:${port}/device-security/${path}`,{
    method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:'error',
  });
  if(!response.ok)throw new Error(`Device security operation failed (HTTP ${response.status})`);
  if(!response.body)throw new Error('Empty device security response');
  const chunks:Uint8Array[]=[];let bytes=0;
  for await(const chunk of response.body){
    bytes+=chunk.length;if(bytes>DEVICE_SECURITY.maxBytes)throw new Error('Device security response is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Verify the live server, not just a supplied certificate file. Export the
 * intersection of the verified chain's lifetimes for firmware missing that check. */
export function inspectDeviceTLS(identity:{hostname:string;port:number;caDER:string}):Promise<{sha256:string;not_before:number[];not_after:number[];provisioned_at:number[]}>{
  return new Promise((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:identity.port,servername:identity.hostname,ca:new X509Certificate(Buffer.from(identity.caDER,'base64')).toString(),rejectUnauthorized:true,minVersion:'TLSv1.2'});
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('Device TLS handshake timed out'));},5000);
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
    socket.once('secureConnect',()=>{
      try{
        let cert:DetailedPeerCertificate|undefined=socket.getPeerCertificate(true);
        if(!cert?.raw)throw new Error('Device TLS certificate unavailable');
        const sha256=createHash('sha256').update(cert.raw).digest('hex');
        let start=-Infinity,end=Infinity;const seen=new Set<string>();
        for(let depth=0;cert&&depth<8;depth++){
          const fingerprint=createHash('sha256').update(cert.raw).digest('hex');if(seen.has(fingerprint))break;seen.add(fingerprint);
          start=Math.max(start,Date.parse(cert.valid_from));end=Math.min(end,Date.parse(cert.valid_to));cert=cert.issuerCertificate;
        }
        if(cert&&!seen.has(createHash('sha256').update(cert.raw).digest('hex')))throw new Error('Device TLS certificate chain is too long');
        const now=Date.now();if(!Number.isFinite(start)||!Number.isFinite(end)||now<start||now>end)throw new Error('Device TLS certificate is outside its validity window');
        const date=(ms:number)=>{const d=new Date(ms);return [d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds()];};
        resolve({sha256,not_before:date(start),not_after:date(end),provisioned_at:date(now)});
      }catch(error){reject(error);}finally{clearTimeout(timer);socket.destroy();}
    });
  });
}
export function registerDeviceSecurityCommands(program:Command):void{
  const command=program.command('device-security').description('Manage opt-in TLS and individual read-only device credentials');
  command.command('status').action(async()=>{console.log(JSON.stringify({status:await ownerRequest('status'),...await ownerRequest('devices')},null,2));});
  command.command('install <configuration>').description('Import a local TLS identity configuration without replacing an existing identity').action(async(path:string)=>{
    const bytes=readFileSync(path);if(bytes.length>DEVICE_SECURITY.maxBytes)throw new Error('Identity configuration is too large');
    await ownerRequest('install',JSON.parse(bytes.toString('utf8')));console.log('Device TLS configured.');
  });
  command.command('pair <name>').requiredOption('--output <path>','New private device configuration file').option('--host <IPv4>','This Mac LAN address reachable by the device').action(async(name:string,options:{output:string;host?:string})=>{
    if(!isAbsolute(options.output))throw new Error('Use an absolute output path');
    const host=options.host??getLanIp();const addresses=Object.values(networkInterfaces()).flat().filter(Boolean).map(value=>value!.address);
    if(!addresses.includes(host)||host.includes(':')||host.startsWith('127.'))throw new Error('Choose this host’s reachable LAN IPv4 address');
    const identity=await ownerRequest('identity');const trust=await inspectDeviceTLS(identity);
    const issued=await ownerRequest('issue',{name,scopes:['sessions.read','usage.read']});
    try{
      const config={version:1,host,port:identity.port,hostname:identity.hostname,token:issued.token,ca_der:identity.caDER,trust:{version:1,...trust}};
      writeFileSync(options.output,JSON.stringify(config)+'\n',{mode:0o600,flag:'wx'});
    }catch(error){await ownerRequest('revoke',{id:issued.id}).catch(()=>{});throw error;}
    console.log(`Device configuration written to ${options.output}. Credential: ${issued.id}`);
  });
  command.command('revoke <id>').action(async(id:string)=>{const result=await ownerRequest('revoke',{id});if(!result.revoked)throw new Error('Device credential not found');console.log('Device credential revoked.');});
}
