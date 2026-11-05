import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it('executes the transformed SDK auth, Digest path, boundary and portal route policies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentdeck-sdk-security-'));
  try {
    const cpp = execFileSync('python3', ['-c', String.raw`
import importlib.util
spec=importlib.util.spec_from_file_location('security','esp32/scripts/webserver_security.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
modern,rules=m.transform('WebServer','WebServer.cpp',m.MODERN_AUTH)
assert m.transform('WebServer','WebServer.cpp',modern)[0]==modern
legacy='''bool WebServer::authenticate(const char * username, const char * password){
  if(authReq.startsWith(F("Basic"))){ }
  else if(authReq.startsWith(F("Digest"))) {
      String _uri      = _extractParam(authReq, F("uri="),'"');
  }
  return false;
}
'''
patched,rules=m.transform('WebServer','WebServer.cpp',legacy)
assert m.DIGEST_GUARD in patched
assert m.transform('WebServer','WebServer.cpp',patched)[0]==patched
parser='''bool WebServer::_parseForm(WiFiClient& client, String boundary, uint32_t len){
  char fastBoundary[75];
  return true;
}
'''
patched,rules=m.transform('WebServer','Parsing.cpp',parser)
assert patched.index(m.BOUNDARY_GUARD)<patched.index('char fastBoundary')
assert m.transform('WebServer','Parsing.cpp',patched)[0]==patched
portal='\n'.join(m.OTA_ROUTES)+'\n  server->on("/wifi", []() {});\n  server->begin();\n'
portal,rules=m.transform('WiFiManager','WiFiManager.cpp',portal)
assert m.transform('WiFiManager','WiFiManager.cpp',portal)[0]==portal
for library,name,bad in [('WebServer','Parsing.cpp','unknown'),('WebServer','WebServer.cpp','unknown'),('WiFiManager','WiFiManager.cpp','unknown')]:
  try: m.transform(library,name,bad)
  except ValueError: pass
  else: raise AssertionError('unreviewed source accepted')
print('#include <cassert>\n#include <cstring>\n#include <functional>\n#include <memory>\n#include <string>\n#include <vector>')
print('#include <cstdint>')
print(r'''
enum HTTPAuthMethod { BASIC_AUTH, DIGEST_AUTH, OTHER_AUTH };
struct String {
  std::string value;
  String(const char* text="") : value(text) {}
  bool equalsConstantTime(const char* text) const { return value==text; }
  size_t length() const { return value.length(); }
  int indexOf(char c) const { auto p=value.find(c);return p==std::string::npos ? -1 : static_cast<int>(p); }
  const char* c_str() const { return value.c_str(); }
};
struct WebServer {
  HTTPAuthMethod mode=OTHER_AUTH; String user="admin", password="correct";
  bool authenticate(std::function<String*(HTTPAuthMethod,String,String[])> callback) {
    std::unique_ptr<String> result(callback(mode,user,nullptr));
    return result && result->value==password.value;
  }
  bool authenticate(const char*,const char*);
};
''')
print(modern)
print('bool digestPath(String _uri, String _currentUri) { String authReq;\n'+m.DIGEST_GUARD+'return true; }')
print('int bodyReads=0; bool boundary(String boundary) {\n'+m.BOUNDARY_GUARD+'++bodyReads; return true; }')
print('struct Portal { std::vector<std::string> routes,menu; bool started=false,showInfoUpdate=true; void on(const char* p,std::function<void()>){routes.push_back(p);} void begin(){started=true;} void setMenu(const char* values[],uint8_t count){for(uint8_t i=0;i<count;++i)menu.push_back(values[i]);} void setShowInfoUpdate(bool value){showInfoUpdate=value;} };')
print('void registerPortal(Portal* server) {\n'+portal+'\n}')
from pathlib import Path
wifi=Path('esp32/src/net/wifi_manager.cpp').read_text()
start=wifi.index('    // Firmware updates use the paired daemon WS protocol')
end=wifi.index('    // Credentials typed into the portal',start)
print('Portal wm; void configurePortal() {\n'+wifi[start:end]+'\n}')
print(r'''
int main() {
  WebServer server;
  assert(!server.authenticate("admin","correct")); // bare/unknown scheme was accepted before the backport
  for(auto mode:{BASIC_AUTH,DIGEST_AUTH}) {
    server.mode=mode; assert(server.authenticate("admin","correct"));
    server.password="incorrect"; assert(!server.authenticate("admin","correct")); server.password="correct";
    server.user="other"; assert(!server.authenticate("admin","correct")); server.user="admin";
  }
  assert(digestPath("/config","/config")); assert(digestPath("/config?x=1","/config"));
  assert(!digestPath("/public","/private")); assert(!digestPath("/config/extra","/config"));
  assert(!digestPath("/config","/config/extra")); assert(!digestPath("","/config"));
  String embeddedLeft, embeddedRight;
  embeddedLeft.value=std::string("/x\0public",9); embeddedRight.value=std::string("/x\0secret",9);
  assert(!digestPath(embeddedLeft,embeddedRight));
  assert(!boundary("")); assert(bodyReads==0);
  assert(boundary("x")); assert(boundary(std::string(70,'x').c_str())); assert(bodyReads==2);
  assert(!boundary(std::string(71,'x').c_str())); assert(!boundary(std::string(8192,'x').c_str())); assert(bodyReads==2);
  Portal portal; registerPortal(&portal); assert(portal.started);
  assert(portal.routes==std::vector<std::string>{"/wifi"});
  configurePortal(); const std::vector<std::string> expectedMenu={"wifi","info","exit"};
  assert(wm.menu==expectedMenu); assert(!wm.showInfoUpdate);
}
''')
`], { encoding: 'utf8', timeout: 10_000 });
    const source = join(directory, 'security.cpp');
    const binary = join(directory, 'security');
    writeFileSync(source, cpp);
    execFileSync('c++', ['-std=c++11', '-Wall', '-Wextra', '-Werror', source, '-o', binary], { timeout: 30_000 });
    execFileSync(binary, [], { timeout: 5_000 });
    expect(readFileSync('esp32/platformio.ini', 'utf8')).toContain('pre:scripts/webserver_security.py');
    expect(readFileSync('esp32/src/net/wifi_manager.cpp', 'utf8')).toContain('wm.setShowInfoUpdate(false)');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

it('compiles only a build-local copy and rejects changed SDK bytes before returning an object', () => {
  execFileSync('python3', ['-c', String.raw`
import configparser,hashlib,importlib.util,json,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('security','esp32/scripts/webserver_security.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
config=configparser.ConfigParser(interpolation=None);config.read('esp32/platformio.ini')
common=config.get('env','extra_scripts')
for section in config.sections():
  if section.startswith('env:'):
    scripts=config.get(section,'extra_scripts',fallback=common).replace('$'+'{env.extra_scripts}',common)
    assert 'pre:scripts/webserver_security.py' in scripts.split(), section
class Env(dict):
  def AddBuildMiddleware(self,callback,pattern): self.callback=callback
  def subst(self,value): return str(self.root/'build')
  def Object(self,**kwargs): return kwargs
class Node:
  def __init__(self,path): self.path=path
  def srcnode(self): return self
  def get_abspath(self): return str(self.path)
with tempfile.TemporaryDirectory() as temporary:
  root=Path(temporary);original=root/'WebServer/src/WebServer.cpp';original.parent.mkdir(parents=True)
  try: m.verify_build(root/'missing-build')
  except FileNotFoundError: pass
  else: raise AssertionError('missing compiled backports accepted')
  data=m.MODERN_AUTH.encode();original.write_bytes(data)
  # Test-only hash policy for a tiny upstream-shape fixture, never persisted.
  m.SUPPORTED_SOURCES[('WebServer','WebServer.cpp')]={hashlib.sha256(data).hexdigest()}
  env=Env(CPPPATH=['existing']);env.root=root;m.install(env)
  result=env.callback(env,Node(original))
  assert original.read_bytes()==data
  output=Path(result['source']);assert output.is_relative_to(root/'build')
  assert output.read_text()==m.HARDENED_AUTH
  assert result['CPPPATH']==['existing',str(original.parent)]
  receipt=json.loads(Path(str(output)+'.json').read_text())
  assert receipt['originalSha256']==hashlib.sha256(data).hexdigest()
  assert receipt['patchedSha256']==hashlib.sha256(output.read_bytes()).hexdigest()
  original.write_bytes(data+b'\n// unreviewed upstream change')
  try: env.callback(env,Node(original))
  except ValueError as error: assert 'Unreviewed SDK security source bytes' in str(error)
  else: raise AssertionError('changed SDK bytes accepted')
`], { timeout: 10_000 });
});
