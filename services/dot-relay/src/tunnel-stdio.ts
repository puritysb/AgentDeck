/** Private operator experiment: official tunnel stdio -> authenticated loopback MCP.
 * No listener, operator credential, cloud OAuth impersonation or report synthesis.
 */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DOT_LOCAL_MCP, DOT_LIMITS, DOT_OAUTH_LIMITS } from '@agentdeck/shared';

export const RESOURCE = `http://${DOT_LOCAL_MCP.host}:${DOT_LOCAL_MCP.port}`;
const SCOPES = ['agentdeck:read', 'agentdeck:report'];
const METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized', 'notifications/cancelled']);
const TOOLS = new Set(['get_request', 'get_context', 'claim_request', 'report_update', 'report_interaction']);
export interface Credentials {
  version: 1; resource: string; access: string; refresh: string; expiresAt: number;
  scopes: string[]; refreshing: boolean;
}
export interface CredentialStore { read(): Credentials; save(value: Credentials): void }

function valid(value: Credentials): boolean {
  return value?.version === 1 && value.resource === RESOURCE && /^[A-Za-z0-9_-]{43}$/.test(value.access)
    && /^[A-Za-z0-9_-]{43}$/.test(value.refresh) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
    && typeof value.refreshing === 'boolean' && Array.isArray(value.scopes) && value.scopes.length === SCOPES.length
    && SCOPES.every(s => value.scopes.includes(s));
}

/** One runtime owns the file. A stale lock is deliberately not auto-reclaimed. */
export class PrivateCredentials implements CredentialStore {
  private lock: number;
  private closed = false;
  constructor(readonly path: string) {
    const parent = lstatSync(dirname(path));
    if (!isAbsolute(path) || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
      || parent.uid !== process.getuid?.()) throw new Error('Credential directory must be private and user-owned');
    this.lock = openSync(`${path}.lock`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(this.lock, String(process.pid)); }
    catch (error) { closeSync(this.lock); unlinkSync(`${path}.lock`); throw error; }
  }
  read(): Credentials {
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 8192)
        throw new Error('Unsafe credential file');
      const value = JSON.parse(readFileSync(fd, 'utf8')) as Credentials;
      if (!valid(value)) throw new Error('Invalid credential file');
      return value;
    } finally { closeSync(fd); }
  }
  save(value: Credentials): void {
    if (!valid(value)) throw new Error('Invalid credentials');
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    catch (error) { unlinkSync(temp); throw error; }
    finally { closeSync(fd); }
    try { renameSync(temp, this.path); }
    catch (error) { unlinkSync(temp); throw error; }
    const directory = openSync(dirname(this.path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; closeSync(this.lock); unlinkSync(`${this.path}.lock`);
  }
}

export async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > DOT_LIMITS.bodyBytes) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

export function credentialsFrom(value: unknown, now: number): Credentials {
  const v = value as Record<string, unknown>;
  if (!v || v.token_type !== 'Bearer' || v.resource !== RESOURCE || typeof v.scope !== 'string'
    || typeof v.expires_in !== 'number' || !Number.isSafeInteger(v.expires_in) || v.expires_in <= 0
    || v.expires_in * 1000 > DOT_OAUTH_LIMITS.accessMs) throw new Error('Invalid token response');
  const result: Credentials = { version: 1, resource: RESOURCE, access: v.access_token as string,
    refresh: v.refresh_token as string, expiresAt: now + v.expires_in * 1000, scopes: v.scope.split(' '), refreshing: false };
  if (!valid(result)) throw new Error('Invalid token response');
  return result;
}

export class TunnelSession {
  private refreshFlight?: Promise<string>;
  private failed = false;
  constructor(private store: CredentialStore, private fetcher: typeof fetch = fetch, private clock = Date.now) {}
  private async access(): Promise<string> {
    if (this.failed) throw new Error('Reauthorization required');
    if (this.refreshFlight) return this.refreshFlight;
    const saved = this.store.read();
    if (saved.refreshing) throw new Error('Refresh outcome unknown; reauthorization required');
    if (saved.expiresAt - this.clock() > 30_000) return saved.access;
    this.refreshFlight = this.rotate(saved);
    try { return await this.refreshFlight; } finally { this.refreshFlight = undefined; }
  }
  private async rotate(saved: Credentials): Promise<string> {
    // Mark BEFORE sending: timeout/crash after server-side rotation must never replay a refresh token.
    try {
      this.store.save({ ...saved, refreshing: true });
      const response = await this.fetcher(`${RESOURCE}/oauth/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(DOT_LIMITS.callbackMs),
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: DOT_LOCAL_MCP.clientId,
          resource: RESOURCE, refresh_token: saved.refresh }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Refresh refused'); }
      const next = credentialsFrom(JSON.parse(await boundedText(response)), this.clock());
      this.store.save(next); return next.access;
    } catch { this.failed = true; throw new Error('Refresh failed; reauthorization required'); }
  }
  async forward(request: Record<string, unknown>): Promise<unknown | undefined> {
    const id = request?.id;
    const hasId = Object.hasOwn(request ?? {}, 'id');
    const failure = (code: number, message: string) => ({ jsonrpc: '2.0', id: typeof id === 'string' || Number.isSafeInteger(id) ? id : null, error: { code, message } });
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
      || (hasId && typeof id !== 'string' && !Number.isSafeInteger(id))) return failure(-32600, 'Invalid request');
    if (!METHODS.has(request.method) || (!hasId && !request.method.startsWith('notifications/')))
      return hasId ? failure(-32601, 'Unsupported tunnel method') : undefined;
    if (request.method === 'tools/call' && !TOOLS.has((request.params as { name?: string })?.name ?? ''))
      return failure(-32601, 'Unsupported tunnel tool');
    if (Buffer.byteLength(JSON.stringify(request)) > DOT_LIMITS.bodyBytes) return failure(-32600, 'Request too large');
    try {
      const access = await this.access();
      const response = await this.fetcher(`${RESOURCE}/mcp`, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(DOT_LIMITS.callbackMs), headers: { Authorization: `Bearer ${access}`,
          'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify(request) });
      if (response.status === 401 || response.status === 403) this.failed = true;
      if (!response.ok) { await response.body?.cancel(); throw new Error('MCP refused'); }
      if (!hasId) { await response.body?.cancel(); return undefined; }
      const value = JSON.parse(await boundedText(response)) as Record<string, unknown>;
      if (value.jsonrpc !== '2.0' || value.id !== id || (!('result' in value) && !('error' in value))) throw new Error('Invalid MCP response');
      return value;
    } catch { return hasId ? failure(-32001, 'AgentDeck unavailable or authorization requires renewal; check the local operator') : undefined; }
  }
}

/** Serialized, byte-bounded frames prevent concurrent rotating refreshes and write replay. */
export async function serveStdio(input: AsyncIterable<Buffer | string>, output: (line: string) => Promise<void>, session: TunnelSession): Promise<void> {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > DOT_LIMITS.bodyBytes) throw new Error('MCP input exceeds limit');
      const line = pending.subarray(0, end).toString('utf8'); pending = pending.subarray(end + 1);
      if (!line.trim()) continue;
      let value: Record<string, unknown>;
      try { value = JSON.parse(line); } catch { await output(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }) + '\n'); continue; }
      const response = await session.forward(value);
      if (response !== undefined) await output(JSON.stringify(response) + '\n');
    }
    if (pending.length > DOT_LIMITS.bodyBytes) throw new Error('MCP input exceeds limit');
  }
  if (pending.length) throw new Error('Incomplete MCP frame');
}
