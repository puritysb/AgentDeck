#!/usr/bin/env node
// App Store Connect certificate maintenance and guarded macOS release.
//
//   node scripts/asc-certificates.mjs list
//   node scripts/asc-certificates.mjs revoke <id>[,<id>...]
//   node scripts/asc-certificates.mjs release-prepare <version> <build> <uploaded-ci-run>
//   node scripts/asc-certificates.mjs release-submit <version> <same-build> <same-uploaded-ci-run>
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
const REPOSITORY = 'puritysb/AgentDeck';
const RELEASE_WORKFLOW = '.github/workflows/apple-release.yml';
const LOCALES = ['en-US', 'ko', 'ja'];
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED']);
const SUBMITTED = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW']);
const TERMINAL = new Set(['READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION', 'DEVELOPER_REMOVED_FROM_SALE', 'REMOVED_FROM_SALE']);

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
    if (!res.ok) {
      let codes = [];
      try {
        const body = await res.json();
        codes = (body.errors ?? []).map(error => error.code).filter(code => typeof code === 'string' && /^[A-Z0-9_.-]{1,100}$/.test(code)).slice(0,5);
      } catch { /* The HTTP status remains sufficient when the error is unreadable. */ }
      throw new Error(`ASC ${method} failed (HTTP ${res.status})${codes.length ? ` [${codes.join(', ')}]` : ''} at ${path.split('?')[0]}`);
    }
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

function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function validateVersion(version) {
  requireThat(typeof version === 'string' && /^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && version.length <= 18 && compareVersions(version, '1.9.2') >= 0, 'Expected an explicit supported macOS release version');
}

export function validateReleaseTarget(version, build) {
  validateVersion(version);
  requireThat(typeof build === 'string' && /^[1-9]\d{3,8}$/.test(build) && Number(build) > 9201,
    'Expected an exact release build number greater than 9201');
}

/** The upload run, source and retained artifact must all identify this candidate.
 * GitHub credentials stay on the runner; no logs or private artifact content are read. */
export async function verifyReleaseProvenance({ version, build, runId, sourceSha, request }) {
  validateReleaseTarget(version, build);
  requireThat(/^[1-9]\d+$/.test(runId ?? '') && /^[a-f0-9]{40}$/.test(sourceSha ?? ''),
    'An explicit uploaded CI run and full source commit are required');
  const path = `/repos/${REPOSITORY}/actions/runs/${runId}`;
  const run = await request(path);
  requireThat(String(run.id) === runId && run.repository?.full_name === REPOSITORY
    && run.path === RELEASE_WORKFLOW && run.head_sha === sourceSha
    && run.status === 'completed' && run.conclusion === 'success'
    && ['workflow_dispatch', 'push'].includes(run.event), 'Upload run identity, source or success does not match');
  requireThat(Number.isSafeInteger(run.run_number) && Number.isSafeInteger(run.run_attempt)
    && run.run_number > 0 && run.run_attempt > 0 && run.run_attempt < 100
    && String(run.run_number * 100 + run.run_attempt) === build, 'Upload run build number does not match');
  const jobs = await request(`${path}/attempts/${run.run_attempt}/jobs?per_page=100`);
  requireThat(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length, 'Upload job list is incomplete');
  const mac = exactlyOne(jobs.jobs.filter(job => job.steps?.some(step => step.name === 'Upload macOS to App Store Connect')), 'macOS upload job');
  for (const name of ['Verify App Store invariants (exported pkg)', 'Retain verified macOS candidate', 'Upload macOS to App Store Connect']) {
    const step = exactlyOne(mac.steps.filter(s => s.name === name), name);
    requireThat(step.status === 'completed' && step.conclusion === 'success', `${name} did not succeed`);
  }
  requireThat(mac.status === 'completed' && mac.conclusion === 'success', 'macOS upload job did not succeed');
  const artifacts = await request(`${path}/artifacts?per_page=100`);
  requireThat(Array.isArray(artifacts.artifacts) && artifacts.total_count === artifacts.artifacts.length, 'Artifact list is incomplete');
  const artifact = exactlyOne(artifacts.artifacts.filter(a => a.name === `apple-macos-${version}-${run.run_number}-${run.run_attempt}`), 'matching macOS artifact');
  requireThat(artifact.expired === false && artifact.size_in_bytes > 0 && /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
    && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === sourceSha, 'Uploaded artifact provenance is incomplete');
  return { sourceSha, runId, artifactId: artifact.id, artifactDigest: artifact.digest };
}

