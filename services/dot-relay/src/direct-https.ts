import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import type { ServerOptions } from 'node:https';

export interface DirectHTTPS {
  origin: string;
  validUntil: number;
  port: number;
  host: string;
  tls: ServerOptions;
}

/** Validates local inputs only. DNS, public trust and internet reachability need separate probes. */
export function directHTTPS(env: NodeJS.ProcessEnv, now = Date.now()): DirectHTTPS {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const origin = new URL(required('DOT_RELAY_RESOURCE'));
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== '/' || origin.hostname === 'localhost') throw new Error('Expected a public HTTPS origin');
  const port = Number(env.DOT_RELAY_PORT ?? '9476');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || (port >= 9120 && port <= 9139)) {
    throw new Error('Invalid isolated HTTPS port');
  }
  const host = env.DOT_RELAY_BIND ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(host)) throw new Error('Invalid HTTPS bind address');
  const certPath = required('DOT_RELAY_TLS_CERT'), keyPath = required('DOT_RELAY_TLS_KEY');
  if (!isAbsolute(certPath) || !isAbsolute(keyPath)) throw new Error('TLS paths must be absolute');
  const cert = readFileSync(certPath), key = readFileSync(keyPath);
  const leaf = new X509Certificate(cert);
  if (!(Date.parse(leaf.validFrom) <= now && now < Date.parse(leaf.validTo))) throw new Error('TLS certificate is not currently valid');
  const hostname = origin.hostname.replace(/^\[|\]$/g, '');
  if (!(isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname, { subject: 'never' }))) throw new Error('TLS certificate does not match the public hostname');
  const certificateKey = leaf.publicKey.export({ type: 'spki', format: 'der' });
  const privateKey = createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' });
  if (certificateKey.length !== privateKey.length || !timingSafeEqual(certificateKey, privateKey)) throw new Error('TLS key does not match certificate');
  return { origin: origin.origin, validUntil: Date.parse(leaf.validTo), port, host, tls: { cert, key, minVersion: 'TLSv1.2' } };
}
