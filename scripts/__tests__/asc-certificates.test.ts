import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
// @ts-expect-error — release script is native ESM
import { createASCClient, extractReleaseCopy, runRelease, validateReleaseTarget, verifyReleaseProvenance } from '../asc-certificates.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const copy = {
  whatsNew: { 'en-US': 'English update', ko: '한국어 업데이트', ja: '日本語の更新' },
  notes: 'Synthetic reviewer notes',
};
const provenance = { sourceSha: 'a'.repeat(40), runId: '40313393201', artifactId: 123, artifactDigest: `sha256:${'b'.repeat(64)}` };
const clone = <T>(v: T): T => structuredClone(v);
const unknownOutcome = () => Object.assign(new Error('lost response'), { outcomeUnknown: true });
type Resource = { type: string; id: string; attributes: Record<string, any>; relationships?: Record<string, any> };

/** Mutable ASC fixture, not a sequence of canned returns: later GETs must see
 * exactly the resources/relationships created by earlier mutation requests. */
function fixture(prepared = false, fresh = false) {
  const version: Resource = { type: 'appStoreVersions', id: 'version-mac', attributes: {
    platform: 'MAC_OS', versionString: fresh ? '1.9.3' : '1.9.2', appStoreState: fresh ? 'PREPARE_FOR_SUBMISSION' : 'DEVELOPER_REJECTED', releaseType: prepared ? 'AFTER_APPROVAL' : 'MANUAL',
  } };
  const build: Resource = { type: 'builds', id: fresh ? 'build-9501' : 'build-9301', attributes: { version: fresh ? '9501' : '9301', processingState: 'VALID', expired: false },
    relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'pre-mac' } } } };
  const pre: Resource = { type: 'preReleaseVersions', id: 'pre-mac', attributes: { version: fresh ? '1.9.3' : '1.9.2', platform: 'MAC_OS' } };
  const localizations = (fresh ? [] : Object.entries(copy.whatsNew)).map(([locale, text]) => ({
    type: 'appStoreVersionLocalizations', id: `locale-${locale}`, attributes: { locale, whatsNew: prepared ? text : 'previous copy' },
  }));
  const review: Resource = { type: 'appStoreReviewDetails', id: 'review-mac', attributes: { notes: prepared ? copy.notes : 'previous notes' } };
  const previous: Resource = { type: 'appStoreVersions', id: 'version-public', attributes: {
    platform: 'MAC_OS', versionString: '1.9.2', appStoreState: 'READY_FOR_SALE', copyright: '2026 Example',
  } };
  const previousLocales: Resource[] = Object.keys(copy.whatsNew).map(locale => ({ type: 'appStoreVersionLocalizations', id: `public-${locale}`,
    attributes: { locale, description: `Released ${locale} description`, keywords: 'agents', supportUrl: 'https://example.com/support', whatsNew: 'Old release text', ignoredServerField: true } }));
  const previousReview: Resource = { type: 'appStoreReviewDetails', id: 'review-public', attributes: {
    contactFirstName: 'Synthetic', contactLastName: 'Reviewer', contactEmail: 'test@example.com', contactPhone: '+1 555 0100',
    demoAccountRequired: false, notes: 'Old release notes', ignoredServerField: true,
  } };
  const state = {
    version, build, pre, localizations, review: fresh ? null : review as Resource | null,
    versions: fresh ? [previous] : [version], previous, previousLocales, previousReview,
    attached: fresh ? null : prepared ? build : { type: 'builds', id: 'build-9201', attributes: { version: '9201' } } as Resource,
    submissions: [] as Resource[], items: [] as Resource[],
    calls: [] as Array<{ path: string; method: string; body?: any }>,
    loseResponse: '' as string, reject: '' as string, driftAfterLocale: false, driftAfterItem: false, mediaMissing: false, mediaIncomplete: false, dropMediaAfterItem: false,
  };
  async function request(path: string, method = 'GET', body?: any) {
    state.calls.push({ path, method, body: clone(body) });
    if (state.reject === `${method} ${path}`) throw new Error('ASC request failed (HTTP 403)');
    const url = new URL(path, 'https://api.appstoreconnect.apple.com');
    const p = url.pathname;
    let result: any;
    if (method === 'GET') {
      if (p === '/v1/apps/6784822497/appStoreVersions') result = { data: state.versions.filter(v => !url.searchParams.get('filter[versionString]') || v.attributes.versionString === url.searchParams.get('filter[versionString]')) };
      else if (p === '/v1/builds') result = { data: [build], included: [pre] };
      else if (p === '/v1/appStoreVersions/version-mac/appStoreVersionLocalizations') result = { data: localizations };
      else if (p === '/v1/appStoreVersions/version-mac/relationships/appStoreReviewDetail') result = { data: state.review && { type: state.review.type, id: state.review.id } };
      else if (p === '/v1/appStoreVersions/version-public/relationships/appStoreReviewDetail') result = { data: { type: state.previousReview.type, id: state.previousReview.id } };
      else if (p === '/v1/appStoreVersions/version-mac/relationships/build') result = { data: state.attached && { type: state.attached.type, id: state.attached.id } };
      else if (p === '/v1/appStoreVersions/version-mac/appStoreReviewDetail') result = { data: state.review };
      else if (p === '/v1/appStoreVersions/version-public/appStoreVersionLocalizations') result = { data: state.previousLocales };
      else if (p === '/v1/appStoreVersions/version-public/appStoreReviewDetail') result = { data: state.previousReview };
      else if (p === '/v1/appStoreVersions/version-mac/build') result = { data: state.attached };
      else if (p.endsWith('/appScreenshotSets')) {
        const target = !p.includes('/public-');
        result = target && state.mediaMissing ? { data: [], included: [] } : { data: [{ type: 'appScreenshotSets', id: 'screenshots-mac',
          attributes: { screenshotDisplayType: 'APP_DESKTOP' }, relationships: { appScreenshots: { data: [{ type: 'appScreenshots', id: 'shot-mac' }] } } }],
          included: [{ type: 'appScreenshots', id: 'shot-mac', attributes: { assetDeliveryState: { state: target && state.mediaIncomplete ? 'UPLOAD_COMPLETE' : 'COMPLETE' } } }] };
      }
      else if (p.endsWith('/appPreviewSets')) result = { data: [], included: [] };
      else if (p === '/v1/apps/6784822497/reviewSubmissions') result = { data: state.submissions };
      else if (/^\/v1\/reviewSubmissions\/[\w-]+\/items$/.test(p)) result = { data: state.items.filter(i => i.relationships?.reviewSubmission.data.id === p.split('/')[3]) };
    } else if (method === 'PATCH') {
      if (p.startsWith('/v1/appStoreVersionLocalizations/')) {
        Object.assign(localizations.find(l => l.id === body.data.id)!.attributes, body.data.attributes);
        if (state.driftAfterLocale) state.attached = { type: 'builds', id: 'build-9401', attributes: { version: '9401' } };
      } else if (p === '/v1/appStoreReviewDetails/review-mac') Object.assign(state.review!.attributes, body.data.attributes);
      else if (p === '/v1/appStoreVersions/version-mac') Object.assign(version.attributes, body.data.attributes);
      else if (p === '/v1/appStoreVersions/version-mac/relationships/build') {
        expect(body).toEqual({ data: { type: 'builds', id: build.id } });
        state.attached = build;
      } else if (p === '/v1/reviewSubmissions/submission-new') {
        expect(body).toEqual({ data: { type: 'reviewSubmissions', id: 'submission-new', attributes: { submitted: true } } });
        state.submissions[0]!.attributes.state = 'WAITING_FOR_REVIEW';
        version.attributes.appStoreState = 'WAITING_FOR_REVIEW';
      } else throw new Error(`Unexpected PATCH ${p}`);
      result = { data: { ...body.data } };
    } else if (method === 'POST' && p === '/v1/appStoreVersions') {
      expect(body.data.attributes).toEqual({ platform: 'MAC_OS', versionString: '1.9.3', releaseType: 'AFTER_APPROVAL', copyright: '2026 Example' });
      expect(body.data.relationships).toEqual({ app: { data: { type: 'apps', id: '6784822497' } } });
      Object.assign(version.attributes, body.data.attributes);
      state.versions.push(version);
      result = { data: version };
    } else if (method === 'POST' && p === '/v1/appStoreVersionLocalizations') {
      expect(body.data.relationships).toEqual({ appStoreVersion: { data: { type: 'appStoreVersions', id: 'version-mac' } } });
      expect(body.data.attributes).not.toHaveProperty('ignoredServerField');
      const row = { ...body.data, id: `locale-${body.data.attributes.locale}` };
      state.localizations.push(row);
      result = { data: row };
    } else if (method === 'POST' && p === '/v1/appStoreReviewDetails') {
      expect(body.data.relationships).toEqual({ appStoreVersion: { data: { type: 'appStoreVersions', id: 'version-mac' } } });
      expect(body.data.attributes).not.toHaveProperty('ignoredServerField');
      state.review = { ...body.data, id: 'review-mac' };
      result = { data: state.review };
    } else if (method === 'POST' && p === '/v1/reviewSubmissions') {
      expect(body).toEqual({ data: { type: 'reviewSubmissions', attributes: { platform: 'MAC_OS' }, relationships: { app: { data: { type: 'apps', id: '6784822497' } } } } });
      const submission = { type: 'reviewSubmissions', id: 'submission-new', attributes: { platform: 'MAC_OS', state: 'READY_FOR_REVIEW' } };
      state.submissions.push(submission);
      result = { data: submission };
    } else if (method === 'POST' && p === '/v1/reviewSubmissionItems') {
      expect(body).toEqual({ data: { type: 'reviewSubmissionItems', relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: 'submission-new' } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: 'version-mac' } },
      } } });
      const item = { ...body.data, id: 'item-new', attributes: { state: 'READY_FOR_REVIEW' } };
      state.items.push(item);
      version.attributes.appStoreState = 'READY_FOR_REVIEW';
      if (state.driftAfterItem) review.attributes.notes = 'changed by another session';
      if (state.dropMediaAfterItem) state.mediaMissing = true;
      result = { data: item };
    }
    if (!result) throw new Error(`Unexpected ${method} ${p}`);
    if (state.loseResponse === `${method} ${p}`) { state.loseResponse = ''; throw unknownOutcome(); }
    return clone(result);
  }
  return { ...state, state, request,
    run: (action = 'release-submit') => runRelease({ action, version: fresh ? '1.9.3' : '1.9.2', build: fresh ? '9501' : '9301', copy, request, provenance, pause: async () => {} }),
    writes: () => state.calls.filter(c => c.method !== 'GET'),
  };
}