function githubClient(env = process.env, transport = fetch) {
  requireThat(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_TOKEN, 'Release provenance requires this repository CI token');
  return async path => {
    requireThat(path.startsWith(`/repos/${REPOSITORY}/actions/runs/`), 'Invalid GitHub provenance resource');
    const response = await transport(`https://api.github.com${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    requireThat(response.ok, `GitHub provenance read failed (HTTP ${response.status})`);
    try { return await response.json(); }
    catch { throw new Error('GitHub provenance response unreadable'); }
  };
}

/** Copy is taken only from the marked repository fields, never workflow input. */
export function extractReleaseCopy(metadata, reviewNotes, version) {
  validateVersion(version);
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

async function releaseBuild(request, version, build) {
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
    'Release build must be VALID and not expired');
  return { binary, buildId };
}

const LOCALIZED_FIELDS = ['description', 'keywords', 'marketingUrl', 'promotionalText', 'supportUrl'];
const REVIEW_CONTACT_FIELDS = ['contactEmail', 'contactFirstName', 'contactLastName', 'contactPhone'];
const REVIEW_FIELDS = ['contactEmail', 'contactFirstName', 'contactLastName', 'contactPhone', 'demoAccountRequired', 'demoAccountName', 'demoAccountPassword'];
const missingFields = (current, baseline, fields) => Object.fromEntries(fields.filter(key => (current?.[key] == null || current[key] === '') && baseline[key] != null).map(key => [key, baseline[key]]));
const pick = (attributes, fields) => Object.fromEntries(fields.filter(key => attributes?.[key] != null).map(key => [key, attributes[key]]));

async function macVersions(request) {
  const rows = (await collection(request, `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=${PLATFORM}&limit=200`)).data;
  for (const row of rows) {
    resourceId(row, 'appStoreVersions');
    requireThat(row.attributes?.platform === PLATFORM, 'Version platform mismatch');
  }
  return rows;
}

/** A missing relationship is explicit null, never an HTTP error or omitted data. */
async function versionRelationship(request, versionId, name, type) {
  const root = `/v1/appStoreVersions/${versionId}`;
  const linkage = await request(`${root}/relationships/${name}`);
  requireThat(linkage && Object.hasOwn(linkage, 'data'), `${name} relationship is unreadable`);
  if (linkage.data === null) return null;
  const expected = resourceId(linkage.data, type);
  const value = (await request(`${root}/${name}`)).data;
  requireThat(resourceId(value, type) === expected, `${name} relationship changed during readback`);
  return value;
}

function canAttach(version, current, buildId) {
  return current?.id === buildId || current == null || (version === '1.9.2' && current.attributes?.version === '9201');
}

/** POSTs have natural identities (app/platform/version or version/locale).
 * After a lost response, stop; the next invocation reads those identities first.
 * Never retry a creation within the same invocation. */
async function ensureReleaseVersion(request, version, build, copy) {
  const { buildId } = await releaseBuild(request, version, build);
  let versions = await macVersions(request);
  let matches = versions.filter(v => v.attributes.versionString === version);
  requireThat(matches.length <= 1, 'Duplicate target app versions');
  if (matches.length && !EDITABLE.has(matches[0].attributes.appStoreState)) return;
  const target = matches[0];
  const active = await activeSubmissions(request);
  requireThat(!active, 'Do not initialize metadata while a macOS review submission is active');
  requireThat(versions.every(v => v.id === target?.id || TERMINAL.has(v.attributes.appStoreState)),
    'Another macOS version is in flight');
  if (target) {
    const current = await versionRelationship(request, target.id, 'build', 'builds');
    requireThat(canAttach(version, current, buildId), 'Prepare cannot replace an unrelated candidate');
    const locales = (await collection(request, `/v1/appStoreVersions/${target.id}/appStoreVersionLocalizations?limit=200`)).data;
    const review = await versionRelationship(request, target.id, 'appStoreReviewDetail', 'appStoreReviewDetails');
    // Existing complete versions keep their metadata, including the legacy replacement path.
    const complete = LOCALES.every(l => locales.filter(row => row.attributes?.locale === l).length === 1) && review;
    if (complete && (version === '1.9.2' || (locales.filter(row => LOCALES.includes(row.attributes?.locale))
      .every(row => row.attributes.description?.trim() && row.attributes.supportUrl?.trim())
      && REVIEW_CONTACT_FIELDS.every(key => review.attributes?.[key]?.trim())
      && typeof review.attributes?.demoAccountRequired === 'boolean'
      && (!review.attributes.demoAccountRequired || (review.attributes.demoAccountName && review.attributes.demoAccountPassword))))) return;
    requireThat(target.attributes.appStoreState === 'PREPARE_FOR_SUBMISSION', 'Only a new draft may initialize missing metadata');
  }
  const prior = versions.filter(v => v.attributes.appStoreState === 'READY_FOR_SALE'
    && /^\d+\.\d+\.\d+$/.test(v.attributes.versionString));
  prior.sort((a, b) => compareVersions(b.attributes.versionString, a.attributes.versionString));
  requireThat(prior.length > 0 && compareVersions(version, prior[0].attributes.versionString) > 0,
    'A new version must follow the latest released macOS version');
  const baseline = prior[0];
  const baselineLocales = (await collection(request, `/v1/appStoreVersions/${baseline.id}/appStoreVersionLocalizations?limit=200`)).data;
  const baselineReview = await versionRelationship(request, baseline.id, 'appStoreReviewDetail', 'appStoreReviewDetails');
  resourceId(baselineReview, 'appStoreReviewDetails');
  const inherited = {};
  for (const locale of LOCALES) {
    const row = exactlyOne(baselineLocales.filter(l => l.attributes?.locale === locale), `released ${locale} localization`);
    inherited[locale] = pick(row.attributes, LOCALIZED_FIELDS);
    requireThat(inherited[locale].description?.trim() && inherited[locale].supportUrl?.trim(), 'Released localization lacks required metadata');
  }
  const reviewAttributes = pick(baselineReview.attributes, REVIEW_FIELDS);
  requireThat(REVIEW_CONTACT_FIELDS.every(key => reviewAttributes[key]?.trim())
    && typeof reviewAttributes.demoAccountRequired === 'boolean', 'Released review contact information is incomplete');
  requireThat(!reviewAttributes.demoAccountRequired || (reviewAttributes.demoAccountName && reviewAttributes.demoAccountPassword), 'Released review demo account is incomplete');
  requireThat(baseline.attributes.copyright?.trim(), 'Released copyright is missing');
  if (!target) {
    await request('/v1/appStoreVersions', 'POST', { data: {
      type: 'appStoreVersions',
      attributes: { platform: PLATFORM, versionString: version, releaseType: 'AFTER_APPROVAL', copyright: baseline.attributes.copyright },
      relationships: { app: { data: { type: 'apps', id: APP_ID } } },
    } });
  }
  versions = await macVersions(request);
  const created = exactlyOne(versions.filter(v => v.attributes.versionString === version), 'new target app version');
  requireThat(created.attributes.appStoreState === 'PREPARE_FOR_SUBMISSION', 'New version is no longer editable');
  requireThat(canAttach(version, await versionRelationship(request, created.id, 'build', 'builds'), buildId), 'New version acquired another build');
  const locales = (await collection(request, `/v1/appStoreVersions/${created.id}/appStoreVersionLocalizations?limit=200`)).data;
  for (const locale of LOCALES) {
    const existing = locales.filter(l => l.attributes?.locale === locale);
    requireThat(existing.length <= 1, `Duplicate ${locale} localization`);
    if (existing.length) {
      const row = existing[0];
      resourceId(row, 'appStoreVersionLocalizations');
      const attributes = missingFields(row.attributes, inherited[locale], ['description', 'supportUrl']);
      if (Object.keys(attributes).length) await request(`/v1/appStoreVersionLocalizations/${row.id}`, 'PATCH', {
        data: { type: 'appStoreVersionLocalizations', id: row.id, attributes },
      });
      continue; // Preserve existing values and media; fill only missing required text.
    }
    await request('/v1/appStoreVersionLocalizations', 'POST', { data: {
      type: 'appStoreVersionLocalizations', attributes: { locale, ...inherited[locale], whatsNew: copy.whatsNew[locale] },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: created.id } } },
    } });
  }
  const review = await versionRelationship(request, created.id, 'appStoreReviewDetail', 'appStoreReviewDetails');
  if (!review) await request('/v1/appStoreReviewDetails', 'POST', { data: {
    type: 'appStoreReviewDetails', attributes: { ...reviewAttributes, notes: copy.notes },
    relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: created.id } } },
  } });
  else {
    resourceId(review, 'appStoreReviewDetails');
    const attributes = missingFields(review.attributes, reviewAttributes, [...REVIEW_CONTACT_FIELDS, 'demoAccountRequired']);
    if ((attributes.demoAccountRequired ?? review.attributes?.demoAccountRequired) === true) {
      Object.assign(attributes, missingFields(review.attributes, reviewAttributes, ['demoAccountName', 'demoAccountPassword']));
    }
    if (Object.keys(attributes).length) await request(`/v1/appStoreReviewDetails/${review.id}`, 'PATCH', {
      data: { type: 'appStoreReviewDetails', id: review.id, attributes },
    });
  }
}

async function releaseSnapshot(request, version, build) {
  const versions = await collection(request,
    `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=${PLATFORM}&filter[versionString]=${version}&limit=200`);
  const target = exactlyOne(versions.data.filter(v => v.attributes?.platform === PLATFORM && v.attributes?.versionString === version), 'target app version');
  const versionId = resourceId(target, 'appStoreVersions');
  const { buildId } = await releaseBuild(request, version, build);
  const locales = await collection(request, `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`);
  const localizations = {};
  for (const locale of LOCALES) {
    const row = exactlyOne(locales.data.filter(l => l.attributes?.locale === locale), `${locale} localization`);
    resourceId(row, 'appStoreVersionLocalizations');
    localizations[locale] = row;
  }
  const review = await versionRelationship(request, versionId, 'appStoreReviewDetail', 'appStoreReviewDetails');
  resourceId(review, 'appStoreReviewDetails');
  if (version !== '1.9.2') {
    requireThat(LOCALES.every(locale => localizations[locale].attributes.description?.trim() && localizations[locale].attributes.supportUrl?.trim()),
      'New version localization metadata is incomplete');
    requireThat(REVIEW_CONTACT_FIELDS.every(key => review.attributes?.[key]?.trim())
      && typeof review.attributes?.demoAccountRequired === 'boolean', 'New version review contact information is incomplete');
    requireThat(!review.attributes.demoAccountRequired || (review.attributes.demoAccountName && review.attributes.demoAccountPassword),
      'New version review demo account is incomplete');
  }
  const attached = await versionRelationship(request, versionId, 'build', 'builds');
  if (attached) resourceId(attached, 'builds');
  return { target, versionId, buildId, localizations, review, attachedId: attached?.id ?? null, attachedBuild: attached?.attributes?.version };
}

/** ASC normally carries version media forward. Text-only initialization must
 * never turn missing screenshots/previews into a submission-ready result. */
async function assertReleaseMedia(request, version, snapshot) {
  if (version === '1.9.2') return; // Preserve the bounded legacy replacement operation.
  const previous = (await macVersions(request)).filter(v => v.attributes.appStoreState === 'READY_FOR_SALE'
    && /^\d+\.\d+\.\d+$/.test(v.attributes.versionString) && compareVersions(v.attributes.versionString, version) < 0);
  previous.sort((a, b) => compareVersions(b.attributes.versionString, a.attributes.versionString));
  requireThat(previous.length > 0, 'Released macOS media baseline is unavailable');
  const locales = (await collection(request, `/v1/appStoreVersions/${previous[0].id}/appStoreVersionLocalizations?limit=200`)).data;
  async function mediaCounts(localizationId, setType, assetType, displayField) {
    const response = await collection(request, `/v1/appStoreVersionLocalizations/${localizationId}/${setType}?include=${assetType}&limit=200`);
    const counts = new Map();
    for (const set of response.data) {
      resourceId(set, setType);
      const display = set.attributes?.[displayField];
      requireThat(typeof display === 'string', 'Media display type is unavailable');
      const related = set.relationships?.[assetType]?.data;
      requireThat(Array.isArray(related), 'Media relationships are incomplete');
      for (const relationship of related) {
        resourceId(relationship, assetType);
        const asset = exactlyOne(response.included.filter(a => a.type === assetType && a.id === relationship.id), 'version media asset');
        requireThat(asset.attributes?.assetDeliveryState?.state === 'COMPLETE', 'Version media asset is not ready');
      }
      counts.set(display, (counts.get(display) ?? 0) + related.length);
    }
    return counts;
  }
  let screenshots = 0;
  for (const locale of LOCALES) {
    const baseline = exactlyOne(locales.filter(l => l.attributes?.locale === locale), `released ${locale} media localization`);
    resourceId(baseline, 'appStoreVersionLocalizations');
    for (const [setType, assetType, displayField] of [
      ['appScreenshotSets', 'appScreenshots', 'screenshotDisplayType'],
      ['appPreviewSets', 'appPreviews', 'previewType'],
    ]) {
      const oldCounts = await mediaCounts(baseline.id, setType, assetType, displayField);
      const newCounts = await mediaCounts(snapshot.localizations[locale].id, setType, assetType, displayField);
      for (const [display, count] of oldCounts) {
        if (setType === 'appScreenshotSets') screenshots += count;
        requireThat((newCounts.get(display) ?? 0) >= count, `${locale} ${setType} were not inherited; restore media before release`);
      }
    }
  }
  requireThat(screenshots > 0, 'Released macOS screenshot baseline is empty');
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

/** Replace only an explicitly named pending submission after the uploaded
 * replacement, metadata and inherited media have already been verified. Apple
 * documents `canceled: true`; cancellation restarts the review queue on resubmit.
 * No cancellation or attachment is retried after an unknown response. */
async function replacePendingBuild({ request, version, build, previousBuild, submissionId, pause }) {
  requireThat(/^\d+$/.test(previousBuild ?? '') && Number(previousBuild) < Number(build),
    'Replacement requires an explicit older build number');
  requireThat(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(submissionId ?? ''),
    'Replacement requires the exact previous submission UUID');
  let snapshot = await releaseSnapshot(request, version, build);
  await assertReleaseMedia(request, version, snapshot);
  // Repeating preparation after a successful attachment must never cancel the
  // new submission. The normal prepare path validates its exact state and copy.
  if (snapshot.attachedId === snapshot.buildId) return;
  const inspect = async () => {
    const all = await collection(request, `/v1/apps/${APP_ID}/reviewSubmissions?filter[platform]=${PLATFORM}&limit=200`);
    const old = exactlyOne(all.data.filter(row => row.id === submissionId), 'explicit previous submission');
    resourceId(old, 'reviewSubmissions');
    requireThat(old.attributes?.platform === PLATFORM, 'Previous submission platform mismatch');
    const items = (await collection(request, `/v1/reviewSubmissions/${submissionId}/items?include=appStoreVersion&limit=200`)).data;
    assertTargetItem({ submission: old, items }, snapshot.versionId);
    const active = await activeSubmissions(request);
    requireThat(!active || active.submission.id === submissionId, 'Another submission became active; refusing replacement');
    snapshot = await releaseSnapshot(request, version, build);
    requireThat(snapshot.attachedBuild === previousBuild && snapshot.attachedId !== snapshot.buildId,
      'Previous build association changed; refusing replacement');
    return { old, active };
  };
  let { old, active } = await inspect();
  if (SUBMITTED.has(old.attributes.state)) {
    requireThat(active?.submission.id === submissionId && SUBMITTED.has(snapshot.target.attributes.appStoreState),
      'Previous version and submission must both still be in review');
    try {
      await request(`/v1/reviewSubmissions/${submissionId}`, 'PATCH', {
        data: { type: 'reviewSubmissions', id: submissionId, attributes: { canceled: true } },
      });
    } catch (error) {
      if (!error.outcomeUnknown) throw error;
      // Reconcile this same submission; never repeat cancellation in this run.
    }
  } else requireThat(['CANCELING', 'COMPLETE'].includes(old.attributes.state),
    'Previous submission is not submitted or canceling/complete');
  let ready = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    ({ old, active } = await inspect());
    if (old.attributes.state === 'COMPLETE' && !active
      && snapshot.target.attributes.appStoreState === 'DEVELOPER_REJECTED') {
      ready = true;
      break;
    }
    requireThat(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'CANCELING', 'COMPLETE'].includes(old.attributes.state),
      'Cancellation entered an unexpected state; inspect ASC');
    if (attempt < 5) await pause(2000);
  }
  requireThat(ready, 'Cancellation outcome not confirmed; read back before retrying the same replacement');
  await assertReleaseMedia(request, version, snapshot);
  ({ old, active } = await inspect());
  requireThat(old.attributes.state === 'COMPLETE' && !active
    && snapshot.target.attributes.appStoreState === 'DEVELOPER_REJECTED',
  'Replacement state changed before build attachment');
  try {
    await request(`/v1/appStoreVersions/${snapshot.versionId}/relationships/build`, 'PATCH', {
      data: { type: 'builds', id: snapshot.buildId },
    });
  } catch (error) {
    if (!error.outcomeUnknown) throw error;
  }
  snapshot = await releaseSnapshot(request, version, build);
  requireThat(snapshot.attachedId === snapshot.buildId && EDITABLE.has(snapshot.target.attributes.appStoreState),
    'Replacement build attachment is not confirmed; inspect ASC before retrying');
}

/** Supersede a pending review with a newer version number. ASC keeps one
 * unreleased macOS version per platform, so the canceled version record itself
 * is renumbered and given the new build in one PATCH; the normal prepare path
 * then writes the new copy. Resumable after either step; nothing is retried
 * after an unknown response. */
async function supersedePendingVersion({ request, version, build, previousVersion, previousBuild, submissionId, pause }) {
  validateVersion(previousVersion);
  requireThat(compareVersions(version, previousVersion) > 0, 'Superseding requires a newer version than the pending one');
  requireThat(/^\d+$/.test(previousBuild ?? '') && Number(previousBuild) < Number(build),
    'Superseding requires an explicit older build number');
  requireThat(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(submissionId ?? ''),
    'Superseding requires the exact previous submission UUID');
  const { buildId } = await releaseBuild(request, version, build);
  const inspect = async () => {
    const inFlight = (await macVersions(request)).filter(v => !TERMINAL.has(v.attributes.appStoreState));
    const row = exactlyOne(inFlight, 'unreleased macOS version');
    requireThat([previousVersion, version].includes(row.attributes.versionString),
      'The unreleased version is neither the pending nor the target version');
    const all = await collection(request, `/v1/apps/${APP_ID}/reviewSubmissions?filter[platform]=${PLATFORM}&limit=200`);
    const old = exactlyOne(all.data.filter(r => r.id === submissionId), 'explicit previous submission');
    resourceId(old, 'reviewSubmissions');
    requireThat(old.attributes?.platform === PLATFORM, 'Previous submission platform mismatch');
    const items = (await collection(request, `/v1/reviewSubmissions/${submissionId}/items?include=appStoreVersion&limit=200`)).data;
    assertTargetItem({ submission: old, items }, row.id);
    const active = await activeSubmissions(request);
    requireThat(!active || active.submission.id === submissionId, 'Another submission became active; refusing to supersede');
    const attached = await versionRelationship(request, row.id, 'build', 'builds');
    return { row, old, active, attached };
  };
  let { row, old, active, attached } = await inspect();
  if (row.attributes.versionString === version) {
    // Resumed after the renumbering: only the outcome is checked here.
    requireThat(old.attributes.state === 'COMPLETE' && !active && EDITABLE.has(row.attributes.appStoreState),
      'Renumbered version is not in the expected canceled, editable state');
    requireThat(attached?.id === buildId, 'Renumbered version does not carry the target build');
    return;
  }
  requireThat(attached?.attributes?.version === previousBuild, 'Previous build association changed; refusing to supersede');
  if (SUBMITTED.has(old.attributes.state)) {
    requireThat(active?.submission.id === submissionId && SUBMITTED.has(row.attributes.appStoreState),
      'Previous version and submission must both still be in review');
    try {
      await request(`/v1/reviewSubmissions/${submissionId}`, 'PATCH', {
        data: { type: 'reviewSubmissions', id: submissionId, attributes: { canceled: true } },
      });
    } catch (error) {
      if (!error.outcomeUnknown) throw error;
    }
  } else requireThat(['CANCELING', 'COMPLETE'].includes(old.attributes.state),
    'Previous submission is not submitted or canceling/complete');
  let ready = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    ({ row, old, active, attached } = await inspect());
    if (old.attributes.state === 'COMPLETE' && !active && row.attributes.appStoreState === 'DEVELOPER_REJECTED') {
      ready = true;
      break;
    }
    requireThat(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'CANCELING', 'COMPLETE'].includes(old.attributes.state),
      'Cancellation entered an unexpected state; inspect ASC');
    if (attempt < 5) await pause(2000);
  }
  requireThat(ready, 'Cancellation outcome not confirmed; read back before retrying the same supersede');
  requireThat(row.attributes.versionString === previousVersion && attached?.attributes?.version === previousBuild,
    'Pending version changed during cancellation; refusing to renumber');
  try {
    await request(`/v1/appStoreVersions/${row.id}`, 'PATCH', { data: {
      type: 'appStoreVersions', id: row.id, attributes: { versionString: version },
      relationships: { build: { data: { type: 'builds', id: buildId } } },
    } });
  } catch (error) {
    if (!error.outcomeUnknown) throw error;
  }
  ({ row, old, active, attached } = await inspect());
  requireThat(row.attributes.versionString === version && EDITABLE.has(row.attributes.appStoreState) && attached?.id === buildId,
    'Renumbering is not confirmed; inspect ASC before retrying');
}

/** Fixed app/platform operation; callers cannot supply endpoints, methods or bodies. */
export async function runRelease({ action, version, build, copy, request, provenance, previousBuild, previousSubmission, previousVersion, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  validateReleaseTarget(version, build);
  requireThat(['release-prepare', 'release-submit', 'release-replace-prepare', 'release-supersede-prepare'].includes(action), 'Unknown release operation');
  requireThat(copy?.notes && LOCALES.every(l => typeof copy.whatsNew?.[l] === 'string' && copy.whatsNew[l].length > 0), 'Incomplete repository copy');
  requireThat(provenance?.sourceSha && provenance?.runId && provenance?.artifactDigest, 'Verified upload provenance is required');
  const replacement = action === 'release-replace-prepare';
  const supersede = action === 'release-supersede-prepare';
  if (replacement) {
    await replacePendingBuild({ request, version, build, previousBuild, submissionId: previousSubmission, pause });
    action = 'release-prepare';
  }
  if (supersede) {
    await supersedePendingVersion({ request, version, build, previousVersion, previousBuild, submissionId: previousSubmission, pause });
    action = 'release-prepare';
  }
  if (action === 'release-prepare') await ensureReleaseVersion(request, version, build, copy);
  let snapshot = await releaseSnapshot(request, version, build);
  await assertReleaseMedia(request, version, snapshot);
  let active = await activeSubmissions(request);
  if (active) {
    assertTargetItem(active, snapshot.versionId);
    requireThat(active.submission.attributes.state === 'READY_FOR_REVIEW' || SUBMITTED.has(active.submission.attributes.state),
      'Active submission is not in a supported editable/submitted state');
  }
  const receipt = status => ({ appId: APP_ID, platform: PLATFORM, version, build, status,
    versionId: snapshot.versionId, buildId: snapshot.buildId, ...provenance,
    ...(replacement ? { previousBuild, previousSubmission } : {}),
    ...(supersede ? { previousVersion, previousBuild, previousSubmission } : {}),
    ...(active ? { submissionId: active.submission.id } : {}),
    metadataSha256: crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex') });
  if (active && SUBMITTED.has(active.submission.attributes.state)) {
    assertPrepared(snapshot, copy);
    requireThat(SUBMITTED.has(snapshot.target.attributes.appStoreState), 'Version and submission states disagree');
    return receipt('already-submitted');
  }
  if (action === 'release-prepare') {
    requireThat(EDITABLE.has(snapshot.target.attributes.appStoreState), 'App version is not editable for this release');
    requireThat(canAttach(version, snapshot.attachedId ? { id: snapshot.attachedId, attributes: { version: snapshot.attachedBuild } } : null, snapshot.buildId),
      'Prepare may attach only an empty draft, the exact build, or legacy 1.9.2 build 9201');
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
          const current = await versionRelationship(request, snapshot.versionId, 'build', 'builds');
          requireThat(canAttach(version, current, snapshot.buildId),
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
  await assertReleaseMedia(request, version, snapshot);
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
  const [cmd, arg, build, runId, previousBuild, previousSubmission, previousVersion] = args;
  if (['release-prepare', 'release-submit', 'release-replace-prepare', 'release-supersede-prepare'].includes(cmd)) validateReleaseTarget(arg, build);
  else requireThat(['list', 'revoke', 'store-status'].includes(cmd),
    'usage: asc-certificates.mjs (list | store-status | revoke <ids> | release-prepare <version> <build> | release-submit <version> <build> | release-replace-prepare <version> <build> <run> <previous-build> <previous-submission> | release-supersede-prepare <version> <build> <run> <previous-build> <previous-submission> <previous-version>)');
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
    const provenance = await verifyReleaseProvenance({ version: arg, build, runId, sourceSha: process.env.GITHUB_SHA, request: githubClient() });
    const root = fileURLToPath(new URL('..', import.meta.url));
    const copy = extractReleaseCopy(
      fs.readFileSync(resolve(root, 'docs/appstore-metadata-draft.md'), 'utf8'),
      fs.readFileSync(resolve(root, 'apple/APP_REVIEW_NOTES.md'), 'utf8'), arg);
    console.log(JSON.stringify(await runRelease({ action: cmd, version: arg, build, copy, request: api, provenance, previousBuild, previousSubmission, previousVersion })));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
