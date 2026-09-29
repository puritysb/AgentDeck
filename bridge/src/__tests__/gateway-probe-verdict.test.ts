import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `openclaw doctor` is the only input that turns the OpenClaw row red from the
 * Node daemon, and it used to answer with a bare boolean tilted BOTH ways:
 * a missing CLI resolved "healthy", a timeout resolved "broken". Measured on
 * 2026-09-12 the command takes 8-9 s, so the timeout branch fired on machine
 * load alone. These vectors pin the third answer.
 */

const io = vi.hoisted(() => ({ err: null as (Error & Record<string, unknown>) | null }));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => {
    cb(io.err);
  }),
}));

let probe: typeof import('../gateway-probe.js');

const failWith = (props: Record<string, unknown>) =>
  Object.assign(new Error('doctor failed'), props) as Error & Record<string, unknown>;

beforeEach(async () => {
  vi.resetModules();
  io.err = null;
  probe = await import('../gateway-probe.js');
});

describe('checkGatewayHealth verdict', () => {
  it('reports healthy only when doctor actually exited 0', async () => {
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: true, hasError: false, reason: 'exit_code' });
  });

  it('reports broken on a real non-zero exit', async () => {
    io.err = failWith({ code: 2 });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: true, hasError: true, reason: 'exit_code' });
  });

  // Was `resolve(false)` — a surface that never found the CLI reported a
  // Gateway it had not contacted as fine.
  it('reports unknown, not healthy, when openclaw is not on PATH', async () => {
    io.err = failWith({ code: 'ENOENT' });
    expect(await probe.checkGatewayHealth()).toMatchObject({ known: false, reason: 'not_installed' });
  });

  // Was `resolve(true)` — a slow doctor run read as a failing Gateway.
  it('reports unknown, not broken, when doctor is killed at the timeout', async () => {
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
