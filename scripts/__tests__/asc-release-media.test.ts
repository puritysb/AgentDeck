import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error native release ESM
import { selectedMedia, uploadParts, prepareSelectedMedia, assertSelectedMedia } from '../asc-release-media.mjs';
// @ts-expect-error native release ESM
import { releasePlatform, validatePlatformRelease, extractReleaseCopy } from '../asc-certificates.mjs';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'asc-media-')); roots.push(root);
  const digest = (algorithm: string, data: Buffer) => createHash(algorithm).update(data).digest('hex');
  const rows: any[] = [], previews: any[] = [];
  function file(path: string, value: string) {
    const bytes = Buffer.from(value); mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), bytes);
    return { file: path, sha256: digest('sha256', bytes) };
  }
  for (const locale of ['en','ko','ja']) for (const platform of ['macOS','iPhone','iPad']) for (let i = 0; i < 4; i++) {
    rows.push({ ...file(`apple/appstore-submission/screenshots/${locale}/${platform}/${i}.png`, `${locale}-${platform}-${i}`), locale, platform });
  }
  for (const platform of ['macOS','iPhone','iPad']) previews.push({ ...file(`apple/appstore-submission/previews/${platform}/preview.mp4`, platform), platform });
  writeFileSync(join(root, 'apple/appstore-submission/media-2.0.0-selection.json'), JSON.stringify({ version: '2.0.0', screenshots: rows }));
  mkdirSync(join(root, 'docs/media/current'), { recursive: true });
  writeFileSync(join(root, 'docs/media/current/manifest.json'), JSON.stringify({ storePreviewCandidates: { files: previews } }));
  const localizations = Object.fromEntries(['en-US','ko','ja'].map(locale => [locale, { id: locale, attributes: { locale } }]));
  const groups = selectedMedia('2.0.0', 'MAC_OS', root);
  const sets = new Map<string, any>(); const assets = new Map<string, any>(); const calls: any[] = [];
  let serial = 0, state = 'PREPARE_FOR_SUBMISSION', processing = false, app = '6784822497';
  const data = (value: any) => ({ data: value });
  async function request(path: string, method = 'GET', body?: any): Promise<any> {
    calls.push({ path, method, body }); const p = path.split('?')[0];
    if (method === 'GET' && p === '/v1/apps/6784822497/appStoreVersions') return data(app === '6784822497' ? [{ id: 'version', attributes: { platform: 'MAC_OS', versionString: '2.0.0', appStoreState: state } }] : []);
    if (method === 'GET' && p.startsWith('/v1/appStoreVersionLocalizations/')) {
      const [, , , locale, type] = p.split('/'); return data([...sets.values()].filter(s => s.locale === locale && s.type === type));
    }
    if (method === 'POST' && ['appScreenshotSets','appPreviewSets'].includes(body.data.type)) {
      const row = { ...body.data, id: `set-${++serial}`, locale: body.data.relationships.appStoreVersionLocalization.data.id };
      sets.set(row.id, row); return data(row);
    }
    if (method === 'GET' && /Sets\//.test(p)) {
      const setId = p.split('/')[3]; return data([...assets.values()].filter(a => a.setId === setId));
    }
    if (method === 'POST') {
      const relation: any = Object.values(body.data.relationships)[0];
      const row = { ...body.data, id: `asset-${++serial}`, setId: relation.data.id,
        attributes: { ...body.data.attributes, assetDeliveryState: { state: 'AWAITING_UPLOAD' }, uploadOperations: [{ method: 'PUT', url: 'https://store.blobstore.apple.com/upload', offset: 0, length: body.data.attributes.fileSize, requestHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }] }] } };
      assets.set(row.id, row); return data(row);
    }
    if (method === 'GET') return data(assets.get(p.split('/')[3]));
    if (method === 'PATCH' && p.includes('/relationships/')) return data(body.data);
    if (method === 'PATCH') {
      const row = assets.get(body.data.id); Object.assign(row.attributes, body.data.attributes, { assetDeliveryState: { state: processing ? 'UPLOAD_COMPLETE' : 'COMPLETE' } }); return data(row);
    }
    if (method === 'DELETE') { assets.delete(p.split('/')[3]); return null; }
    throw new Error(`Unexpected ${method} ${p}`);
  }
  return { root, groups, localizations, request, calls, assets, setState: (s: string) => { state = s; }, setApp: (s: string) => { app = s; }, setProcessing: () => { processing = true; } };
}
const op = (offset = 0, length = 3, url = 'https://store.blobstore.apple.com/upload') => ({ method: 'PUT', offset, length, url, requestHeaders: [] });
describe('bounded Store media delivery', () => {
  it('rejects foreign destinations, credentials, unsafe headers and incomplete/overlapping byte ranges', () => {
    expect(uploadParts([op()], 3)).toHaveLength(1);
    for (const url of ['http://store.blobstore.apple.com/a','https://apple.com.evil.test/a','https://user:pass@store.blobstore.apple.com/a']) expect(() => uploadParts([op(0,3,url)],3)).toThrow();
    for (const parts of [[op(1,2)],[op(0,2)],[op(),op(2,1)],[{...op(),requestHeaders:[{name:'Authorization',value:'secret'}]}]]) expect(() => uploadParts(parts,3)).toThrow();
  });
  it('validates exact platform, version and all local hashes before mutations', async () => {
    const f=fixture(); const ios = selectedMedia('2.0.0','IOS',f.root); expect(ios).toHaveLength(12); expect(ios.filter((g: any) => g.display === 'APP_IPHONE_65')).toHaveLength(3);
    expect(() => selectedMedia('2.0.1','MAC_OS',f.root)).toThrow(); expect(() => releasePlatform('TV_OS')).toThrow(); expect(() => validatePlatformRelease('IOS','release-prepare','1.9.2')).toThrow(); expect(() => validatePlatformRelease('IOS','release-replace-prepare','2.0.0')).toThrow(); expect(() => validatePlatformRelease('IOS','release-submit','2.0.0')).not.toThrow();
    writeFileSync(join(f.root,f.groups[0].files[0].path),'tampered');
    await expect(prepareSelectedMedia({...f,version:'2.0.0',platform:'MAC_OS',versionId:'version'})).rejects.toThrow('checksum'); expect(f.calls).toEqual([]);
  });
  it('refuses a submitted draft or another app before any write', async () => {
    for (const drift of ['submitted','foreign']) { const f=fixture(); if(drift==='submitted')f.setState('WAITING_FOR_REVIEW');else f.setApp('other');
      await expect(prepareSelectedMedia({...f,version:'2.0.0',platform:'MAC_OS',versionId:'version'})).rejects.toThrow(); expect(f.calls.every(c=>c.method==='GET')).toBe(true); }
  });
  it('uploads exact bytes without API authorization and reconciles repeated delivery without new reservations', async () => {
    const f=fixture(); const sent: any[]=[]; const transport=async (_url: string, options: any)=>{sent.push(options);return {ok:true};};
    const args={...f,version:'2.0.0',platform:'MAC_OS',versionId:'version',transport};
    await expect(prepareSelectedMedia(args)).resolves.toMatchObject({screenshots:12,previews:3,status:'complete'});
    expect(sent).toHaveLength(15); expect(sent.every(s=>!('Authorization' in s.headers)&&Buffer.isBuffer(s.body)&&s.redirect==='error'&&s.signal)).toBe(true);
    const posts=f.calls.filter(c=>c.method==='POST').length; await prepareSelectedMedia(args); expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(posts); expect(sent).toHaveLength(15);
    const asset=[...f.assets.values()][0]; asset.attributes.sourceFileChecksum='wrong';
    await expect(assertSelectedMedia(args)).rejects.toThrow('checksum');
  });
  it('never calls processing media ready or retries an ambiguous reservation POST', async () => {
    const f=fixture(); f.setProcessing();
    await expect(prepareSelectedMedia({...f,version:'2.0.0',platform:'MAC_OS',versionId:'version',transport:async()=>({ok:true}),pause:async()=>{}})).rejects.toThrow('still processing');
    const g=fixture(); let posts=0; const request=async(path:string,method='GET',body?:any)=>{if(method==='POST'){posts++;throw Object.assign(new Error('outcome unknown'),{outcomeUnknown:true});}return g.request(path,method,body);};
    await expect(prepareSelectedMedia({...g,request,version:'2.0.0',platform:'MAC_OS',versionId:'version'})).rejects.toThrow('outcome unknown');expect(posts).toBe(1);
  });
  it('uses POST upload instructions when Apple omits them from subsequent GET responses', async () => {
    const f = fixture(); let sent = 0;
    const request = async (path: string, method = 'GET', body?: any) => {
      const result = structuredClone(await f.request(path, method, body));
      if (method === 'GET' && result?.data?.attributes) delete result.data.attributes.uploadOperations;
      return result;
    };
    const args = { ...f, request, version: '2.0.0', platform: 'MAC_OS', versionId: 'version',
      transport: async () => { sent++; return { ok: true }; } };
    await expect(prepareSelectedMedia(args)).resolves.toMatchObject({ status: 'complete' });
    expect(sent).toBe(15); expect(f.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
  });
  it('reconciles an exact uncommitted draft reservation once without duplicating completed media', async () => {
    const f = fixture();
    const args = { ...f, version: '2.0.0', platform: 'MAC_OS', versionId: 'version' };
    await expect(prepareSelectedMedia({ ...args, transport: async () => ({ ok: false, status: 503 }) })).rejects.toThrow('Binary upload failed');
    const request = async (path: string, method = 'GET', body?: any) => {
      const result = structuredClone(await f.request(path, method, body));
      if (method === 'GET') for (const row of Array.isArray(result?.data) ? result.data : [result?.data]) {
        if (row?.attributes) delete row.attributes.uploadOperations;
      }
      return result;
    };
    await expect(prepareSelectedMedia({ ...args, request, transport: async () => ({ ok: true }) })).resolves.toMatchObject({ status: 'complete' });
    expect(f.calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
    expect(f.assets.size).toBe(15);
  });
  it('uses fresh scoped collection state when individual completed-screenshot reads are unavailable', async () => {
    const f = fixture(); let individualReads = 0;
    const request = async (path: string, method = 'GET', body?: any) => {
      if (method === 'GET' && /^\/v1\/appScreenshots\//.test(path)) { individualReads++; throw new Error('ASC GET failed (HTTP 500)'); }
      return f.request(path, method, body);
    };
    const args = { ...f, request, version: '2.0.0', platform: 'MAC_OS', versionId: 'version', transport: async () => ({ ok: true }) };
    await prepareSelectedMedia(args); const posts = f.calls.filter(c => c.method === 'POST').length;
    await expect(prepareSelectedMedia(args)).resolves.toMatchObject({ status: 'complete' });
    expect(individualReads).toBe(0); expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(posts);
  });
  it('waits for nullable processing checksums and resumes without uploading again, but requires a final checksum', async () => {
    const f = fixture(); const args = { ...f, version: '2.0.0', platform: 'MAC_OS', versionId: 'version', transport: async () => ({ ok: true }) };
    await prepareSelectedMedia(args);
    const posts = f.calls.filter(c => c.method === 'POST').length;
    for (const asset of f.assets.values()) asset.attributes.assetDeliveryState.state = 'UPLOAD_COMPLETE';
    const request = async (path: string, method = 'GET', body?: any) => {
      const result = structuredClone(await f.request(path, method, body));
      const rows = Array.isArray(result?.data) ? result.data : [result?.data];
      for (const row of rows) if (row?.attributes?.assetDeliveryState?.state === 'UPLOAD_COMPLETE') row.attributes.sourceFileChecksum = null;
      return result;
    };
    let pauses = 0;
    await expect(prepareSelectedMedia({ ...args, request, pause: async () => {
      pauses++; for (const asset of f.assets.values()) asset.attributes.assetDeliveryState.state = 'COMPLETE';
    } })).resolves.toMatchObject({ status: 'complete' });
    expect(pauses).toBe(1); expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(posts);
    [...f.assets.values()][0].attributes.sourceFileChecksum = null;
    await expect(assertSelectedMedia(args)).rejects.toThrow('checksum');
  });
  it('extracts separate iOS review notes and rejects a Mac-only version claim', () => {
    const metadata="## Prepared iOS 2.0.0 update text\n"+["English — iOS What's New",'Korean — iOS 새로운 기능','Japanese — iOS このバージョンの新機能'].map(h=>`### ${h}\n\n\`\`\`text\nUpdate\n\`\`\`\n`).join('');
    expect(extractReleaseCopy(metadata,'<!-- ios-notes-field:begin -->\n```text\nNEW IN 2.0.0\n```\n<!-- ios-notes-field:end -->','2.0.0','IOS').notes).toBe('NEW IN 2.0.0');
    expect(()=>extractReleaseCopy(metadata,'','2.0.0','MAC_OS')).toThrow();
  });
});
