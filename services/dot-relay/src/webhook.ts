import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';
import { Fault, LIMITS } from './contracts.js';
import type { Subscription } from './store.js';

export interface Reply { status: number; body: string }
export type Send = (url: string, body: string, headers: Record<string, string>) => Promise<Reply>;
export function callbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Fault(-32602, 'Invalid callback URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Fault(-32602, 'Callback must be HTTPS on port 443 without credentials or fragment');
  }
  return url;
}
export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    // Reject mapped IPv4, link-local, multicast, reserved and transition ranges.
    return parsed.range() === 'unicast';
  } catch { return false; }
}
export function signingKey(secret: string): void {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Fault(-32602, 'Invalid signing secret');
  const bytes = Buffer.from(secret.slice(6), 'base64');
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64') !== secret.slice(6)) {
    throw new Fault(-32602, 'Invalid signing secret');
  }
}
export function headers(sub: Subscription, id: string, body: string, now: number): Record<string, string> {
  const at = new Date(now);
  const secrets = [sub.secret, ...(sub.previous && sub.previous.until > now ? [sub.previous.secret] : [])];
  return {
    'Content-Type': 'application/json', 'webhook-id': id,
    'webhook-timestamp': String(Math.floor(now / 1000)),
    'webhook-signature': secrets.map(s => new Webhook(s).sign(id, at, body)).join(' '),
    'X-MCP-Subscription-Id': sub.id,
  };
}
export function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/** DNS is checked for every connection and pinned to the checked address. No redirects/agent reuse. */
export const sendPublic: Send = async (value, body, signedHeaders) => {
  const url = callbackUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.timeout(LIMITS.callbackMs);
  const resolving = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true });
  const addresses = await new Promise<Awaited<typeof resolving>>((resolve, reject) => {
    const abort = () => reject(new Error('Callback timeout'));
    signal.addEventListener('abort', abort, { once: true });
    resolving.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Non-public callback');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', agent: false, signal,
      headers: { ...signedHeaders, 'Content-Length': Buffer.byteLength(body) },
      // Preserve the URL host/SNI; only DNS resolution is replaced by the vetted address.
      lookup: (_hostname, options, done) => {
        if (options.all) done(null, [selected]);
        else done(null, selected.address, selected.family);
      },
    }, res => {
      let bytes = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > LIMITS.callbackResponseBytes) res.destroy(new Error('Callback response too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });
};
