import { writeFileSync } from 'node:fs';
import { createASCClient } from '../../scripts/asc-certificates.mjs';

const targets = {
  ios: { name: 'AgentDeck Dashboard AppStore', type: 'IOS_APP_STORE' },
  macos: { name: 'AgentDeck Dashboard macOS AppStore', type: 'MAC_APP_STORE' },
};
const [platform, output] = process.argv.slice(2);
const target = targets[platform];
if (!Object.hasOwn(targets, platform) || !output) {
  throw new Error('Usage: fetch-appstore-profile.mjs ios|macos <output-file>');
}

const query = new URLSearchParams({
  'filter[name]': target.name,
  'filter[profileType]': target.type,
  'filter[profileState]': 'ACTIVE',
  'fields[profiles]': 'name,profileType,profileState,profileContent,expirationDate,bundleId',
  'fields[bundleIds]': 'identifier',
  include: 'bundleId',
});
const api = createASCClient();
const { data, included, links } = await api(`/v1/profiles?${query}`);
const [profile] = data;
const attributes = profile?.attributes;
const bundleId = profile?.relationships?.bundleId?.data?.id;
const bundle = included?.find(item => item.type === 'bundleIds' && item.id === bundleId);
if (data.length !== 1 || links?.next || attributes?.name !== target.name ||
    attributes.profileType !== target.type || attributes.profileState !== 'ACTIVE' ||
    !(Date.parse(attributes.expirationDate) > Date.now()) || !attributes.profileContent ||
    bundle?.attributes?.identifier !== 'bound.serendipity.agent.deck') {
  throw new Error(`Expected one active ${platform} App Store profile for AgentDeck`);
}

writeFileSync(output, Buffer.from(attributes.profileContent, 'base64'), { flag: 'wx', mode: 0o600 });
console.log(`Fetched active ${platform} App Store profile (expires ${attributes.expirationDate.slice(0, 10)}).`);
