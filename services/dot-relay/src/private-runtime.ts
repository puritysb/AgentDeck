import { DOT_LIMITS, DOT_OAUTH_LIMITS, DOT_PRIVATE_MCP as PRIVATE } from '@agentdeck/shared';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { Relay } from './relay.js';
import { createRelayServer } from './server.js';

export interface PrivateHostConfiguration { enabled: boolean; mode: 'private-tunnel'; port: number; controlPort: number; bind?: string }
export function privateEndpoint(config: PrivateHostConfiguration) {
  for (const port of [config.port, config.controlPort]) {
    if (!Number.isInteger(port) || port < PRIVATE.minPort || port > PRIVATE.maxPort
      || (port >= PRIVATE.reservedStart && port <= PRIVATE.reservedEnd)) throw new Error('Invalid private MCP port');
  }
  if (config.port === config.controlPort || (config.bind !== undefined && config.bind !== PRIVATE.host)) throw new Error('Private MCP must remain on loopback');
  return `${PRIVATE.scheme}://${PRIVATE.host}:${config.port}`;
}
export async function startPrivateHost(config: PrivateHostConfiguration, directory: string) {
  const origin = privateEndpoint(config);
  const credentialPath = join(directory, 'dot-private-credential.json');
  if (!existsSync(credentialPath)) writeFileSync(credentialPath, JSON.stringify({ token: randomBytes(PRIVATE.tokenBytes).toString('base64url'), createdAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  const credential = JSON.parse(readFileSync(credentialPath, 'utf8')) as { token: string; createdAt: number };
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential.token) || !Number.isSafeInteger(credential.createdAt) || credential.createdAt < 0 || credential.createdAt > Date.now()) throw new Error('Invalid private MCP credential');
  // The official client can use file: header references without tokens in argv or logs.
  writeFileSync(join(directory, 'dot-private-authorization'), `Bearer ${credential.token}`, { mode: 0o600 });
  const operatorPath = join(directory, 'dot-operator-token');
  if (!existsSync(operatorPath)) writeFileSync(operatorPath, randomBytes(PRIVATE.tokenBytes).toString('base64url'), { mode: 0o600, flag: 'wx' });
  const operatorToken = readFileSync(operatorPath, 'utf8');
  if (!/^[A-Za-z0-9_-]{43}$/.test(operatorToken)) throw new Error('Invalid operator credential');
  const expiresAt = credential.createdAt + DOT_OAUTH_LIMITS.refreshMs;
  const subject = 'private-' + createHash('sha256').update(credential.token).digest('hex').slice(0, 32);
  const scopes = ['agentdeck:read', 'agentdeck:report', 'agentdeck:subscribe'];
  const store = new Store(join(directory, 'dot-state.json'));
  const hasAccess = (id: string) => id === subject && Date.now() < expiresAt && !store.read().revoked.includes(id);
  const relay = new Relay(store, undefined, undefined, hasAccess);
  const matches = (received: string, expected: string) => { const a = Buffer.from(received), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); };
  const operatorAccess = {
    pendingRequests: () => [], grants: () => hasAccess(subject) ? [{ id: subject, scopes, expiresAt }] : [], hasAccess,
    decide: () => { throw new Error('Private tunnel uses its dedicated credential'); },
    revokeGrant: (id: string) => { if (id !== subject) throw new Error('Unknown connection'); store.change(s => { if (!s.revoked.includes(id)) s.revoked.push(id); }); },
  };
  const mcp = createRelayServer(relay, async token => {
    if (!matches(token, credential.token) || !hasAccess(subject)) throw new Error('Invalid private connection credential');
    return { subject, scopes };
  }, origin, origin, { deviceRoutes: false, privateBearer: true });
  const operator = createRelayServer(relay, async token => {
    if (!matches(token, operatorToken)) throw new Error('Invalid operator credential');
    return { subject: 'local-operator', scopes: ['agentdeck:device'] };
  }, origin, origin, { operator: true, operatorAccess });
  let stopped = false, work: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const stop = async () => {
    if (stopped) return; stopped = true; clearInterval(timer);
    const drained = relay.stop();
    for (const server of [mcp, operator]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await Promise.all([work, drained]); store.close();
  };
  try {
    for (const [server, port] of [[mcp, config.port], [operator, config.controlPort]] as const) {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, PRIVATE.host, () => { server.removeListener('error', reject); resolve(); }); });
    }
    timer = setInterval(() => {
      if (work || stopped) return;
      work = relay.deliver().catch(() => console.error('Private Dot delivery failed')).finally(() => { work = undefined; });
    }, 1000); timer.unref();
    return { stop, origin, reports: () => relay.list(), deckSnapshot: () => {
      const latest = relay.list().sort((a,b) => b.createdAt - a.createdAt)[0], report = latest?.report;
      const stale = report && !['completed', 'failed'].includes(report.state)
        && (latest!.expiresAt <= Date.now() || Date.now() - report.receivedAt >= DOT_LIMITS.reportFreshMs);
      const edge = latest?.interactions?.at(-1);
      return { configured: true, hosting: !stopped, reportState: stale ? 'stale' : report?.state ?? null,
        reportedAt: report?.receivedAt ?? null, expiresAt: latest?.expiresAt ?? null,
        ...(edge ? { relation: { kind: edge.kind, direction: edge.direction, stage: edge.stage, target: edge.targetRef, receivedAt: edge.receivedAt, evidence: 'dot_report' as const } } : {}) };
    } };
  } catch (error) { await stop(); throw error; }
}
