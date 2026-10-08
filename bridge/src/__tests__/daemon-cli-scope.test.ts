import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mocks = vi.hoisted(() => ({
  supervisor: null as any, info: null as any, health: null as any, foreign: false,
  run: vi.fn(() => ({ ok: true, ran: [{ ok: true }] })), unload: vi.fn(async () => true),
  probe: vi.fn(async () => mocks.health), fetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../daemon-supervisor.js', async (original) => ({
  ...await original<object>(), detectSupervisor: () => mocks.supervisor,
  runSupervisorPlan: mocks.run, waitForSupervisorUnload: mocks.unload,
}));
vi.mock('../session-registry.js', async (original) => ({
  ...await original<object>(), readDaemonInfo: () => mocks.info,
  findDaemonPort: () => undefined, probeDaemonHealth: mocks.probe,
}));
vi.mock('../daemon-takeover.js', () => ({ isForeignDaemon: () => mocks.foreign }));
import { buildPlist, program, selectLifecycleSupervisor, stopDaemon } from '../cli.js';
const launchd = { kind: 'launchd' as const, label: 'dev.agentdeck.daemon', uid: 501, unitPath: '/unit.plist' };
const unit = '<plist><dict><key>Label</key><string>dev.agentdeck.daemon</string><key>ProgramArguments</key><array><string>agentdeck</string><string>daemon</string><string>start</string><string>--foreground</string></array></dict></plist>';

describe('CLI lifecycle supervisor data-scope ownership', () => {
  it('preserves readable default service routing without a live daemon and regardless of fallback port', () => {
    expect(selectLifecycleSupervisor(launchd, { env: {}, home: '/default', unitContent: unit })).toBe(launchd);
    expect(selectLifecycleSupervisor(launchd, { env: {}, home: '/default', unitContent: unit,
      info: { pid: 10 }, health: { pid: 10 } })).toBe(launchd);
    expect(selectLifecycleSupervisor(launchd, { env: {}, home: '/default',
      unitContent: buildPlist() })).toBe(launchd);
    const systemd = { ...launchd, kind: 'systemd' as const };
    expect(selectLifecycleSupervisor(systemd, { env: {}, home: '/default',
      unitContent: '[Service]\nExecStart=agentdeck daemon start --foreground\n#Environment="AGENTDECK_DATA_DIR=/qa"',
    })).toBe(systemd);
  });
  it.each(['launchd','systemd','schtasks'] as const)('isolated data never controls a global %s service', kind => {
    expect(selectLifecycleSupervisor({ ...launchd, kind }, { env: { AGENTDECK_DATA_DIR: '/isolated/qa' },
      home: '/default', unitContent: unit, info: { pid: 20, startedBy: kind }, health: { pid: 20 } })).toBeNull();
  });
  it('permits an explicitly matching configured systemd data scope', () => {
    const supervisor = { ...launchd, kind: 'systemd' as const };
    expect(selectLifecycleSupervisor(supervisor, { env: { AGENTDECK_DATA_DIR: '/isolated/qa' },
      unitContent: '[Service]\nExecStart="node" "cli.js" "daemon" "start" "--foreground"\nEnvironment="AGENTDECK_DATA_DIR=/isolated/qa"\n' })).toBe(supervisor);
    expect(selectLifecycleSupervisor(supervisor, { env: { AGENTDECK_DATA_DIR: '/other/qa' },
      unitContent: '[Service]\nExecStart="node" "cli.js" "daemon" "start" "--foreground"\nEnvironment="AGENTDECK_DATA_DIR=/isolated/qa"\n' })).toBeNull();
  });
  it.each([
    '#Environment="AGENTDECK_DATA_DIR=/qa"',
    ';Environment="AGENTDECK_DATA_DIR=/qa"',
    'Environment="AGENTDECK_DATA_DIR=/qa"\nEnvironment="AGENTDECK_DATA_DIR=/production"',
    'Environment="AGENTDECK_DATA_DIR=/qa"\nEnvironment=',
    'Environment="AGENTDECK_DATA_DIR=/qa"\nEnvironmentFile=/production.env',
    'Environment="AGENTDECK_DATA_DIR=/qa"\nUnsetEnvironment=AGENTDECK_DATA_DIR',
    '[Install]\nEnvironment="AGENTDECK_DATA_DIR=/qa"',
  ])('systemd inactive or ambiguous environment never authorizes a custom scope: %s', declarations => {
    expect(selectLifecycleSupervisor({ ...launchd, kind: 'systemd' }, {
      env: { AGENTDECK_DATA_DIR: '/qa' }, home: '/default',
      unitContent: '[Service]\nExecStart=agentdeck daemon start --foreground\n' + declarations,
    })).toBeNull();
  });
  const environment = (entries: string) => `<key>EnvironmentVariables</key><dict>${entries}</dict>`;
  const dataDir = (path: string) => `<key>AGENTDECK_DATA_DIR</key><string>${path}</string>`;
  it('launchd uses the active environment dictionary and ignores harmless XML comments', () => {
    const commented = unit.replace('</dict></plist>', `<!-- ${environment(dataDir('/qa'))} --></dict></plist>`);
    expect(selectLifecycleSupervisor(launchd, { env: {}, home: '/default', unitContent: commented })).toBe(launchd);
    expect(selectLifecycleSupervisor(launchd, { env: { AGENTDECK_DATA_DIR: '/qa' }, home: '/default',
      unitContent: commented })).toBeNull();
    const active = commented.replace('</dict></plist>', `${environment(dataDir('/production'))}</dict></plist>`);
    expect(selectLifecycleSupervisor(launchd, { env: { AGENTDECK_DATA_DIR: '/production' },
      unitContent: active })).toBe(launchd);
    expect(selectLifecycleSupervisor(launchd, { env: { AGENTDECK_DATA_DIR: '/qa' },
      unitContent: active })).toBeNull();
  });
  it.each([
    dataDir('/qa'),
    environment(dataDir('/qa') + dataDir('/production')),
    environment(dataDir('/qa')) + environment(dataDir('/production')),
    environment(`<key>Nested</key><dict>${dataDir('/qa')}</dict>`),
    `<key>Unrelated</key><dict>${environment(dataDir('/qa'))}</dict>`,
    `<!-- ${environment(dataDir('/qa'))}`,
  ])('launchd misplaced or ambiguous override is unknown: %s', declarations => {
    expect(selectLifecycleSupervisor(launchd, { env: { AGENTDECK_DATA_DIR: '/qa' },
      unitContent: unit.replace('</dict></plist>', declarations + '</dict></plist>') })).toBeNull();
  });
  it.each(['', 'not a service', '<plist><key>PATH</key><string>/bin</string></plist>'])('malformed readable unit is unknown (%s)', content => {
    for (const kind of ['launchd','systemd'] as const) {
      expect(selectLifecycleSupervisor({ ...launchd, kind }, { env: {}, unitContent: content })).toBeNull();
    }
  });
  it('a scheduled task cannot inherit a custom install-shell data directory', () => {
    const task = { kind: 'schtasks' as const, label: 'AgentDeckDaemon' };
    expect(selectLifecycleSupervisor(task, { env: {}, home: '/default' })).toBe(task);
    expect(selectLifecycleSupervisor(task, { env: { AGENTDECK_DATA_DIR: '/qa' }, home: '/default' })).toBeNull();
  });
  it('refuses unknown configuration, conflicting supervisor stamps, unrelated pids and app-owned targets', () => {
    expect(selectLifecycleSupervisor(launchd, { env: {}, unitContent: null })).toBeNull();
    expect(selectLifecycleSupervisor(launchd, { env: {}, unitContent: unit, info: { startedBy: 'systemd' } })).toBeNull();
    expect(selectLifecycleSupervisor(launchd, { env: {}, unitContent: unit, info: { pid: 10 }, health: { pid: 20 } })).toBeNull();
    expect(selectLifecycleSupervisor(launchd, { env: {}, unitContent: unit, health: { isSwift: true } })).toBeNull();
  });
});

