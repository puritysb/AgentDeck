#!/usr/bin/env node
// App Store Connect certificate maintenance — list, and revoke by id.
//
//   node scripts/asc-certificates.mjs list
//   node scripts/asc-certificates.mjs revoke <id>[,<id>...]
//
// Cloud signing (`xcodebuild -allowProvisioningUpdates`) creates a signing
// certificate on demand, and Apple caps how many an account may hold. When the
// cap is reached the archive fails with "Choose a certificate to revoke. Your
// account has reached the maximum number of certificates" — which is how the
// 2026-08-04 macOS release archive died while the iOS one, needing no new
// certificate, sailed through. Freeing the cap is an account action, not a
// repository one, so it lives here rather than in a release workflow.
//
// Credentials come from the environment (ASC_KEY_ID / ASC_ISSUER_ID and either
// ASC_KEY_PATH or ASC_KEY_BASE64), so this runs in CI against the existing
// release secrets without a key ever leaving the runner.

import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER_ID = process.env.ASC_ISSUER_ID;
const keyPem = process.env.ASC_KEY_BASE64
  ? Buffer.from(process.env.ASC_KEY_BASE64, 'base64').toString('utf8')
  : process.env.ASC_KEY_PATH
    ? fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8')
    : null;

if (!KEY_ID || !ISSUER_ID || !keyPem) {
  console.error('Missing ASC_KEY_ID / ASC_ISSUER_ID / (ASC_KEY_BASE64 | ASC_KEY_PATH)');
  process.exit(2);
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  // ASC rejects a lifetime over 20 minutes.
  const payload = b64url(
    JSON.stringify({ iss: ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }),
  );
  // ES256 signatures must be JOSE (r||s) rather than DER, hence dsaEncoding.
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: crypto.createPrivateKey(keyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${b64url(sig)}`;
}

async function api(path, method = 'GET') {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
  });
  if (method === 'DELETE') {
    if (res.status !== 204) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return null;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function list() {
  const { data } = await api('/v1/certificates?limit=200');
  const now = Date.now();
  const rows = data.map((c) => {
    const a = c.attributes;
    const expired = new Date(a.expirationDate).getTime() < now;
    return {
      id: c.id,
      type: a.certificateType,
      name: a.displayName,
      serial: a.serialNumber,
      expires: a.expirationDate?.slice(0, 10),
      expired,
    };
  });
  rows.sort((x, y) => (x.type === y.type ? x.expires.localeCompare(y.expires) : x.type.localeCompare(y.type)));
  const byType = {};
  for (const r of rows) (byType[r.type] ||= []).push(r);
  console.log(`${rows.length} certificate(s)\n`);
  for (const [type, list] of Object.entries(byType)) {
    console.log(`${type} (${list.length})`);
    for (const r of list) {
      console.log(`  ${r.id}  ${r.expires}${r.expired ? ' EXPIRED' : '        '}  ${r.serial}  ${r.name}`);
    }
    console.log('');
  }
  console.log(JSON.stringify(rows));
}

async function revoke(ids) {
  for (const id of ids) {
    await api(`/v1/certificates/${id}`, 'DELETE');
    console.log(`revoked ${id}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'list') await list();
else if (cmd === 'revoke') {
  const ids = (arg || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { console.error('revoke needs comma-separated certificate ids'); process.exit(2); }
  await revoke(ids);
  console.log('\nRemaining:\n');
  await list();
} else {
  console.error('usage: asc-certificates.mjs (list | revoke <id>[,<id>...])');
  process.exit(2);
}
