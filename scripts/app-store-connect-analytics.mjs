#!/usr/bin/env node
// Download Apple's privacy-thresholded App Store analytics reports without
// embedding an analytics SDK in AgentDeck.
//
//   node scripts/app-store-connect-analytics.mjs status
//   node scripts/app-store-connect-analytics.mjs init
//   node scripts/app-store-connect-analytics.mjs fetch --days 30
//
// `init` is the only mutating command: it creates an ONGOING report request.
// Apple normally needs 1–2 days before that request produces its first data.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'reports', 'app-store-connect');
const APP_ID = process.env.ASC_APP_ID || '6784822497';

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`usage: app-store-connect-analytics.mjs <command> [options]

commands:
  status                    list existing analytics report requests
  init                      create one ONGOING analytics report request
  fetch [options]           download standard App Usage report segments

fetch options:
  --days <n>                processing dates to include (default: 30)
  --request <id>            use a specific report-request id
  --report <text>           report-name filter (repeatable)
  --output <directory>      destination (default: reports/app-store-connect)

credentials:
  ASC_KEY_ID or ASC_API_KEY_ID
  ASC_ISSUER_ID
  ASC_KEY_PATH, ASC_KEY_BASE64, or ASC_API_KEY_BASE64
  ASC_APP_ID                optional; defaults to AgentDeck's 6784822497`);
  process.exit(exitCode);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') usage();
  const options = { days: 30, reports: [], output: DEFAULT_OUTPUT, request: null };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--days' && value) {
      options.days = Number.parseInt(value, 10);
      i += 1;
    } else if (flag === '--request' && value) {
      options.request = value;
      i += 1;
    } else if (flag === '--report' && value) {
      options.reports.push(value.toLowerCase());
      i += 1;
    } else if (flag === '--output' && value) {
      options.output = path.resolve(value);
      i += 1;
    } else {
      console.error(`Unknown or incomplete option: ${flag}`);
      usage(2);
    }
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 3660) {
    throw new Error('--days must be an integer from 1 to 3660');
  }
  return { command, options };
}

const { command, options } = parseArguments(process.argv.slice(2));

const keyID = process.env.ASC_KEY_ID || process.env.ASC_API_KEY_ID;
const issuerID = process.env.ASC_ISSUER_ID;
const keyBase64 = process.env.ASC_KEY_BASE64 || process.env.ASC_API_KEY_BASE64;
const keyPEM = keyBase64
  ? Buffer.from(keyBase64, 'base64').toString('utf8')
  : process.env.ASC_KEY_PATH
    ? fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8')
    : null;

if (!keyID || !issuerID || !keyPEM) {
  throw new Error('Missing ASC key credentials; run with --help for the accepted environment variables.');
}

const b64url = (value) => Buffer.from(value).toString('base64url');

function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: issuerID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: crypto.createPrivateKey(keyPEM),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${b64url(signature)}`;
}

async function api(target, { method = 'GET', body } = {}) {
  const url = target.startsWith('http') ? target : `https://api.appstoreconnect.apple.com${target}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${method} ${url} -> ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

async function allPages(initialPath) {
  const data = [];
  let next = initialPath;
  while (next) {
    const page = await api(next);
    data.push(...(page.data || []));
    next = page.links?.next || null;
  }
  return data;
}

async function reportRequests() {
  return allPages(`/v1/apps/${APP_ID}/analyticsReportRequests?limit=200`);
}

function isUsableRequest(request) {
  const attributes = request.attributes || {};
  return attributes.accessType === 'ONGOING' && attributes.stoppedDueToInactivity !== true;
}

async function status() {
  const requests = await reportRequests();
  if (!requests.length) {
    console.log(`No analytics report request exists for app ${APP_ID}. Run the init command once.`);
    return;
  }
  console.table(
    requests.map((request) => ({
      id: request.id,
      accessType: request.attributes?.accessType,
      stoppedDueToInactivity: request.attributes?.stoppedDueToInactivity || false,
    })),
  );
}

