import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEVICE_SECURITY, parseDeviceSecurityConfiguration, type DeviceScope } from '@agentdeck/shared';
import { isLocalConnection, localTrustOf } from './auth.js';
import { DeviceSecurityStore } from './device-security-store.js';
import { DeviceTLSServer } from './device-tls-server.js';

/** Local operator API and lifecycle for the optional scoped TLS listener. */
export class DeviceSecurityManager {
  readonly store:DeviceSecurityStore;
  private listener:DeviceTLSServer|null=null;
  private closed=false;
  private operations:Promise<unknown>=Promise.resolve();
  private mutate<T>(operation:()=>Promise<T>):Promise<T>{
    const next=this.operations.then(()=>{if(this.closed)throw new Error('device-security-stopped');return operation();});
    this.operations=next.catch(()=>{});return next;
  }
  private state:'disabled'|'replica'|'starting'|'listening'|'unavailable'='disabled';
  constructor(directory:string,private snapshot:()=>Promise<{sessions:unknown;usage:unknown}>,private host='0.0.0.0') {this.store=new DeviceSecurityStore(directory);}
  status(){return {version:1,state:this.state};}
  start():Promise<void>{return this.mutate(()=>this.open());}
  private async open():Promise<void>{
    await this.closeListener();
    try {
      const config=this.store.read();
      if(!config){this.state='disabled';return;}
      if(config.role!=='owner'){this.state='replica';return;}
      this.state='starting';
      const listener=new DeviceTLSServer({pfx:Buffer.from(config.pfx,'base64'),passphrase:config.password},this.store.credentials,this.snapshot);
      // Network.framework can retain the old bind briefly after stand-down.
      // Wait only for EADDRINUSE; never stop the process holding that port.
      const deadline=Date.now()+DEVICE_SECURITY.bindTimeoutMs;
      for(;;){
        if(this.closed)throw new Error('device-security-stopped');
        try {await listener.start(config.port,this.host);break;}
        catch(error){
          if((error as NodeJS.ErrnoException).code!=='EADDRINUSE'||Date.now()>=deadline)throw error;
          await new Promise(resolve=>setTimeout(resolve,DEVICE_SECURITY.bindRetryMs));
        }
      }
      this.listener=listener;
      if(this.closed){await this.closeListener();throw new Error('device-security-stopped');}
      this.state='listening';
    }catch(error){this.state='unavailable';throw error;}
  }
  async stop():Promise<void>{this.closed=true;await this.operations;await this.closeListener();}
  private async closeListener():Promise<void>{const listener=this.listener;this.listener=null;if(listener)await listener.stop();this.state='disabled';}
  sealForHandover(nonce:string){return this.mutate(async()=>{
    await this.closeListener();const transfer=this.store.seal(nonce);this.state='replica';return transfer;
  });}
  recoverCustody(transfer:unknown,nonce:string){return this.mutate(async()=>{
    if(this.state!=='replica'||this.store.read()?.role!=='replica')throw new Error('device-security-not-replica');
    this.store.adopt(transfer,nonce);await this.open();
  });}
  private async body(req:IncomingMessage):Promise<Record<string,unknown>>{
    return new Promise((resolve,reject)=>{
      let bytes=0;const chunks:Buffer[]=[];
      const timer=setTimeout(()=>{const error=new Error('device-security-request-timeout');reject(error);req.destroy(error);},5000);
      req.once('aborted',()=>{clearTimeout(timer);reject(new Error('device-security-request-aborted'));});
      req.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>DEVICE_SECURITY.maxBytes)req.destroy(new Error('device-security-request-too-large'));else chunks.push(chunk);});
      req.once('error',error=>{clearTimeout(timer);reject(error);});
      req.once('end',()=>{clearTimeout(timer);try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid-body');resolve(value);}catch(error){reject(error);}});
    });
  }
  /** This remains behind the daemon's normal auth gate, and further requires a local program. */
  handle(req:IncomingMessage,res:ServerResponse):boolean{
    if(!req.url?.startsWith('/device-security/'))return false;
    const send=(status:number,value:unknown)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(!isLocalConnection(req.socket.remoteAddress??'')||localTrustOf(req)!=='trusted'){send(403,{error:'local-owner-required'});return true;}
    if(req.method==='GET'&&req.url==='/device-security/status'){send(200,this.status());return true;}
    if(req.method==='GET'&&req.url==='/device-security/identity'){
      try{const config=this.store.read();send(config?200:404,config?{hostname:config.hostname,port:config.port,caDER:config.caDER}:{error:'not-configured'});}catch{send(503,{error:'device-security-unavailable'});}return true;
    }
    if(req.method==='GET'&&req.url==='/device-security/devices'){
      try{send(200,{devices:this.store.credentials.list()});}catch{send(503,{error:'device-security-unavailable'});}return true;
    }
    const paths=['/device-security/install','/device-security/start','/device-security/issue','/device-security/revoke','/device-security/seal'];
    if(req.method!=='POST'||!paths.includes(req.url)){send(404,{error:'not-found'});return true;}
    void this.body(req).then(body=>this.mutate(async()=>{
      if(req.url==='/device-security/install'){
        const config=parseDeviceSecurityConfiguration(body);
        if(!config||config.role!=='owner'){send(400,{error:'invalid-configuration'});return;}
        // Validate PKCS#12 before committing it; the listener is not bound here.
        const candidate=new DeviceTLSServer({pfx:Buffer.from(config.pfx,'base64'),passphrase:config.password},this.store.credentials,this.snapshot);
        await candidate.stop();this.store.install(config);await this.open();send(200,this.status());return;
      }
      if(req.url==='/device-security/start'){await this.open();send(200,this.status());return;}
      if(this.state!=='listening'||this.store.read()?.role!=='owner'){send(409,{error:'device-security-not-active-owner'});return;}
      if(req.url==='/device-security/issue'){
        if(typeof body.name!=='string'||!Array.isArray(body.scopes)){send(400,{error:'invalid-device'});return;}
        const issued=this.store.credentials.issue(body.name,body.scopes as DeviceScope[]);
        send(200,{token:issued.token,id:issued.device.id,scopes:issued.device.scopes});return;
      }
      if(req.url==='/device-security/revoke'){
        if(typeof body.id!=='string'){send(400,{error:'invalid-device'});return;}
        send(200,{revoked:this.store.credentials.revoke(body.id)});return;
      }
      if(typeof body.nonce!=='string'||!/^[a-f0-9]{32}$/.test(body.nonce)){send(400,{error:'invalid-nonce'});return;}
      await this.closeListener();const transfer=this.store.seal(body.nonce);this.state='replica';send(200,{pid:process.pid,transfer});
    })).catch(()=>send(503,{error:'device-security-operation-failed'}));
    return true;
  }
}
