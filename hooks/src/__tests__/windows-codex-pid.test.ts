import { describe, expect, it } from 'vitest';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { buildCodexApprovalHoldCommand, managedBlockBody, windowsNotifyScriptContent } from '../codex-install.js';
import { WINDOWS_HOOK_SCRIPT, WINDOWS_STATUSLINE_SCRIPT } from '../install.js';

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

type ReceiverCase = 'missing' | 'malformed' | 'unhealthy' | 'healthy' | 'slow';
type WindowsObserver = 'Claude lifecycle' | 'Claude status line' | 'Codex lifecycle' | 'Codex notify' | 'Codex hold';

async function checkReceiver(kind: WindowsObserver, registry: ReceiverCase, explicitPort = false) {
  const home = mkdtempSync(join(tmpdir(), 'agentdeck-windows-receiver-'));
  const document = JSON.stringify({ session_id: 'receiver-fixture', note: '한글 résumé' });
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });
      if (req.url === '/health' && registry === 'slow') return;
      res.writeHead(req.url === '/health' && registry === 'unhealthy' ? 503 : 200,
        { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    mkdirSync(join(home, '.agentdeck'));
    if (registry !== 'missing') writeFileSync(join(home, '.agentdeck', 'daemon.json'),
      registry === 'malformed' ? '{invalid' : JSON.stringify({ httpPort: port }));
    const script = join(home, 'observer.ps1');
    let args: string[];
    if (kind === 'Claude lifecycle') {
      writeFileSync(script, WINDOWS_HOOK_SCRIPT);
      args = ['-File', script, '-HookEvent', 'SessionStart'];
    } else if (kind === 'Claude status line') {
      writeFileSync(script, WINDOWS_STATUSLINE_SCRIPT);
      const original = '[Console]::Out.Write([Console]::In.ReadToEnd())';
      args = ['-File', script, '-OriginalB64', Buffer.from(original).toString('base64')];
    } else if (kind === 'Codex notify') {
      writeFileSync(script, windowsNotifyScriptContent());
      args = ['-File', script, document];
    } else {
      const command = kind === 'Codex lifecycle' ? hookCommand() : buildCodexApprovalHoldCommand('win32');
      args = ['-EncodedCommand', /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(command)![1]];
    }
    // Only private fixture directories and random loopback ports are used.
    // File-backed stdin also permits an observer to intentionally exit unread.
    const input = join(home, 'stdin.json');
    writeFileSync(input, document);
    const fd = openSync(input, 'r');
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !['PATH', 'USERPROFILE', 'HOME', 'AGENTDECK_PORT'].includes(key.toUpperCase())));
    Object.assign(env, { USERPROFILE: home, HOME: home, PATH: home,
      CLAUDE_CODE_GIT_BASH_PATH: join(home, 'absent-bash.exe'),
      AGENTDECK_PORT: explicitPort ? String(port) : '' });
    const powershell = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let result: { code: number | null; stdout: string; stderr: string };
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
          { cwd: home, env, windowsHide: true, stdio: [fd, 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
        child.stdout!.on('data', chunk => { stdout += chunk; });
        child.stderr!.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Observer exceeded 20s')); }, 20_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
    } finally { closeSync(fd); }
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(kind === 'Claude status line' ? document : '');
    const posts = requests.filter(req => req.method === 'POST');
    const shouldPost = registry === 'healthy' || explicitPort;
    expect(posts).toHaveLength(shouldPost ? 1 : 0);
    if (shouldPost) expect(posts[0].body).toBe(document);
    const shouldProbe = !explicitPort && !['missing', 'malformed'].includes(registry);
    expect(requests.filter(req => req.path === '/health')).toHaveLength(shouldProbe ? 1 : 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe.skipIf(process.platform !== 'win32')('Windows observer receiver selection', () => {
  for (const kind of ['Claude lifecycle', 'Claude status line', 'Codex lifecycle', 'Codex notify', 'Codex hold'] as const) {
    for (const registry of ['missing', 'malformed', 'unhealthy', 'healthy'] as const) {
      it(`${kind} handles a ${registry} registry without changing the user output`, async () => {
        await checkReceiver(kind, registry);
      }, 25_000);
    }
    if (kind !== 'Claude status line') {
      it(`${kind} retains an explicit managed-session receiver`, async () => {
        await checkReceiver(kind, 'malformed', true);
      }, 25_000);
    }
  }
  it('bounds a registry health request that never answers', async () => {
    await checkReceiver('Claude lifecycle', 'slow');
  }, 25_000);
});