describe('bounded macOS ASC release', () => {
  it('extracts only current macOS EN/KO/JA and the marked macOS reviewer field', () => {
    const extracted = extractReleaseCopy(readFileSync(resolve(ROOT, 'docs/appstore-metadata-draft.md'), 'utf8'),
      readFileSync(resolve(ROOT, 'apple/APP_REVIEW_NOTES.md'), 'utf8'), '1.9.3');
    expect(Object.keys(extracted.whatsNew)).toEqual(['en-US', 'ko', 'ja']);
    expect(extracted.notes).toContain('NEW IN 1.9.3 — MACOS ONLY');
    expect(extracted.notes).not.toContain('<!--');
    for (const text of [...Object.values(extracted.whatsNew), extracted.notes] as string[]) expect(text.length).toBeLessThanOrEqual(4000);
    expect(() => extractReleaseCopy('## Prepared macOS 1.9.2 update text', '', '1.9.2')).toThrow();
  });

  it.each([['1.9.1', '9301'], ['1.9.2', '9201'], ['1.9.2', '0'], ['1.9.2', '9301; echo secret']])('rejects target %s/%s before API calls', (version, build) => {
    expect(() => validateReleaseTarget(version, build)).toThrow();
  });

  it('creates a new macOS version with allow-listed released metadata and current copy, then submits idempotently', async () => {
    const f = fixture(false, true);
    expect(await f.run('release-prepare')).toMatchObject({ status: 'prepared', version: '1.9.3', build: '9501', ...provenance });
    expect(f.state.localizations).toHaveLength(3);
    for (const locale of f.state.localizations) {
      expect(locale.attributes.description).toContain('Released');
      expect(locale.attributes.whatsNew).toBe(copy.whatsNew[locale.attributes.locale as keyof typeof copy.whatsNew]);
    }
    expect(f.state.review!.attributes).toMatchObject({ contactEmail: 'test@example.com', notes: copy.notes });
    expect(f.state.attached!.id).toBe('build-9501');
    const before = f.writes().length;
    await f.run('release-prepare');
    expect(f.writes()).toHaveLength(before);
    expect(await f.run()).toMatchObject({ status: 'submitted' });
    const submitted = f.writes().length;
    expect(await f.run()).toMatchObject({ status: 'already-submitted' });
    expect(f.writes()).toHaveLength(submitted);
  });

  it.each(['build', 'newer', 'active', 'contact', 'locale', 'copyright'])('refuses unsafe new-version %s before any mutation', async reason => {
    const f = fixture(false, true);
    if (reason === 'build') f.build.attributes.processingState = 'PROCESSING';
    if (reason === 'newer') f.state.previous.attributes.versionString = '1.9.4';
    if (reason === 'active') f.state.previous.attributes.appStoreState = 'WAITING_FOR_REVIEW';
    if (reason === 'contact') delete f.state.previousReview.attributes.contactEmail;
    if (reason === 'locale') f.state.previousLocales.pop();
    if (reason === 'copyright') delete f.state.previous.attributes.copyright;
    await expect(f.run('release-prepare')).rejects.toThrow();
    expect(f.writes()).toHaveLength(0);
  });

  it.each(['/v1/appStoreVersions', '/v1/appStoreVersionLocalizations', '/v1/appStoreReviewDetails'])('does not duplicate creation after a lost response at %s', async path => {
    const f = fixture(false, true); f.state.loseResponse = `POST ${path}`;
    await expect(f.run('release-prepare')).rejects.toThrow(/lost response/);
    expect(await f.run('release-prepare')).toMatchObject({ status: 'prepared' });
    expect(f.writes().filter(c => c.path === '/v1/appStoreVersions')).toHaveLength(1);
    expect(f.writes().filter(c => c.path === '/v1/appStoreVersionLocalizations')).toHaveLength(3);
    expect(f.writes().filter(c => c.path === '/v1/appStoreReviewDetails')).toHaveLength(1);
  });

  it('fills only missing required fields in a partially inherited draft without replacing existing text', async () => {
    const f = fixture(false, true);
    f.state.versions.push(f.version);
    for (const previous of f.state.previousLocales) f.state.localizations.push({
      type: previous.type, id: `locale-${previous.attributes.locale}`, attributes: { locale: previous.attributes.locale, description: 'Keep draft description' },
    });
    f.state.review = { type: 'appStoreReviewDetails', id: 'review-mac', attributes: { contactEmail: 'keep@example.com' } };
    expect(await f.run('release-prepare')).toMatchObject({ status: 'prepared' });
    expect(f.state.localizations.every(l => l.attributes.description === 'Keep draft description')).toBe(true);
    expect(f.state.review.attributes.contactEmail).toBe('keep@example.com');
    expect(f.state.review.attributes.contactFirstName).toBe('Synthetic');
    expect(f.writes().filter(c => c.method === 'POST')).toHaveLength(0);
  });

  it.each(['missing', 'incomplete'])('does not call a new version prepared when inherited media are %s', async reason => {
    const f = fixture(false, true);
    if (reason === 'missing') f.state.mediaMissing = true;
    else f.state.mediaIncomplete = true;
    await expect(f.run('release-prepare')).rejects.toThrow(/media|appScreenshotSets/);
    expect(f.writes().some(c => c.path.endsWith('/relationships/build'))).toBe(false);
  });

  it('rechecks inherited media after creating the review item before submit', async () => {
    const f = fixture(false, true);
    await f.run('release-prepare');
    f.state.dropMediaAfterItem = true;
    await expect(f.run()).rejects.toThrow(/not inherited/);
    expect(f.writes().some(c => c.path === '/v1/reviewSubmissions/submission-new')).toBe(false);
  });

  it('does not interpret an unreadable build linkage as an empty draft', async () => {
    const f = fixture(false, true);
    f.state.versions.push(f.version);
    await expect(runRelease({ action: 'release-prepare', version: '1.9.3', build: '9501', copy, provenance,
      request: async (path: string, method?: string, body?: unknown) => path.endsWith('/relationships/build')
        ? {} : f.request(path, method, body) })).rejects.toThrow(/relationship is unreadable/);
    expect(f.writes()).toHaveLength(0);
  });

  it('does not allow legacy 9201 replacement for a new version', async () => {
    const f = fixture(false, true);
    f.state.versions.push(f.version);
    f.state.attached = { type: 'builds', id: 'build-9201', attributes: { version: '9201' } };
    await expect(f.run('release-prepare')).rejects.toThrow(/unrelated candidate/);
    expect(f.writes()).toHaveLength(0);
  });

  it('prepares only approved fields and exact build, then performs no writes on repeat', async () => {
    const f = fixture();
    expect(await f.run('release-prepare')).toMatchObject({ status: 'prepared', platform: 'MAC_OS', build: '9301' });
    expect(f.writes()).toHaveLength(6);
    expect(f.writes().every(c => c.method === 'PATCH')).toBe(true);
    const before = f.writes().length;
    await f.run('release-prepare');
    expect(f.writes()).toHaveLength(before);
    expect(f.state.submissions).toHaveLength(0);
  });

  it.each(['processing', 'expired', 'platform', 'version', 'locale', 'attached'])('refuses unsafe %s before prepare mutation', async reason => {
    const f = fixture();
    if (reason === 'processing') f.build.attributes.processingState = 'PROCESSING';
    if (reason === 'expired') f.build.attributes.expired = true;
    if (reason === 'platform') f.pre.attributes.platform = 'IOS';
    if (reason === 'version') f.pre.attributes.version = '1.9.3';
    if (reason === 'locale') f.state.localizations.pop();
    if (reason === 'attached') f.state.attached = { type: 'builds', id: 'another-build', attributes: { version: '9401' } };
    await expect(f.run('release-prepare')).rejects.toThrow();
    expect(f.writes()).toHaveLength(0);
  });

  it('does not replace a different candidate attached during preparation', async () => {
    const f = fixture(); f.state.driftAfterLocale = true;
    await expect(f.run('release-prepare')).rejects.toThrow(/changed during/);
    expect(f.writes().some(c => c.path.endsWith('/relationships/build'))).toBe(false);
  });

  it('refuses submit until exact metadata/build/release-type readback matches', async () => {
    const f = fixture();
    await expect(f.run()).rejects.toThrow();
    expect(f.writes()).toHaveLength(0);
  });

  it('creates the exact version item, submits, and recognizes a repeat without mutations', async () => {
    const f = fixture(true);
    expect(await f.run()).toMatchObject({ status: 'submitted', submissionId: 'submission-new' });
    expect(f.writes().map(c => [c.method, c.path])).toEqual([
      ['POST', '/v1/reviewSubmissions'], ['POST', '/v1/reviewSubmissionItems'], ['PATCH', '/v1/reviewSubmissions/submission-new'],
    ]);
    const writes = f.writes().length;
    expect(await f.run()).toMatchObject({ status: 'already-submitted' });
    expect(f.writes()).toHaveLength(writes);
  });

  it('resumes only an exact ready draft without creating another submission or item', async () => {
    const f = fixture(true);
    f.state.reject = 'PATCH /v1/reviewSubmissions/submission-new';
    await expect(f.run()).rejects.toThrow(/403/);
    expect(f.version.attributes.appStoreState).toBe('READY_FOR_REVIEW');
    f.state.reject = '';
    expect(await f.run()).toMatchObject({ status: 'submitted' });
    expect(f.writes().filter(c => c.method === 'POST')).toHaveLength(2);
  });

  it('refuses metadata drift at the final readback before submitting', async () => {
    const f = fixture(true); f.state.driftAfterItem = true;
    await expect(f.run()).rejects.toThrow(/Review notes readback/);
    expect(f.writes().some(c => c.method === 'PATCH')).toBe(false);
  });

  it.each(['empty', 'foreign', 'multiple', 'canceling'])('refuses existing %s drafts without changing or canceling them', async kind => {
    const f = fixture(true);
    f.state.submissions.push({ type: 'reviewSubmissions', id: 'submission-existing', attributes: { platform: 'MAC_OS', state: kind === 'canceling' ? 'CANCELING' : 'READY_FOR_REVIEW' } });
    if (kind !== 'empty') f.state.items.push({ type: 'reviewSubmissionItems', id: 'item-existing', attributes: { state: 'READY_FOR_REVIEW' }, relationships: {
      reviewSubmission: { data: { type: 'reviewSubmissions', id: 'submission-existing' } },
      appStoreVersion: { data: { type: 'appStoreVersions', id: kind === 'foreign' ? 'another-version' : 'version-mac' } },
    } });
    if (kind === 'multiple') f.state.submissions.push({ type: 'reviewSubmissions', id: 'other-draft', attributes: { platform: 'MAC_OS', state: 'READY_FOR_REVIEW' } });
    await expect(f.run()).rejects.toThrow();
    expect(f.writes()).toHaveLength(0);
  });

  it('does not repeat draft creation after an unknown POST outcome, even on another invocation', async () => {
    const f = fixture(true); f.state.loseResponse = 'POST /v1/reviewSubmissions';
    await expect(f.run()).rejects.toThrow(/creation outcome unknown/);
    await expect(f.run()).rejects.toThrow(/review item/);
    expect(f.writes()).toHaveLength(1);
  });

  it.each(['/v1/reviewSubmissionItems', '/v1/reviewSubmissions/submission-new'])('reconciles a lost response at %s without repeating its mutation', async path => {
    const f = fixture(true); f.state.loseResponse = `${path.includes('Items') ? 'POST' : 'PATCH'} ${path}`;
    expect(await f.run()).toMatchObject({ status: 'submitted' });
    expect(f.writes().filter(c => c.path === path)).toHaveLength(1);
  });

  it('stops on permission denial without swallowing it or trying another write', async () => {
    const f = fixture(true); f.state.reject = 'POST /v1/reviewSubmissions';
    await expect(f.run()).rejects.toThrow(/403/);
    expect(f.writes()).toHaveLength(1);
  });

  it('never follows pagination to another host or collection', async () => {
    const f = fixture(true);
    await expect(runRelease({ action: 'release-submit', version: '1.9.2', build: '9301', copy, provenance,
      request: async () => ({ data: [], links: { next: 'https://other.example/v1/apps' } }) })).rejects.toThrow(/pagination/);
    expect(f.writes()).toHaveLength(0);
  });

  it('bounds HTTP calls and never includes a private response body in errors', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const request = createASCClient({ ASC_KEY_ID: 'test', ASC_ISSUER_ID: 'issuer', ASC_KEY_BASE64: Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64') },
      async (url: string, options: RequestInit) => {
        expect(url).toBe('https://api.appstoreconnect.apple.com/v1/reviewSubmissions');
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect((options.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
        return new Response('private reviewer email and payload', { status: 403 });
      });
    await expect(request('/v1/reviewSubmissions', 'POST', {})).rejects.toThrow('ASC POST failed (HTTP 403)');
    await expect(request('https://other.example')).rejects.toThrow(/resource path/);
  });

  it('passes workflow inputs only as environment-backed quoted arguments and serializes dispatches', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/asc-certificates.yml'), 'utf8');
    const run = workflow.split('        run: |')[1]!;
    expect(run).not.toContain('${{ inputs.');
    expect(run).toContain('"$ASC_RELEASE_VERSION" "$ASC_RELEASE_BUILD"');
    expect(workflow).toContain('cancel-in-progress: false');
  });
});

function uploadFixture() {
  const run = { id: 40313393201, repository: { full_name: 'puritysb/AgentDeck' }, path: '.github/workflows/apple-release.yml',
    head_sha: provenance.sourceSha, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', run_number: 95, run_attempt: 1 };
  const job = { status: 'completed', conclusion: 'success', steps: [
    'Verify App Store invariants (exported pkg)', 'Retain verified macOS candidate', 'Upload macOS to App Store Connect',
  ].map(name => ({ name, status: 'completed', conclusion: 'success' })) };
  const artifact = { id: 123, name: 'apple-macos-1.9.3-95-1', expired: false, size_in_bytes: 1000,
    digest: provenance.artifactDigest, workflow_run: { id: run.id, head_sha: run.head_sha } };
  const jobs = { total_count: 1, jobs: [job] }, artifacts = { total_count: 1, artifacts: [artifact] };
  const paths: string[] = [];
  return { run, job, artifact, jobs, artifacts, paths, verify: () => verifyReleaseProvenance({ version: '1.9.3', build: '9501',
    runId: provenance.runId, sourceSha: provenance.sourceSha, request: async (path: string) => {
      paths.push(path);
      if (path.endsWith('/jobs?per_page=100')) return clone(jobs);
      if (path.endsWith('/artifacts?per_page=100')) return clone(artifacts);
      return clone(run);
    } }) };
}

describe('uploaded macOS candidate provenance', () => {
  it('accepts only the source, version, build and successful upload artifact from the exact CI run attempt', async () => {
    const f = uploadFixture();
    expect(await f.verify()).toEqual(provenance);
    expect(f.paths).toContain(`/repos/puritysb/AgentDeck/actions/runs/${provenance.runId}/attempts/1/jobs?per_page=100`);
  });

  it.each(['source', 'repository', 'workflow', 'run', 'build', 'skipped-upload', 'unverified', 'artifact-version', 'artifact-source', 'expired', 'digest', 'incomplete-jobs', 'incomplete-artifacts'])('refuses invalid %s provenance', async reason => {
    const f = uploadFixture();
    if (reason === 'source') f.run.head_sha = 'c'.repeat(40);
    if (reason === 'repository') f.run.repository.full_name = 'other/AgentDeck';
    if (reason === 'workflow') f.run.path = '.github/workflows/other.yml';
    if (reason === 'run') f.run.status = 'in_progress';
    if (reason === 'build') f.run.run_attempt = 2;
    if (reason === 'skipped-upload') f.job.steps[2]!.conclusion = 'skipped';
    if (reason === 'unverified') f.job.steps[0]!.conclusion = 'failure';
    if (reason === 'artifact-version') f.artifact.name = 'apple-macos-1.9.2-95-1';
    if (reason === 'artifact-source') f.artifact.workflow_run.head_sha = 'c'.repeat(40);
    if (reason === 'expired') f.artifact.expired = true;
    if (reason === 'digest') f.artifact.digest = '';
    if (reason === 'incomplete-jobs') f.jobs.total_count = 2;
    if (reason === 'incomplete-artifacts') f.artifacts.total_count = 2;
    await expect(f.verify()).rejects.toThrow();
  });
});
