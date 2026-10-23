#!/usr/bin/env node
// App Store Connect certificate maintenance and fixed-scope macOS release.
//
//   node scripts/asc-certificates.mjs list
//   node scripts/asc-certificates.mjs revoke <id>[,<id>...]
//   node scripts/asc-certificates.mjs release-prepare 1.9.2 <build-greater-than-9201>
//   node scripts/asc-certificates.mjs release-submit 1.9.2 <same-build>
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
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ORIGIN = 'https://api.appstoreconnect.apple.com';
const APP_ID = '6784822497';
const PLATFORM = 'MAC_OS';
const RELEASE_VERSION = '1.9.2';
const LOCALES = ['en-US', 'ko', 'ja'];
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED']);
const SUBMITTED = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW']);

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function token(keyId, issuerId, keyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  // ASC rejects a lifetime over 20 minutes.
  const payload = b64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }),
  );
  // ES256 signatures must be JOSE (r||s) rather than DER, hence dsaEncoding.
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: crypto.createPrivateKey(keyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${b64url(sig)}`;
}

export function createASCClient(env = process.env, transport = fetch) {
  const keyPem = env.ASC_KEY_BASE64
    ? Buffer.from(env.ASC_KEY_BASE64, 'base64').toString('utf8')
    : env.ASC_KEY_PATH ? fs.readFileSync(env.ASC_KEY_PATH, 'utf8') : null;
  if (!env.ASC_KEY_ID || !env.ASC_ISSUER_ID || !keyPem) {
    throw new Error('Missing ASC_KEY_ID / ASC_ISSUER_ID / (ASC_KEY_BASE64 | ASC_KEY_PATH)');
  }
  return async (path, method = 'GET', body) => {
    if (!path.startsWith('/v1/') || path.includes('..') || path.includes('#') || path.includes('\\')) {
      throw new Error('Invalid ASC resource path');
    }
    let res;
    try {
      res = await transport(`${ORIGIN}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token(env.ASC_KEY_ID, env.ASC_ISSUER_ID, keyPem)}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw Object.assign(new Error(`ASC ${method} outcome unknown; read back before retrying`), { outcomeUnknown: true });
    }
    // Do not log response bodies: they can echo review contacts or metadata.
    if (!res.ok) throw new Error(`ASC ${method} failed (HTTP ${res.status})`);
    if (method === 'DELETE' && res.status !== 204) throw new Error('ASC DELETE was not confirmed (expected HTTP 204)');
    if (res.status === 204) return null;
    try { return await res.json(); }
    catch { throw Object.assign(new Error(`ASC ${method} response unreadable; read back before retrying`), { outcomeUnknown: true }); }
  };
}

let api;

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

