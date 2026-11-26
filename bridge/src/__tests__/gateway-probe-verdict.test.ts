import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fallback CLI Gateway health probe (`openclaw health --json`, replacing
 * `openclaw doctor` which grew past 30 s in OpenClaw 2026.11.7). These vectors
 * pin the three-answer contract and JSON payload parsing via `resolveGatewayHealth`.
 */

const io = vi.hoisted(() => ({
  err: null as (Error & Record<string, unknown>) | null,
  stdout: '' as string,
  stderr: '' as string,
  lastCmd: '' as string,
  lastArgs: [] as string[],
}));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: unknown, stdout?: string, stderr?: string) => void) => {
    io.lastCmd = cmd;
    io.lastArgs = args;
    cb(io.err, io.stdout, io.stderr);
  }),
}));

let probe: typeof import('../gateway-probe.js');

const failWith = (props: Record<string, unknown>) =>
  Object.assign(new Error('health probe failed'), props) as Error & Record<string, unknown>;

beforeEach(async () => {
  vi.resetModules();
  io.err = null;
  io.stdout = '';
  io.stderr = '';
  io.lastCmd = '';
  io.lastArgs = [];
  probe = await import('../gateway-probe.js');
});

describe('checkGatewayHealth verdict', () => {
  it('invokes openclaw health --json rather than openclaw doctor', async () => {
    io.stdout = JSON.stringify({ ok: true, durationMs: 2 });
    const verdict = await probe.checkGatewayHealth();
    expect(io.lastCmd).toBe('openclaw');
    expect(io.lastArgs).toEqual(['health', '--json']);
    expect(verdict).toMatchObject({ known: true, hasError: false, reason: 'ok_field' });
  });

  it('parses unhealthy JSON payloads via resolveGatewayHealth', async () => {
    io.stdout = JSON.stringify({ ok: false });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: true, hasError: true, reason: 'ok_field' });

    io.stdout = JSON.stringify({ checks: [{ name: 'line', status: 'error' }] });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: true, hasError: true, reason: 'checks', detail: 'line' });
  });

  it('reports unknown when JSON output carries no usable health verdict', async () => {
    io.stdout = JSON.stringify({ uptime: 123 });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: false, hasError: false, reason: 'unreadable' });
  });

  it('reports healthy when CLI exits 0 with empty stdout', async () => {
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: true, hasError: false, reason: 'exit_code' });
  });

  it('reports broken on a real non-zero exit', async () => {
    io.err = failWith({ code: 2 });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: true, hasError: true, reason: 'exit_code' });
  });

  it('reports unknown when an older CLI does not recognize the health subcommand', async () => {
    io.err = failWith({ code: 1 });
    io.stderr = "error: unknown command 'health'";
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: false, hasError: false, reason: 'unreadable', detail: 'unsupported_cli' });
  });

  // Was `resolve(false)` — a surface that never found the CLI reported a
  // Gateway it had not contacted as fine.
  it('reports unknown, not healthy, when openclaw is not on PATH', async () => {
    io.err = failWith({ code: 'ENOENT' });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: false, reason: 'not_installed' });
  });

  // Was `resolve(true)` — a slow probe run read as a failing Gateway.
  it('reports unknown, not broken, when health CLI is killed at the timeout', async () => {
    io.err = failWith({ killed: true, signal: 'SIGTERM' });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: false, reason: 'timed_out' });
  });

  it('reports unknown when the spawn fails some other way', async () => {
    io.err = failWith({ code: 'EACCES' });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: false, reason: 'unreadable' });
  });

  // `known: false` must never carry a usable verdict — a caller that ignores
  // the flag and reads `hasError` gets the non-alarming value either way.
  it('never reports an error alongside an unknown verdict', async () => {
    for (const props of [{ code: 'ENOENT' }, { killed: true, signal: 'SIGTERM' }, { code: 'EACCES' }]) {
      io.err = failWith(props);
      const verdict = await probe.checkGatewayHealth();
      expect(verdict.known).toBe(false);
      expect(verdict.hasError).toBe(false);
    }
  });
});