describe('actual CLI stop call does not unload an unrelated installed unit', () => {
  let dir: string;
  beforeEach(() => {
    vi.clearAllMocks(); dir = mkdtempSync(join(tmpdir(), 'ad-cli-scope-'));
    const path = join(dir, 'unit.plist'); writeFileSync(path, unit);
    mocks.supervisor = { ...launchd, unitPath: path };
    mocks.info = { port: 19521, pid: 21 }; mocks.health = { mode: 'daemon', pid: 21 }; mocks.foreign = false;
    vi.stubEnv('AGENTDECK_DATA_DIR', join(dir, 'qa-state'));
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
  it('stops isolated target via HTTP without launchctl bootout, unload waits or global service controls', async () => {
    await stopDaemon(19521);
    expect(mocks.probe).toHaveBeenCalledWith(19521);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.unload).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('http://127.0.0.1:19521/shutdown', expect.objectContaining({ method: 'POST' }));
  });
  it('default scope still stops its readable installed unit on a fallback port', async () => {
    vi.stubEnv('AGENTDECK_DATA_DIR', ''); mocks.info = { port: 9121, pid: 21 };
    await stopDaemon(9120);
    expect(mocks.probe).toHaveBeenCalledWith(9121);
    expect(mocks.run).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ argv: ['launchctl', 'bootout', 'gui/501/dev.agentdeck.daemon'] }),
    ]));
    expect(mocks.fetch).toHaveBeenCalledWith('http://127.0.0.1:9121/shutdown', expect.anything());
  });
  it('actual stop command resolves explicit environment port when its isolated registry is absent', async () => {
    mocks.info = null; mocks.health = null; vi.stubEnv('AGENTDECK_DAEMON_PORT', '19521');
    await program.parseAsync(['node', 'agentdeck', 'daemon', 'stop']);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.probe).toHaveBeenCalledWith(19521);
    expect(mocks.fetch).toHaveBeenCalledWith('http://127.0.0.1:19521/shutdown', expect.anything());
  });
  it('refuses a foreign-owned target before controlling even the default unit', async () => {
    vi.stubEnv('AGENTDECK_DATA_DIR', ''); mocks.foreign = true;
    await stopDaemon(19521);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
