// Bounded 2.0 Store media delivery. Credentials never accompany binary uploads.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = '6784822497';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
const id = value => { check(typeof value === 'string' && /^[a-zA-Z0-9-]+$/.test(value), 'Invalid media resource ID'); return value; };

export function selectedMedia(version, platform, root = ROOT) {
  check(version === '2.0.0' && ['MAC_OS', 'IOS'].includes(platform), 'Media delivery is scoped to 2.0.0 MAC_OS or IOS');
  const selection = JSON.parse(fs.readFileSync(resolve(root, 'apple/appstore-submission/media-2.0.0-selection.json')));
  const previews = JSON.parse(fs.readFileSync(resolve(root, 'docs/media/current/manifest.json'))).storePreviewCandidates.files;
  check(selection.version === version && selection.screenshots.length === 36, 'Incomplete 2.0 media selection');
  const groups = [];
  for (const locale of ['en', 'ko', 'ja']) for (const device of platform === 'MAC_OS' ? ['macOS'] : ['iPhone', 'iPad']) {
    const display = { macOS: 'DESKTOP', iPhone: 'IPHONE_65', iPad: 'IPAD_PRO_3GEN_129' }[device];
    const rows = selection.screenshots.filter(s => s.locale === locale && s.platform === device);
    check(rows.length === 4, 'Exactly four selected screenshots are required');
    for (const preview of [false, true]) {
      const files = preview ? previews.filter(s => s.platform === device) : rows;
      check(files.length === (preview ? 1 : 4), 'Incomplete selected preview');
      groups.push({ locale: locale === 'en' ? 'en-US' : locale, setType: preview ? 'appPreviewSets' : 'appScreenshotSets',
        assetType: preview ? 'appPreviews' : 'appScreenshots', displayField: preview ? 'previewType' : 'screenshotDisplayType',
        display: preview ? display : `APP_${display}`, preview,
        files: files.map(row => {
          check(typeof row.file === 'string' && row.file.startsWith('apple/appstore-submission/') && !row.file.includes('..') && !row.file.includes('\\'), 'Media must stay in the submission package');
          const bytes = fs.readFileSync(resolve(root, row.file));
          check(hash('sha256', bytes) === row.sha256, `Selected media checksum mismatch: ${row.file}`);
          return { path: row.file, bytes, md5: hash('md5', bytes),
            name: `agentdeck-${version}-${locale}-${device}-${row.sha256.slice(0,12)}-${basename(row.file)}` };
        }) });
    }
  }
  return groups;
}

export function uploadParts(operations, size) {
  check(Array.isArray(operations) && operations.length > 0 && operations.length <= 1000, 'Missing upload instructions');
  let end = 0;
  for (const op of [...operations].sort((a, b) => a.offset - b.offset)) {
    const url = new URL(op.url);
    check(url.protocol === 'https:' && url.hostname.endsWith('.apple.com') && !url.username && !url.password && !url.port, 'Untrusted asset upload destination');
    check(op.method === 'PUT' && Number.isSafeInteger(op.offset) && Number.isSafeInteger(op.length)
      && op.offset === end && op.length > 0 && op.offset + op.length <= size, 'Upload ranges must cover the exact file without overlap');
    check(Array.isArray(op.requestHeaders) && op.requestHeaders.every(h => typeof h.name === 'string' && typeof h.value === 'string' && !['authorization', 'cookie', 'host'].includes(h.name.toLowerCase())), 'Unsafe upload headers');
    end += op.length;
  }
  check(end === size, 'Incomplete asset upload ranges');
  return operations;
}

async function rows(request, path) {
  const result = await request(path);
  check(Array.isArray(result?.data) && !result.links?.next, 'Media collection is incomplete');
  return result.data;
}

