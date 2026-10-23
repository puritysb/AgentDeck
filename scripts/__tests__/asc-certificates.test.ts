import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
// @ts-expect-error — release script is native ESM
import { createASCClient, extractReleaseCopy, runRelease, validateReleaseTarget } from '../asc-certificates.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const copy = {
  whatsNew: { 'en-US': 'English update', ko: '한국어 업데이트', ja: '日本語の更新' },
  notes: 'Synthetic reviewer notes',
};
const clone = <T>(v: T): T => structuredClone(v);
const unknownOutcome = () => Object.assign(new Error('lost response'), { outcomeUnknown: true });
type Resource = { type: string; id: string; attributes: Record<string, any>; relationships?: Record<string, any> };

/** Mutable ASC fixture, not a sequence of canned returns: later GETs must see
 * exactly the resources/relationships created by earlier mutation requests. */
function fixture(prepared = false) {
  const version: Resource = { type: 'appStoreVersions', id: 'version-mac', attributes: {
    platform: 'MAC_OS', versionString: '1.9.2', appStoreState: 'DEVELOPER_REJECTED', releaseType: prepared ? 'AFTER_APPROVAL' : 'MANUAL',
  } };
  const build: Resource = { type: 'builds', id: 'build-9301', attributes: { version: '9301', processingState: 'VALID', expired: false },
    relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'pre-mac' } } } };
  const pre: Resource = { type: 'preReleaseVersions', id: 'pre-mac', attributes: { version: '1.9.2', platform: 'MAC_OS' } };
  const localizations = Object.entries(copy.whatsNew).map(([locale, text]) => ({
    type: 'appStoreVersionLocalizations', id: `locale-${locale}`, attributes: { locale, whatsNew: prepared ? text : 'previous copy' },
  }));
  const review: Resource = { type: 'appStoreReviewDetails', id: 'review-mac', attributes: { notes: prepared ? copy.notes : 'previous notes' } };
  const state = {
    version, build, pre, localizations, review,
    attached: prepared ? build : { type: 'builds', id: 'build-9201', attributes: { version: '9201' } } as Resource,
    submissions: [] as Resource[], items: [] as Resource[],
    calls: [] as Array<{ path: string; method: string; body?: any }>,
    loseResponse: '' as string, reject: '' as string, driftAfterLocale: false, driftAfterItem: false,
  };
  async function request(path: string, method = 'GET', body?: any) {
    state.calls.push({ path, method, body: clone(body) });
    if (state.reject === `${method} ${path}`) throw new Error('ASC request failed (HTTP 403)');
    const url = new URL(path, 'https://api.appstoreconnect.apple.com');
    const p = url.pathname;
    let result: any;
    if (method === 'GET') {
      if (p === '/v1/apps/6784822497/appStoreVersions') result = { data: [version] };
      else if (p === '/v1/builds') result = { data: [build], included: [pre] };
      else if (p === '/v1/appStoreVersions/version-mac/appStoreVersionLocalizations') result = { data: localizations };
      else if (p === '/v1/appStoreVersions/version-mac/appStoreReviewDetail') result = { data: review };
      else if (p === '/v1/appStoreVersions/version-mac/build') result = { data: state.attached };
      else if (p === '/v1/apps/6784822497/reviewSubmissions') result = { data: state.submissions };
      else if (/^\/v1\/reviewSubmissions\/[\w-]+\/items$/.test(p)) result = { data: state.items.filter(i => i.relationships?.reviewSubmission.data.id === p.split('/')[3]) };
    } else if (method === 'PATCH') {
      if (p.startsWith('/v1/appStoreVersionLocalizations/')) {
        Object.assign(localizations.find(l => l.id === body.data.id)!.attributes, body.data.attributes);
        if (state.driftAfterLocale) state.attached = { type: 'builds', id: 'build-9401', attributes: { version: '9401' } };
      } else if (p === '/v1/appStoreReviewDetails/review-mac') Object.assign(review.attributes, body.data.attributes);
      else if (p === '/v1/appStoreVersions/version-mac') Object.assign(version.attributes, body.data.attributes);
      else if (p === '/v1/appStoreVersions/version-mac/relationships/build') {
        expect(body).toEqual({ data: { type: 'builds', id: 'build-9301' } });
        state.attached = build;
      } else if (p === '/v1/reviewSubmissions/submission-new') {
        expect(body).toEqual({ data: { type: 'reviewSubmissions', id: 'submission-new', attributes: { submitted: true } } });
        state.submissions[0]!.attributes.state = 'WAITING_FOR_REVIEW';
        version.attributes.appStoreState = 'WAITING_FOR_REVIEW';
      } else throw new Error(`Unexpected PATCH ${p}`);
      result = { data: { ...body.data } };
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
      result = { data: item };
    }
    if (!result) throw new Error(`Unexpected ${method} ${p}`);
    if (state.loseResponse === `${method} ${p}`) { state.loseResponse = ''; throw unknownOutcome(); }
    return clone(result);
  }
  return { ...state, state, request,
    run: (action = 'release-submit') => runRelease({ action, version: '1.9.2', build: '9301', copy, request, pause: async () => {} }),
    writes: () => state.calls.filter(c => c.method !== 'GET'),
  };
}

describe('bounded macOS ASC release', () => {
  it('extracts only current macOS EN/KO/JA and the marked macOS reviewer field', () => {
    const extracted = extractReleaseCopy(readFileSync(resolve(ROOT, 'docs/appstore-metadata-draft.md'), 'utf8'),
      readFileSync(resolve(ROOT, 'apple/APP_REVIEW_NOTES.md'), 'utf8'), '1.9.2');
    expect(Object.keys(extracted.whatsNew)).toEqual(['en-US', 'ko', 'ja']);
    expect(extracted.notes).toContain('NEW IN 1.9.2 — MACOS ONLY');
    expect(extracted.notes).not.toContain('<!--');
    for (const text of [...Object.values(extracted.whatsNew), extracted.notes] as string[]) expect(text.length).toBeLessThanOrEqual(4000);
    expect(() => extractReleaseCopy('## Prepared macOS 1.9.2 update text', '', '1.9.2')).toThrow();
  });

  it.each([['1.9.1', '9301'], ['1.9.2', '9201'], ['1.9.2', '0'], ['1.9.2', '9301; echo secret']])('rejects target %s/%s before API calls', (version, build) => {
    expect(() => validateReleaseTarget(version, build)).toThrow();
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
    await expect(runRelease({ action: 'release-submit', version: '1.9.2', build: '9301', copy,
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