// Fixed app scope; credentials and contact/review notes never enter the log.
async function storeStatus() {
  const root = '/v1/apps/6784822497';
  const paths = [
    `${root}/appStoreVersions?limit=50&fields[appStoreVersions]=platform,versionString,appStoreState,releaseType`,
    `${root}/reviewSubmissions?limit=50&fields[reviewSubmissions]=platform,state,submittedDate`,
    `/v1/builds?filter[app]=6784822497&limit=20&sort=-uploadedDate&fields[builds]=version,processingState,uploadedDate,expired,preReleaseVersion&include=preReleaseVersion&fields[preReleaseVersions]=version,platform`,
  ];
  for (const path of paths) {
    const response = await api(path);
    console.log(JSON.stringify({resource: path.split('?')[0].split('/').at(-1), data: response.data, included: response.included ?? []}));
  }
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function resourceId(resource, type) {
  requireThat(resource?.type === type && /^[a-zA-Z0-9-]+$/.test(resource?.id ?? ''), `Invalid ${type} identity`);
  return resource.id;
}

function exactlyOne(rows, name) {
  requireThat(rows.length === 1, `Expected exactly one ${name}; refusing ambiguous or missing data`);
  return rows[0];
}

export function validateReleaseTarget(version, build) {
  requireThat(version === RELEASE_VERSION, `Release scope is macOS ${RELEASE_VERSION} only`);
  requireThat(typeof build === 'string' && /^[1-9]\d{3,8}$/.test(build) && Number(build) > 9201,
    'Expected an exact replacement build number greater than 9201');
}

/** Copy is taken only from the marked repository fields, never workflow input. */
export function extractReleaseCopy(metadata, reviewNotes, version) {
  requireThat(version === RELEASE_VERSION, 'Unsupported release copy version');
  const heading = `## Prepared macOS ${version} update text`;
  const parts = metadata.split(heading);
  requireThat(parts.length === 2, 'Missing or duplicate prepared macOS copy section');
  const section = parts[1].split(/^## /m)[0];
  const headings = ["English — macOS What's New", 'Korean — macOS 새로운 기능', 'Japanese — macOS このバージョンの新機能'];
  const whatsNew = {};
  for (let i = 0; i < LOCALES.length; i++) {
    const chunks = section.split(`### ${headings[i]}`);
    requireThat(chunks.length === 2, `Missing or duplicate ${LOCALES[i]} release copy`);
    const text = chunks[1].split(/^### /m)[0].match(/^```text\n([\s\S]*?)\n```/m)?.[1];
    requireThat(text?.trim() && text.length <= 4000, `Invalid ${LOCALES[i]} release copy length`);
    whatsNew[LOCALES[i]] = text;
  }
  const notesFields = [...reviewNotes.matchAll(/<!-- notes-field:begin -->\s*```text\n([\s\S]*?)\n```\s*<!-- notes-field:end -->/g)];
  const notes = exactlyOne(notesFields, 'macOS review notes field')[1];
  requireThat(notes.trim() && notes.length <= 4000 && notes.includes(`NEW IN ${version} — MACOS ONLY`),
    'Review notes must name this macOS version and fit the ASC field');
  return { whatsNew, notes };
}

/** Follow only this collection's ASC pagination, with a hard page bound. */
async function collection(request, path) {
  const pathname = new URL(path, ORIGIN).pathname;
  const data = [], included = [];
  const visited = new Set();
  let next = path;
  while (next) {
    requireThat(visited.size < 10 && !visited.has(next), 'ASC pagination exceeds the bounded read');
    visited.add(next);
    const response = await request(next);
    requireThat(Array.isArray(response?.data), 'ASC collection response is incomplete');
    data.push(...response.data);
    included.push(...(response.included ?? []));
    next = response.links?.next;
    if (next) {
      const url = new URL(next, ORIGIN);
      requireThat(url.origin === ORIGIN && !url.username && !url.password && !url.hash && url.pathname === pathname,
        'ASC pagination left the expected resource');
      next = url.pathname + url.search;
    }
  }
  return { data, included };
}

async function releaseSnapshot(request, version, build) {
  const versions = await collection(request,
    `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=${PLATFORM}&filter[versionString]=${version}&limit=200`);
  const target = exactlyOne(versions.data.filter(v => v.attributes?.platform === PLATFORM && v.attributes?.versionString === version), 'target app version');
  const versionId = resourceId(target, 'appStoreVersions');
  const builds = await collection(request,
    `/v1/builds?filter[app]=${APP_ID}&filter[version]=${build}&include=preReleaseVersion&limit=200`);
  const candidates = builds.data.filter(b => {
    const preId = b.relationships?.preReleaseVersion?.data?.id;
    const pre = builds.included.find(p => p.type === 'preReleaseVersions' && p.id === preId);
    return b.attributes?.version === build && pre?.attributes?.version === version && pre?.attributes?.platform === PLATFORM;
  });
  const binary = exactlyOne(candidates, 'matching macOS build');
  const buildId = resourceId(binary, 'builds');
  requireThat(binary.attributes.processingState === 'VALID' && binary.attributes.expired === false,
    'Replacement build must be VALID and not expired');
  const locales = await collection(request, `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`);
  const localizations = {};
  for (const locale of LOCALES) {
    const row = exactlyOne(locales.data.filter(l => l.attributes?.locale === locale), `${locale} localization`);
    resourceId(row, 'appStoreVersionLocalizations');
    localizations[locale] = row;
  }
  const review = (await request(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`)).data;
  resourceId(review, 'appStoreReviewDetails');
  const attached = (await request(`/v1/appStoreVersions/${versionId}/build`)).data;
  if (attached) resourceId(attached, 'builds');
  return { target, versionId, buildId, localizations, review, attachedId: attached?.id ?? null, attachedBuild: attached?.attributes?.version };
}

function assertPrepared(snapshot, copy) {
  requireThat(snapshot.attachedId === snapshot.buildId, 'Selected build does not match the expected replacement');
  requireThat(snapshot.target.attributes.releaseType === 'AFTER_APPROVAL', 'Automatic release after approval is not selected');
  for (const locale of LOCALES) {
    requireThat(snapshot.localizations[locale].attributes.whatsNew === copy.whatsNew[locale], `${locale} metadata readback differs from the repository`);
  }
  requireThat(snapshot.review.attributes?.notes === copy.notes, 'Review notes readback differs from the repository');
}

async function activeSubmissions(request) {
  const all = await collection(request, `/v1/apps/${APP_ID}/reviewSubmissions?filter[platform]=${PLATFORM}&limit=200`);
  const active = [];
  for (const submission of all.data) {
    resourceId(submission, 'reviewSubmissions');
    requireThat(submission.attributes?.platform === PLATFORM, 'Submission platform mismatch');
    requireThat(typeof submission.attributes.state === 'string', 'Submission state unavailable');
    if (submission.attributes.state === 'COMPLETE') continue;
    const items = await collection(request, `/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=200`);
    active.push({ submission, items: items.data });
  }
  requireThat(active.length <= 1, 'Multiple active macOS submissions; refusing to choose or cancel one');
  return active[0] ?? null;
}

function assertTargetItem(active, versionId) {
  const item = exactlyOne(active.items, 'review item');
  resourceId(item, 'reviewSubmissionItems');
  const related = item.relationships?.appStoreVersion?.data;
  requireThat(related?.type === 'appStoreVersions' && related.id === versionId,
    'Active submission contains another version or review item');
  // The draft must not contain another kind of reviewable content alongside it.
  for (const [key, relationship] of Object.entries(item.relationships ?? {})) {
    if (!['appStoreVersion', 'reviewSubmission'].includes(key)) {
      requireThat(relationship.data == null || (Array.isArray(relationship.data) && relationship.data.length === 0),
        'Unexpected content in the review item');
    }
  }
  return item;
}

/** Fixed release operation; callers cannot supply endpoints, methods or bodies. */
export async function runRelease({ action, version, build, copy, request, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  validateReleaseTarget(version, build);
  requireThat(['release-prepare', 'release-submit'].includes(action), 'Unknown release operation');
  requireThat(copy?.notes && LOCALES.every(l => typeof copy.whatsNew?.[l] === 'string' && copy.whatsNew[l].length > 0), 'Incomplete repository copy');
  let snapshot = await releaseSnapshot(request, version, build);
  let active = await activeSubmissions(request);
  if (active) {
    assertTargetItem(active, snapshot.versionId);
    requireThat(active.submission.attributes.state === 'READY_FOR_REVIEW' || SUBMITTED.has(active.submission.attributes.state),
      'Active submission is not in a supported editable/submitted state');
  }
  const receipt = status => ({ appId: APP_ID, platform: PLATFORM, version, build, status,
    versionId: snapshot.versionId, buildId: snapshot.buildId,
    ...(active ? { submissionId: active.submission.id } : {}),
    metadataSha256: crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex') });
  if (active && SUBMITTED.has(active.submission.attributes.state)) {
    assertPrepared(snapshot, copy);
    requireThat(SUBMITTED.has(snapshot.target.attributes.appStoreState), 'Version and submission states disagree');
    return receipt('already-submitted');
  }
  if (action === 'release-prepare') {
    requireThat(EDITABLE.has(snapshot.target.attributes.appStoreState), 'App version is not editable for this release');
    requireThat(snapshot.attachedId === snapshot.buildId || snapshot.attachedBuild === '9201',
      'Prepare may replace only the withdrawn 9201 build or the exact requested build');
    // Each PATCH is idempotent, but an unknown outcome stops the run. The next
    // invocation reads everything first and writes only remaining differences.
    const updates = [];
    for (const locale of LOCALES) {
      const row = snapshot.localizations[locale];
      if (row.attributes.whatsNew !== copy.whatsNew[locale]) updates.push([
        `/v1/appStoreVersionLocalizations/${row.id}`,
        { data: { type: 'appStoreVersionLocalizations', id: row.id, attributes: { whatsNew: copy.whatsNew[locale] } } },
      ]);
    }
    if (snapshot.review.attributes?.notes !== copy.notes) updates.push([
      `/v1/appStoreReviewDetails/${snapshot.review.id}`,
      { data: { type: 'appStoreReviewDetails', id: snapshot.review.id, attributes: { notes: copy.notes } } },
    ]);
    if (snapshot.target.attributes.releaseType !== 'AFTER_APPROVAL') updates.push([
      `/v1/appStoreVersions/${snapshot.versionId}`,
      { data: { type: 'appStoreVersions', id: snapshot.versionId, attributes: { releaseType: 'AFTER_APPROVAL' } } },
    ]);
    if (snapshot.attachedId !== snapshot.buildId) updates.push([
      `/v1/appStoreVersions/${snapshot.versionId}/relationships/build`,
      { data: { type: 'builds', id: snapshot.buildId } },
    ]);
    try {
      for (const [path, body] of updates) {
        if (path.endsWith('/relationships/build')) {
          const current = (await request(`/v1/appStoreVersions/${snapshot.versionId}/build`)).data;
          requireThat(current?.id === snapshot.buildId || current?.attributes?.version === '9201',
            'Build association changed during preparation; refusing to replace another candidate');
        }
        await request(path, 'PATCH', body);
      }
    } catch (error) {
      if (!error.outcomeUnknown) throw error;
      // Even when a PATCH response was lost, no success without exact readback.
      snapshot = await releaseSnapshot(request, version, build);
      assertPrepared(snapshot, copy);
      return receipt('prepared');
    }
    snapshot = await releaseSnapshot(request, version, build);
    assertPrepared(snapshot, copy);
    return receipt('prepared');
  }

  assertPrepared(snapshot, copy);
  requireThat(active ? snapshot.target.attributes.appStoreState === 'READY_FOR_REVIEW' : EDITABLE.has(snapshot.target.attributes.appStoreState),
    'App version does not match the expected new or ready submission state');
  if (!active) {
    let created;
    try {
      created = (await request('/v1/reviewSubmissions', 'POST', { data: {
        type: 'reviewSubmissions', attributes: { platform: PLATFORM },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      } })).data;
      resourceId(created, 'reviewSubmissions');
    } catch (error) {
      if (!error.outcomeUnknown) throw error;
      // An empty draft has no ownership marker. Never guess that a newly seen
      // draft is ours or repeat POST after a response/connection was lost.
      await activeSubmissions(request);
      throw new Error('Submission creation outcome unknown; inspect the macOS draft before retrying');
    }
    active = await activeSubmissions(request);
    requireThat(active?.submission.id === created.id && active.submission.attributes.state === 'READY_FOR_REVIEW' && active.items.length === 0,
      'Created submission could not be confirmed as the sole empty macOS draft');
    try {
      await request('/v1/reviewSubmissionItems', 'POST', { data: {
        type: 'reviewSubmissionItems', relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: created.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: snapshot.versionId } },
        },
      } });
    } catch (error) {
      if (!error.outcomeUnknown) throw error;
      // The exact item readback below is the only evidence of a lost POST.
    }
    active = await activeSubmissions(request);
    requireThat(active?.submission.id === created.id, 'Review item creation outcome unknown; refusing a second POST');
  }
  const item = assertTargetItem(active, snapshot.versionId);
  requireThat(active.submission.attributes.state === 'READY_FOR_REVIEW' && item.attributes?.state === 'READY_FOR_REVIEW',
    'Submission and its exact version item must both be READY_FOR_REVIEW');
  snapshot = await releaseSnapshot(request, version, build);
  assertPrepared(snapshot, copy);
  // Adding the appStoreVersion item transitions the version itself to READY.
  requireThat(snapshot.target.attributes.appStoreState === 'READY_FOR_REVIEW', 'Version is not READY_FOR_REVIEW before submission');
  const submissionId = active.submission.id;
  try {
    await request(`/v1/reviewSubmissions/${submissionId}`, 'PATCH', {
      data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
    });
  } catch (error) {
    if (!error.outcomeUnknown) throw error;
    // No retry mutation: reconcile the same resource's state below.
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    active = await activeSubmissions(request);
    requireThat(active?.submission.id === submissionId, 'Submitted resource could not be confirmed');
    assertTargetItem(active, snapshot.versionId);
    if (SUBMITTED.has(active.submission.attributes.state)) {
      snapshot = await releaseSnapshot(request, version, build);
      assertPrepared(snapshot, copy);
      requireThat(SUBMITTED.has(snapshot.target.attributes.appStoreState), 'Submitted version state is not yet confirmed');
      return receipt('submitted');
    }
    requireThat(active.submission.attributes.state === 'READY_FOR_REVIEW', 'Submission entered an unexpected state; inspect ASC');
    if (attempt < 2) await pause(1000);
  }
  throw new Error('Submission outcome not confirmed; read back before retrying the same target');
}

export async function main(args = process.argv.slice(2)) {
  const [cmd, arg, build] = args;
  if (['release-prepare', 'release-submit'].includes(cmd)) validateReleaseTarget(arg, build);
  else requireThat(['list', 'revoke', 'store-status'].includes(cmd),
    'usage: asc-certificates.mjs (list | store-status | revoke <ids> | release-prepare <version> <build> | release-submit <version> <build>)');
  api = createASCClient();
  if (cmd === 'store-status') await storeStatus();
  else if (cmd === 'list') await list();
  else if (cmd === 'revoke') {
    const ids = (arg || '').split(',').map(s => s.trim()).filter(Boolean);
    requireThat(ids.length > 0 && ids.every(id => /^[a-zA-Z0-9]+$/.test(id)), 'revoke needs explicit comma-separated certificate ids');
    await revoke(ids);
    console.log('\nRemaining:\n');
    await list();
  } else {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const copy = extractReleaseCopy(
      fs.readFileSync(resolve(root, 'docs/appstore-metadata-draft.md'), 'utf8'),
      fs.readFileSync(resolve(root, 'apple/APP_REVIEW_NOTES.md'), 'utf8'), arg);
    console.log(JSON.stringify(await runRelease({ action: cmd, version: arg, build, copy, request: api })));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
