"""Build-local WebServer fixes and removal of WiFiManager's unpaired HTTP OTA.

Only reviewed upstream source shapes are accepted. Downloaded packages remain
unchanged; each replacement object has a source/hash/rule receipt in BUILD_DIR.
"""
import hashlib
import json
from pathlib import Path
import re

# Reviewed package bytes: Arduino-ESP32 3.3.11 / 2.0.17 and WiFiManager 2.0.17.
# A package update must be reviewed, not silently treated as covered.
SUPPORTED_SOURCES = {
    ('WebServer', 'WebServer.cpp'): {
        '139da664fdc8b9950936f784f60e82215ed89154415546892978bf3d7cbf8caa',
        '7fe7cc252b2f3cf83b330f52de687fe9fc22cdc71028089eb6b0e177a9ce0aae',
    },
    ('WebServer', 'Parsing.cpp'): {
        '522a46a1b8bed19b5482b65eb96bb87fe068c937c4516d17111179b2e8b88adc',
        '122de5397729899ac8600d545f7ed4b8a02298351a4f1b0fa5c7fa73f87a14d0',
    },
    ('WiFiManager', 'WiFiManager.cpp'): {
        '3fb3976de89308359a90e8896a6c0bcf00e843ad59ae900a6b8463fd958f8a52',
    },
}

MODERN_AUTH = '''bool WebServer::authenticate(const char *_username, const char *_password) {
  return WebServer::authenticate([_username, _password](HTTPAuthMethod mode, String username, String params[]) -> String * {
    (void)mode;
    (void)params;
    return username.equalsConstantTime(_username) ? new String(_password) : NULL;
  });
}'''
HARDENED_AUTH = MODERN_AUTH.replace(
    '    (void)mode;\n',
    '    // GHSA-w887-pg2w-mfj2: plaintext auth never accepts OTHER_AUTH.\n'
    '    if (mode != BASIC_AUTH && mode != DIGEST_AUTH) return NULL;\n')
BOUNDARY_GUARD = '''  // GHSA-8cmm-3887-r32j: RFC 2046 caps the boundary at 70 bytes.
  // The existing fastBoundary VLA is therefore at most 75 bytes (no heap).
  if (boundary.length() == 0 || boundary.length() > 70) return false;
'''
DIGEST_GUARD = '''      // GHSA-28hv-fwm3-rpcq: match the requested path, without another String allocation.
      const int queryIndex = _uri.indexOf('?');
      const size_t uriPathLength = queryIndex < 0 ? _uri.length() : static_cast<size_t>(queryIndex);
      if (uriPathLength != _currentUri.length() ||
          strncmp(_uri.c_str(), _currentUri.c_str(), uriPathLength) != 0) {
        authReq = "";
        return false;
      }
'''
OTA_ROUTES = (
    '  server->on(WM_G(R_update), std::bind(&WiFiManager::handleUpdate, this));',
    '  server->on(WM_G(R_updatedone), HTTP_POST, std::bind(&WiFiManager::handleUpdateDone, this), std::bind(&WiFiManager::handleUpdating, this));',
)