async function init() {
  const existing = (await reportRequests()).find(isUsableRequest);
  if (existing) {
    console.log(`An active ONGOING request already exists: ${existing.id}`);
    return existing;
  }
  const response = await api('/v1/analyticsReportRequests', {
    method: 'POST',
    body: {
      data: {
        type: 'analyticsReportRequests',
        attributes: { accessType: 'ONGOING' },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    },
  });
  console.log(`Created ONGOING analytics request ${response.data.id}.`);
  console.log('Apple normally produces the first reports in 1–2 days.');
  return response.data;
}

function wantedReport(report) {
  const name = report.attributes?.name || '';
  const category = report.attributes?.category;
  if (category !== 'APP_USAGE' || /detailed/i.test(name)) return false;
  if (options.reports.length) {
    return options.reports.some((needle) => name.toLowerCase().includes(needle));
  }
  return /app sessions|installations and deletions|app store opt-?in/i.test(name);
}

function safeName(value) {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function verifyChecksum(buffer, checksum) {
  if (!checksum) return;
  const normalized = checksum.toLowerCase().replace(/^(sha256|md5):/, '');
  const algorithm = normalized.length === 64 ? 'sha256' : normalized.length === 32 ? 'md5' : null;
  if (!algorithm) return;
  const actual = crypto.createHash(algorithm).update(buffer).digest('hex');
  if (actual !== normalized) throw new Error(`checksum mismatch: expected ${checksum}, got ${actual}`);
}

async function downloadSegment(segment, destination) {
  const url = segment.attributes?.url;
  if (!url) throw new Error(`Segment ${segment.id} has no download URL`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET segment ${segment.id} -> ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  verifyChecksum(buffer, segment.attributes?.checksum);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
  return buffer.length;
}

async function fetchReports() {
  const requests = await reportRequests();
  const request = options.request
    ? requests.find((candidate) => candidate.id === options.request)
    : requests.find(isUsableRequest);
  if (!request) {
    throw new Error('No usable analytics request found. Run the init command once, then retry in 1–2 days.');
  }

  const reports = (await allPages(`/v1/analyticsReportRequests/${request.id}/reports?limit=200`)).filter(wantedReport);
  if (!reports.length) {
    console.log('No matching standard App Usage reports are available yet.');
    return;
  }

  const cutoff = new Date(Date.now() - (options.days - 1) * 24 * 60 * 60 * 1000);
  cutoff.setUTCHours(0, 0, 0, 0);
  const manifest = {
    appID: APP_ID,
    requestID: request.id,
    fetchedAt: new Date().toISOString(),
    days: options.days,
    files: [],
  };

  for (const report of reports) {
    const params = new URLSearchParams({ 'filter[granularity]': 'DAILY', limit: '200' });
    const instances = await allPages(`/v1/analyticsReports/${report.id}/instances?${params.toString()}`);
    const recent = instances.filter((instance) => {
      const processingDate = instance.attributes?.processingDate;
      return processingDate && new Date(`${processingDate}T00:00:00Z`) >= cutoff;
    });

    for (const instance of recent) {
      const segments = await allPages(`/v1/analyticsReportInstances/${instance.id}/segments?limit=200`);
      for (const segment of segments) {
        const basename = [
          safeName(report.attributes.name),
          instance.attributes.processingDate,
          safeName(instance.id),
          safeName(segment.id),
        ].join('__');
        const destination = path.join(options.output, `${basename}.csv.gz`);
        const bytes = await downloadSegment(segment, destination);
        manifest.files.push({
          report: report.attributes.name,
          category: report.attributes.category,
          processingDate: instance.attributes.processingDate,
          granularity: instance.attributes.granularity,
          segmentID: segment.id,
          bytes,
          file: path.relative(options.output, destination),
        });
        console.log(`${report.attributes.name}: ${path.basename(destination)} (${bytes} bytes)`);
      }
    }
  }

  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(path.join(options.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Downloaded ${manifest.files.length} segment(s) to ${options.output}`);
}

if (command === 'status') await status();
else if (command === 'init') await init();
else if (command === 'fetch') await fetchReports();
else usage(2);
