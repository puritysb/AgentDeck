import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const observerName = 'agentdeck-observer';
export const isHermesPort = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
const expandHome = (path: string): string => path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
export const hermesProfileHome = (home?: string): string => resolve(expandHome(home || process.env.HERMES_HOME || join(homedir(), '.hermes')));
export interface HermesDiagnostic {
  ok: boolean;
  plugin: 'installed' | 'missing' | 'outdated' | 'unknown';
  enablement: 'enabled' | 'disabled' | 'unknown';
  hooks: 'allowed' | 'disabled';
  discovery: 'explicit' | 'registry' | 'missing' | 'invalid' | 'unknown';
  port?: number;
  receiver: 'supported' | 'unsupported' | 'unreachable' | 'unknown' | 'not-probed';
  nextSteps: string[];
  scope: string;
}

async function read(path: string): Promise<{ text?: string; status: 'readable' | 'missing' | 'unknown' }> {
  try {
    const text = await readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(2000) });
    return text.length <= 1024 * 1024 ? { text, status: 'readable' } : { status: 'unknown' };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown' };
  }
}

/** Read health only, with an absolute deadline and size cap. No redirects,
 * proxy, credentials, session reads or diagnostic POSTs. */
async function receiver(port: number, timeoutMs: number): Promise<HermesDiagnostic['receiver']> {
  return new Promise(resolve => {
    let done = false;
    const finish = (status: HermesDiagnostic['receiver']) => {
      if (done) return;
      done = true; clearTimeout(timer); req.destroy(); resolve(status);
    };
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health' }, res => {
      if (res.statusCode !== 200) { res.resume(); finish('unknown'); return; }
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 65536) finish('unknown'); });
      res.on('error', () => finish('unknown'));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          finish(data?.mode !== 'daemon' ? 'unknown' : data.hermesObserver === 1 ? 'supported' : 'unsupported');
        } catch { finish('unknown'); }
      });
    });
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    req.on('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'unreachable' : 'unknown'));
  });
}

/** Mirrors observer discovery exactly: profile connection.json, otherwise the
 * configured registry only. A bad explicit selection never falls back. */
export async function collectHermesDiagnostic(opts: { home?: string; dataDir?: string; timeoutMs?: number } = {}): Promise<HermesDiagnostic> {
  const home = hermesProfileHome(opts.home);
  const plugin = join(home, 'plugins', observerName);
  const report: HermesDiagnostic = {
    ok: false, plugin: 'unknown', enablement: 'unknown',
    hooks: process.env.AGENTDECK_NO_HERMES_HOOKS === '1' ? 'disabled' : 'allowed',
    discovery: 'unknown', receiver: 'not-probed', nextSteps: [],
    scope: 'Checks this profile and CLI environment, not the running Hermes process. Restart Hermes after changes; verify a real turn appears in AgentDeck. No events were sent.',
  };
  const files = await Promise.all(['__init__.py', 'plugin.yaml', 'ci-wait-rules.json'].map(file => read(join(plugin, file))));
  report.plugin = files.some(file => file.status === 'unknown') ? 'unknown'
    : files.some(file => file.status === 'missing') ? 'missing' : 'installed';
  // A pre-connection observer cannot use an explicit port even if its files exist.
  const explicit = await read(join(plugin, 'connection.json'));
  if (explicit.status !== 'missing' && report.plugin === 'installed' && !files[0].text?.includes('connection.json')) report.plugin = 'outdated';
  const config = await read(join(home, 'config.yaml'));
  if (config.status === 'missing') report.enablement = 'disabled';
  else if (config.status === 'readable') {
    try {
      const data = parse(config.text!, { maxAliasCount: 100 });
      const enabled = data?.plugins?.enabled;
      const disabled = data?.plugins?.disabled;
      const mapping = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
      if ((data === null || mapping(data)) && (data?.plugins === undefined || mapping(data.plugins)) &&
          (enabled === undefined || Array.isArray(enabled)) && (disabled === undefined || Array.isArray(disabled))) {
        report.enablement = enabled?.includes(observerName) && !disabled?.includes(observerName) ? 'enabled' : 'disabled';
      }
    } catch { /* Unreadable/malformed config is unknown, never disabled. */ }
  }
  const registry = explicit.status === 'missing'
    ? await read(join(expandHome(opts.dataDir || process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck')), 'daemon.json')) : explicit;
  report.discovery = registry.status === 'missing' ? 'missing' : 'unknown';
  if (registry.status === 'readable') {
    try {
      const data = JSON.parse(registry.text!);
      const port = explicit.status === 'missing' ? (data.httpPort || data.port) : data.port;
      report.discovery = isHermesPort(port) ? explicit.status === 'missing' ? 'registry' : 'explicit' : 'invalid';
      if (isHermesPort(port)) report.port = port;
    } catch { report.discovery = 'invalid'; }
  }
  if (report.port !== undefined) report.receiver = await receiver(report.port, opts.timeoutMs ?? 1500);
  report.ok = report.plugin === 'installed' && report.enablement === 'enabled' && report.hooks === 'allowed' && report.receiver === 'supported';
  if (report.plugin !== 'installed') report.nextSteps.push('Install/update the observer with agentdeck hermes-observer --home <profile>.');
  if (report.enablement !== 'enabled') report.nextSteps.push('In that same Hermes profile, inspect configuration and run hermes plugins enable agentdeck-observer.');
  if (report.hooks === 'disabled') report.nextSteps.push('Remove AGENTDECK_NO_HERMES_HOOKS=1 from the Hermes launch environment to enable observation.');
  if (report.port === undefined) report.nextSteps.push('No usable receiver selection. For a sandboxed Mac app, use agentdeck hermes-observer --home <profile> --port <actual-daemon-port>; no container access is needed. For registry discovery, start the intended daemon or set AGENTDECK_DATA_DIR in the Hermes launch environment.');
  else if (report.receiver !== 'supported') report.nextSteps.push('Confirm the selected local daemon is running and advertises hermesObserver: 1. Update the receiver or correct --port; no other port was tried.');
  return report;
}

export function formatHermesDiagnostic(report: HermesDiagnostic): string {
  return [`Hermes observer setup: ${report.ok ? 'ready for a live-turn check' : 'incomplete or unconfirmed'}`,
    `Plugin: ${report.plugin}; enablement: ${report.enablement}; hooks: ${report.hooks}`,
    `Discovery: ${report.discovery}${report.port === undefined ? '' : ` (127.0.0.1:${report.port})`}; receiver: ${report.receiver}`,
    ...report.nextSteps, report.scope].join('\n');
}