def transform(library, filename, source):
    if library == 'WebServer' and filename == 'Parsing.cpp':
        matches = list(re.finditer(r'^bool WebServer::_parseForm\([^\n]+\)\s*\{\n', source, re.M))
        if len(matches) != 1 or 'char fastBoundary[' not in source:
            raise ValueError('Unreviewed WebServer multipart parser')
        pos = matches[0].end()
        if source[pos:pos + len(BOUNDARY_GUARD)] != BOUNDARY_GUARD:
            source = source[:pos] + BOUNDARY_GUARD + source[pos:]
        return source, ['multipart-boundary-70']
    if library == 'WebServer' and filename == 'WebServer.cpp':
        if source.count(MODERN_AUTH) == 1:
            return source.replace(MODERN_AUTH, HARDENED_AUTH), ['plaintext-auth-schemes']
        if source.count(HARDENED_AUTH) == 1:
            return source, ['plaintext-auth-schemes']
        # Arduino 2 has no OTHER_AUTH fallback; backport its missing Digest path check.
        signature = 'bool WebServer::authenticate(const char * username, const char * password){'
        if source.count(signature) != 1:
            raise ValueError('Unreviewed WebServer authentication implementation')
        start = source.index(signature)
        end = source.index('\n}\n', start) + 2
        body = source[start:end]
        if 'if(authReq.startsWith(F("Basic")))' not in body or 'else if(authReq.startsWith(F("Digest")))' not in body:
            raise ValueError('Unreviewed legacy authentication schemes')
        anchors = list(re.finditer(r'^      String _uri\s*= _extractParam\(authReq,[^\n]+;\n', body, re.M))
        if len(anchors) != 1:
            raise ValueError('Unreviewed legacy Digest URI extraction')
        pos = anchors[0].end()
        if body[pos:pos + len(DIGEST_GUARD)] != DIGEST_GUARD:
            body = body[:pos] + DIGEST_GUARD + body[pos:]
        return source[:start] + body + source[end:], ['digest-request-path']
    if library == 'WiFiManager' and filename == 'WiFiManager.cpp':
        for route in OTA_ROUTES:
            removed = '  // AgentDeck uses paired WS OTA; HTTP OTA route removed: ' + route.strip()
            if source.count(route) == 1:
                source = source.replace(route, removed)
            elif source.count(removed) != 1:
                raise ValueError('Unreviewed WiFiManager HTTP OTA registration')
        return source, ['remove-unpaired-http-ota']
    raise ValueError('Unsupported security middleware source')


def install(env):
    def middleware(build_env, node):
        original = Path(node.srcnode().get_abspath())
        library = original.parent.parent.name if original.parent.name == 'src' else original.parent.name
        if library not in ('WebServer', 'WiFiManager'):
            return node
        with original.open('rb') as stream:
            source_bytes = stream.read(1024 * 1024 + 1)
        if len(source_bytes) > 1024 * 1024:
            raise ValueError('SDK security source exceeds read limit')
        original_hash = hashlib.sha256(source_bytes).hexdigest()
        if original_hash not in SUPPORTED_SOURCES.get((library, original.name), set()):
            raise ValueError('Unreviewed SDK security source bytes: ' + library + '/' + original.name)
        source = source_bytes.decode('utf-8')
        patched, rules = transform(library, original.name, source)
        directory = Path(build_env.subst('$BUILD_DIR')) / 'agentdeck-security'
        directory.mkdir(parents=True, exist_ok=True)
        output = directory / (library + '-' + original.name)
        if not output.exists() or output.read_text() != patched:
            output.write_bytes(patched.encode('utf-8'))
        digest = lambda value: hashlib.sha256(value.encode()).hexdigest()
        (directory / (output.name + '.json')).write_text(json.dumps({
            'source': library + '/' + original.name, 'rules': rules,
            'originalSha256': original_hash, 'patchedSha256': digest(patched),
            'scope': 'Build-local source transformation; no installed-firmware claim.',
        }, indent=2) + '\n')
        print('[sdk-security]', library, original.name, ','.join(rules))
        return build_env.Object(target=str(output) + '.o', source=str(output),
                                CPPPATH=build_env['CPPPATH'] + [str(original.parent)])
    for name in ('WebServer.cpp', 'Parsing.cpp', 'WiFiManager.cpp'):
        env.AddBuildMiddleware(middleware, '*' + name)


def verify_build(build_directory):
    directory = Path(build_directory) / 'agentdeck-security'
    expected = {
        ('WebServer', 'WebServer.cpp'), ('WebServer', 'Parsing.cpp'),
        ('WiFiManager', 'WiFiManager.cpp'),
    }
    for library, name in sorted(expected):
        source = directory / (library + '-' + name)
        receipt = json.loads((directory / (source.name + '.json')).read_text())
        if (receipt['source'] != library + '/' + name or
                receipt['originalSha256'] not in SUPPORTED_SOURCES[(library, name)] or
                not receipt['rules'] or
                receipt['patchedSha256'] != hashlib.sha256(source.read_bytes()).hexdigest() or
                receipt['patchedSha256'] == receipt['originalSha256'] or
                not Path(str(source) + '.o').is_file()):
            raise ValueError('Incomplete SDK hardening build: ' + source.name)
    print('[sdk-security] verified three compiled replacement objects and receipts')


try:
    Import('env')
except NameError:
    if __name__ == '__main__':
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument('build_directory', type=Path)
        verify_build(parser.parse_args().build_directory)
else:
    install(env)