async function editable(request, versionId, platform, version) {
  const versions = await rows(request, `/v1/apps/${APP}/appStoreVersions?filter[platform]=${platform}&filter[versionString]=${version}&limit=200`);
  check(versions.length === 1 && versions[0].id === id(versionId), 'Media version does not identify this app release');
  const row = versions[0];
  check(row.attributes?.platform === platform && row.attributes.versionString === version
    && ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED'].includes(row.attributes.appStoreState), 'Selected media requires the exact editable release draft');
}

async function setFor(request, localizations, group, create) {
  const locale = localizations[group.locale];
  check(locale?.attributes?.locale === group.locale, 'Media localization mismatch');
  const path = `/v1/appStoreVersionLocalizations/${id(locale.id)}/${group.setType}?limit=200`;
  const sets = (await rows(request, path)).filter(s => s.attributes?.[group.displayField] === group.display);
  check(sets.length <= 1, 'Duplicate media display set');
  if (sets.length) return sets[0];
  check(create, 'Selected media set is missing');
  return (await request(`/v1/${group.setType}`, 'POST', { data: { type: group.setType,
    attributes: { [group.displayField]: group.display }, relationships: { appStoreVersionLocalization: {
      data: { type: 'appStoreVersionLocalizations', id: locale.id } } } } })).data;
}

export async function prepareSelectedMedia({ request, version, platform, localizations, versionId, transport = fetch, root = ROOT,
  pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  const groups = selectedMedia(version, platform, root); // Validate every local file before any mutation.
  await editable(request, versionId, platform, version);
  for (const group of groups) {
    await editable(request, versionId, platform, version);
    const set = await setFor(request, localizations, group, true);
    const path = `/v1/${group.setType}/${id(set.id)}/${group.assetType}?limit=10`;
    let assets = await rows(request, path);
    // Replace only draft associations. Released baseline media is never edited.
    for (const asset of assets.filter(a => !group.files.some(f => f.name === a.attributes?.fileName))) {
      await request(`/v1/${group.assetType}/${id(asset.id)}`, 'DELETE');
    }
    assets = await rows(request, path);
    for (const file of group.files) {
      const matches = assets.filter(a => a.attributes?.fileName === file.name);
      check(matches.length <= 1, 'Duplicate reserved media file');
      let asset = matches[0];
      const reserve = async () => (await request(`/v1/${group.assetType}`, 'POST', { data: { type: group.assetType,
        attributes: { fileName: file.name, fileSize: file.bytes.length, ...(group.preview ? { previewFrameTimeCode: '00:00:05:00' } : {}) },
        relationships: { [group.preview ? 'appPreviewSet' : 'appScreenshotSet']: { data: { type: group.setType, id: set.id } } } } })).data;
      // The freshly read, app-scoped set already supplies identity and state.
      // Apple's individual screenshot GET can return 500 for a COMPLETE asset
      // even while this authoritative collection read succeeds.
      if (!asset) asset = await reserve();
      const state = asset.attributes?.assetDeliveryState?.state;
      if (['UPLOAD_COMPLETE', 'COMPLETE'].includes(state)) {
        check((state === 'UPLOAD_COMPLETE' && asset.attributes.sourceFileChecksum == null)
          || asset.attributes.sourceFileChecksum === file.md5, 'Reserved media checksum differs');
        continue;
      }
      check(state === 'AWAITING_UPLOAD', 'Reserved asset is failed or in an unknown state');
      // Apple supplies upload instructions on POST; a subsequent GET can omit
      // them. Keep the reservation response. For a prior uncommitted reservation
      // with no instructions, replace only this exact owned draft asset once.
      if (!asset.attributes.uploadOperations?.length) {
        check(asset.attributes.fileName === file.name && asset.attributes.fileSize === file.bytes.length,
          'Uncommitted reservation identity differs');
        await editable(request, versionId, platform, version);
        await request(`/v1/${group.assetType}/${id(asset.id)}`, 'DELETE');
        asset = await reserve();
        check(asset.attributes?.assetDeliveryState?.state === 'AWAITING_UPLOAD', 'Replacement reservation is not awaiting upload');
      }
      for (const op of uploadParts(asset.attributes.uploadOperations, file.bytes.length)) {
        const response = await transport(op.url, { method: op.method, redirect: 'error', signal: AbortSignal.timeout(120000),
          headers: Object.fromEntries(op.requestHeaders.map(h => [h.name, h.value])), body: file.bytes.subarray(op.offset, op.offset + op.length) });
        check(response.ok, `Binary upload failed (HTTP ${response.status}); reconcile the same reservation before retrying`);
      }
      await request(`/v1/${group.assetType}/${asset.id}`, 'PATCH', { data: { type: group.assetType, id: asset.id,
        attributes: { uploaded: true, sourceFileChecksum: file.md5 } } });
    }
    const uploaded = await rows(request, path);
    const ordered = group.files.map(file => {
      const matches = uploaded.filter(a => a.attributes?.fileName === file.name);
      check(matches.length === 1, 'Uploaded asset reservation is ambiguous');
      return { type: group.assetType, id: id(matches[0].id) };
    });
    await request(`/v1/${group.setType}/${set.id}/relationships/${group.assetType}`, 'PATCH', { data: ordered });
  }
  // Processing may outlast this workflow. Never turn UPLOAD_COMPLETE into ready.
  for (let attempt = 0; attempt < 60; attempt++) {
    try { return await assertSelectedMedia({ request, version, platform, localizations, root }); }
    catch (error) { if (!error.processing || attempt === 59) throw error; }
    await pause(5000);
  }
}

export async function assertSelectedMedia({ request, version, platform, localizations, root = ROOT }) {
  const groups = selectedMedia(version, platform, root);
  for (const group of groups) {
    const set = await setFor(request, localizations, group, false);
    const assets = await rows(request, `/v1/${group.setType}/${id(set.id)}/${group.assetType}?limit=10`);
    check(assets.length === group.files.length, 'Selected media count differs');
    for (const file of group.files) {
      const matches = assets.filter(a => a.attributes?.fileName === file.name);
      check(matches.length === 1, 'Selected media identity readback differs');
      const state = matches[0].attributes.assetDeliveryState?.state;
      if (state === 'UPLOAD_COMPLETE') throw Object.assign(new Error('Selected media is still processing; recheck before submission'), { processing: true });
      check(state === 'COMPLETE', 'Selected media is not COMPLETE');
      check(matches[0].attributes.sourceFileChecksum === file.md5, 'Selected media checksum readback differs');
    }
    const ordered = group.files.map(file => assets.find(a => a.attributes.fileName === file.name).id);
    check(assets.every((asset, index) => asset.id === ordered[index]), 'Selected media order differs');
  }
  return { platform, version, screenshots: groups.filter(g => !g.preview).length * 4, previews: groups.filter(g => g.preview).length, status: 'complete' };
}
