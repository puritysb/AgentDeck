import { DOT_LIMITS, DOT_LOCAL_MCP } from '@agentdeck/shared';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store, oauthStorage } from './store.js';
import { Relay } from './relay.js';
import { LocalOAuth } from './local-oauth.js';
import { directHTTPS } from './direct-https.js';
import { createRelayServer } from './server.js';

export interface DirectHostConfiguration {
  enabled: boolean; origin: string; port: number; bind?: string; certificatePath: string; keyPath: string;
  clientId: string; clientSecret: string; redirectURI: string; controlPort: number;
}
export interface LocalHostConfiguration { enabled: boolean; mode: 'local'; port: number; controlPort: number; bind?: string }
export async function startDirectHost(config: DirectHostConfiguration | LocalHostConfiguration, directory: string) {
  const local = 'mode' in config && config.mode === 'local';
  if (local && (config.bind !== undefined && config.bind !== DOT_LOCAL_MCP.host || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || config.port >= 9120 && config.port <= 9139)) throw new Error('Local MCP requires a dedicated loopback port');
  const direct = config as DirectHostConfiguration;
  const endpoint = local ? { origin: `http://${DOT_LOCAL_MCP.host}:${config.port}`, port: config.port, host: DOT_LOCAL_MCP.host, tls: undefined, validUntil: Infinity } : directHTTPS({ DOT_RELAY_RESOURCE: direct.origin, DOT_RELAY_PORT: String(config.port),
    DOT_RELAY_BIND: config.bind ?? '127.0.0.1', DOT_RELAY_TLS_CERT: direct.certificatePath, DOT_RELAY_TLS_KEY: direct.keyPath });
  if (!Number.isInteger(config.controlPort) || config.controlPort < 1024 || config.controlPort > 65535
    || (config.controlPort >= 9120 && config.controlPort <= 9139) || config.controlPort === endpoint.port) throw new Error('Invalid control port');
  const store = new Store(join(directory, 'dot-state.json'));
  const tokenPath = join(directory, 'dot-operator-token');
  let timer: ReturnType<typeof setInterval> | undefined;
  let work: Promise<void> | undefined;
  let stopped = false;
  let relay: Relay | undefined;
  let publicServer: ReturnType<typeof createRelayServer> | undefined, control: ReturnType<typeof createRelayServer> | undefined;
  const stop = async () => {
    if (stopped) return; stopped = true; clearInterval(timer);
    const drained = relay?.stop();
    for (const server of [publicServer, control]) if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await Promise.all([work, drained]); store.close();
  };
  try {
    if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    const operatorToken = readFileSync(tokenPath, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(operatorToken)) throw new Error('Invalid local operator credential');
    const oauth = new LocalOAuth({ resource: endpoint.origin, clientId: local ? DOT_LOCAL_MCP.clientId : direct.clientId, clientSecret: local ? '' : direct.clientSecret, redirectURI: local ? `http://${DOT_LOCAL_MCP.host}:${DOT_LOCAL_MCP.callbackPort}${DOT_LOCAL_MCP.callbackPath}` : direct.redirectURI, local }, oauthStorage(store));
    const activeRelay = new Relay(store, undefined, undefined, subject => oauth.hasAccess(subject));
    relay = activeRelay;
    publicServer = createRelayServer(activeRelay, async token => oauth.authenticate(token), endpoint.origin, endpoint.origin, { tls: endpoint.tls, deviceRoutes: false, oauth, local });
    control = createRelayServer(activeRelay, async token => {
      const received = Buffer.from(token), expected = Buffer.from(operatorToken);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('Invalid operator credential');
      return { subject: 'local-operator', scopes: ['agentdeck:device'] };
    }, endpoint.origin, endpoint.origin, { operator: true, oauth, local });
    for (const [server, port, host] of [[publicServer, endpoint.port, endpoint.host], [control, config.controlPort, '127.0.0.1']] as const) {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
    }
    timer = setInterval(() => {
      if (Date.now() >= endpoint.validUntil) { console.error('Dot TLS certificate expired; HTTPS hosting stopped'); void stop(); return; }
      if (work || stopped) return;
      work = activeRelay.deliver().catch(() => { console.error('Dot delivery or persistence failed'); }).finally(() => { work = undefined; });
    }, 1000);
    timer.unref();
    return { stop, origin: endpoint.origin, reports: () => activeRelay.list(), deckSnapshot: () => {
      const latest = activeRelay.list().sort((a, b) => b.createdAt - a.createdAt)[0];
      const report = latest?.report;
      const stale = report && !['completed', 'failed'].includes(report.state)
        && (latest.expiresAt <= Date.now() || Date.now() - report.receivedAt >= DOT_LIMITS.reportFreshMs);
      return { configured: true, hosting: !stopped && publicServer?.listening === true,
        reportState: stale ? 'stale' : report?.state ?? null, reportedAt: latest?.report?.receivedAt ?? null, expiresAt: latest?.expiresAt ?? null,
        ...(latest?.interactions?.length ? { relation: { kind: latest.interactions.at(-1)!.kind,
          direction: latest.interactions.at(-1)!.direction, stage: latest.interactions.at(-1)!.stage,
          target: latest.interactions.at(-1)!.targetRef, receivedAt: latest.interactions.at(-1)!.receivedAt, evidence: 'dot_report' as const } } : {}) };
    } };
  } catch (error) { await stop(); throw error; }
}
