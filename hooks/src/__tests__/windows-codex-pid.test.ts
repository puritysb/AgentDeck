import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { managedBlockBody } from '../codex-install.js';

function hookCommand(prefix = ''): string {
  const block = managedBlockBody({ platform: 'win32', includeNotify: false, includeOtel: false });
  const encoded = /command = "powershell.exe[^\n]+-EncodedCommand ([A-Za-z0-9+/=]+)"/.exec(block)![1];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  return 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '
    + Buffer.from(prefix + script, 'utf16le').toString('base64');
}

async function deliver(options: { codexParent?: boolean; prefix?: string; registry?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-windows-codex-'));
  const payload = JSON.stringify({ session_id: 'windows-pid-test', prompt: '한글 résumé' });
  let received: { pid?: string; body: string } | undefined;
  const server = createServer((req, res) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      received = { pid: req.headers['x-agentdeck-pid'] as string | undefined, body: data };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    if (options.registry) {
      mkdirSync(join(dir, '.agentdeck'));
      writeFileSync(join(dir, '.agentdeck', 'daemon.json'), JSON.stringify({ port }));
    }
    // Use a real native process whose executable name matches the upstream
    // Codex binary. No model/account or daemon configuration is involved.
    const executable = options.codexParent ? join(dir, 'codex.exe') : process.execPath;
    if (options.codexParent) copyFileSync(process.execPath, executable);
    const script = join(dir, 'runner.cjs');
    writeFileSync(script, `const {spawn} = require('node:child_process');
const hook = spawn('cmd.exe', ['/d', '/s', '/c', ${JSON.stringify(hookCommand(options.prefix))}],
  {windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe','pipe','pipe']});
hook.stdin.end(${JSON.stringify(payload)});
hook.stdout.pipe(process.stdout); hook.stderr.pipe(process.stderr);
hook.on('error', error => { console.error(error.message); process.exit(1); });
hook.on('close', code => { process.exitCode = code ?? 1; });
`);
    const child = spawn(executable, [script], {
      windowsHide: true,
      env: { ...process.env, AGENTDECK_PORT: options.registry ? '' : String(port),
        ...(options.registry ? { USERPROFILE: dir } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill(); reject(new Error('Windows hook exceeded 10s')); }, 10_000);
      child.on('error', error => { clearTimeout(deadline); reject(error); });
      child.on('close', exit => { clearTimeout(deadline); resolve(exit); });
    });
    expect(code, output).toBe(0);
    expect(received?.body).toBe(payload);
    return { received, expectedPid: String(child.pid) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    // Windows may release a just-exited executable or pipe a moment after close.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe.skipIf(process.platform !== 'win32')('Windows Codex hook launcher identity', () => {
  it('crosses cmd.exe and sends the actual Codex launcher PID with UTF-8 stdin', async () => {
    const { received, expectedPid } = await deliver({ codexParent: true });
    expect(received?.pid).toBe(expectedPid);
  }, 15_000);

  it('discovers the registry port through the bounded native HTTP health probe', async () => {
    const { received, expectedPid } = await deliver({ codexParent: true, registry: true });
    expect(received?.pid).toBe(expectedPid);
  }, 15_000);

  it('does not label an unrelated Node launcher as Codex', async () => {
    expect((await deliver()).received?.pid).toBeUndefined();
  }, 15_000);

  it('still delivers the lifecycle event when the process query is unavailable', async () => {
    const prefix = "function Get-CimInstance { throw 'query unavailable' }\n";
    expect((await deliver({ codexParent: true, prefix })).received?.pid).toBeUndefined();
  }, 15_000);

  it('does not loop or invent a PID from cyclic process evidence', async () => {
    const prefix = `function Get-CimInstance {
      [pscustomobject]@{ProcessId=$PID;ParentProcessId=10001;Name='powershell.exe'}
      [pscustomobject]@{ProcessId=10001;ParentProcessId=10002;Name='cmd.exe'}
      [pscustomobject]@{ProcessId=10002;ParentProcessId=10001;Name='cmd.exe'}
    }\n`;
    expect((await deliver({ prefix })).received?.pid).toBeUndefined();
  }, 15_000);
});
