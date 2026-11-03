import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { outputs } from '../../../scripts/generate-transport-auth-policy.mjs';
it('keeps the daemon and firmware refusal codes aligned', () => {
  for (const {path,expected} of outputs()) expect(readFileSync(path,'utf8')).toBe(expected);
});
it('exposes upstream close payloads without changing the dependency or close response', () => {
  const script = `import importlib.util\ns=importlib.util.spec_from_file_location('adapter','esp32/scripts/websocket_close_events.py')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nsource='case WSop_close: {\\n clientDisconnect(client, 1000);\\n} break;'\npatched=m.with_close_event(source)\nassert patched.index('messageReceived(client, WSop_close, payload, header->payloadLen, header->fin)') < patched.index('clientDisconnect(client, 1000)')\nassert source.count('messageReceived') == 0\ntry:\n m.with_close_event('case WSop_close: { different(); } break;')\n raise AssertionError('unrecognized library shape accepted')\nexcept ValueError: pass\n`;
  execFileSync(process.platform === 'win32' ? 'python' : 'python3',['-c',script],{timeout:10000,windowsHide:true});
});

it('registers the PlatformIO adapter and compiles a copy of the real source node', () => {
  const script = `from pathlib import Path
from tempfile import TemporaryDirectory
class Env:
 def __init__(self,root): self.root=root; self.callbacks=[]
 def AddBuildMiddleware(self,callback,pattern): self.callbacks.append((callback,pattern))
 def subst(self,key): return str(self.root/'build')
 def __getitem__(self,key): return []
 def Object(self,**kwargs): return kwargs
class Node:
 def __init__(self,path): self.path=path
 def srcnode(self): return self
 def get_abspath(self): return str(self.path)
with TemporaryDirectory() as directory:
 root=Path(directory); source=root/'WebSockets'/'src'/'WebSockets.cpp';source.parent.mkdir(parents=True)
 original='case WSop_close: { clientDisconnect(client, 1000); } break;'
 source.write_text(original)
 env=Env(root);scope={'env':env,'Import':lambda name:None}
 exec(compile(Path('esp32/scripts/websocket_close_events.py').read_text(),'adapter','exec'),scope)
 assert len(env.callbacks)==1
 callback,pattern=env.callbacks[0];assert pattern=='*WebSockets.cpp'
 build=callback(env,Node(source));assert 'messageReceived(client, WSop_close' in Path(build['source']).read_text()
 assert source.read_text()==original
`;
  execFileSync(process.platform === 'win32' ? 'python' : 'python3',['-c',script],{timeout:10000,windowsHide:true});
});
