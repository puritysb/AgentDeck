import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceSecurityStore } from '../device-security-store.js';
import { DeviceCredentialStore } from '../device-credential-store.js';
import { DEVICE_SECURITY, DEVICE_SNAPSHOT, buildDeviceSnapshot, DEVICE_CREDENTIALS, parseDeviceCredentialState, mergeDeviceCredentialState, deviceMessageAllowed } from '@agentdeck/shared';

it('keeps the native snapshot policy aligned with the shared projection', () => {
  const source = readFileSync('apple/AgentDeck/Daemon/Server/DeviceSnapshotRules.swift','utf8');
  for (const [key,expected] of Object.entries(DEVICE_SNAPSHOT)) {
    const value = source.match(new RegExp(`static let ${key} = ([^\\n]+)`))?.[1];
    expect(value,key).toBeDefined(); expect(JSON.parse(value!),key).toEqual(expected);
  }
});
it('keeps native custody constants aligned with the shared contract', () => {
  const source=readFileSync('apple/AgentDeck/Daemon/Server/DeviceSecurityRules.swift','utf8');
  for(const [key,expected] of Object.entries(DEVICE_SECURITY)) {
    const value=source.match(new RegExp(`static let ${key} = ([^\\n]+)`))?.[1];
    expect(value,key).toBeDefined();expect(JSON.parse(value!),key).toEqual(expected);
  }
});
it('keeps the Vobot response bound aligned with both daemon projections', () => {
  const source=readFileSync('integrations/vobot/AgentDeck/tls_transport.py','utf8');
  expect(Number(source.match(/MAX_BODY = (\d+)/)?.[1])).toBe(DEVICE_SNAPSHOT.maxBytes);
});
const swift = 'apple/AgentDeck/Daemon/Server/DeviceCredentialRules.swift';
it('keeps native credential policy constants aligned with the shared authority', () => {
  const source = readFileSync(swift, 'utf8');
  for (const key of ['version', 'prefix', 'file', 'maxDevices', 'maxBytes', 'maxNameBytes', 'scopes'] as const) {
    const value = source.match(new RegExp(`static let ${key} = ([^\\n]+)`))?.[1];
    expect(value, key).toBeDefined();
    expect(JSON.parse(value!.replace(/(?<=\d)_(?=\d)/g, '')), key).toEqual(DEVICE_CREDENTIALS[key]);
  }
});

describe.skipIf(process.platform !== 'darwin')('native device authority', () => {
  it('executes the same validation, conflict, revocation and registration vectors in Swift and Node', () => {
    const record = {id: 'a'.repeat(32), name: 'Vobot', verifier: 'b'.repeat(64), scopes: ['sessions.read'], createdAt: 10, revokedAt: null};
    const state = {version: 1, authority: 'c'.repeat(32), revision: 1, devices: [record]};
    const rows: Record<string, unknown>[] = [{operation: 'parse', value: state}];
    for (const change of [{createdAt: true}, {revokedAt: 9}, {revokedAt: undefined}, {name: 'bad\nname'}, {scopes: ['admin']}, {scopes: ['sessions.read','sessions.read']}, {verifier: 'x'.repeat(64)}]) {
      rows.push({operation: 'parse', value: {...state, devices: [{...record, ...change}]}});
    }
    const retired = {...state, revision: 2, devices: [{...record, revokedAt: 20}]};
    rows.push({operation: 'merge', local: retired, peer: state}, {operation: 'merge', local: state, peer: retired},
      {operation: 'merge', local: state, peer: {...state, authority: 'd'.repeat(32)}},
      {operation: 'merge', local: state, peer: {...state, devices: [{...record, scopes: ['usage.read']}]}});
    const registration = {type: 'client_register', clientType: 'companion', surface: {protocol: 1, profiles: [{id: 'display-only/v1', capabilities: ['sessions.read']}]}};
    for (const value of [registration, {...registration, clientType: 'bridge'}, {type:'session_command'}, {...registration, surface: {...registration.surface, protocol: true}}]) rows.push({operation:'message', value});
    for (const scopes of [['sessions.read'], ['usage.read'], ['sessions.read','usage.read']]) rows.push({operation:'snapshot',scopes,
      sessions:[{id:'s',state:'idle',alive:true,token:'secret',cwd:'/private'}, {id:'bad',state:'idle',alive:1}],
      usage:{usageStale:false,fiveHourPercent:20,token:'secret',scopedLimits:[{label:'Fable',percent:10,key:'secret'}],codexRateLimits:{capturedAt:'now',primary:{usedPercent:40,stale:false,token:'secret'},credits:{balance:'10',hasCredits:true,unlimited:false,token:'secret'}}}});
    const expected = rows.map(row => {
      try {
        if (row.operation === 'snapshot') return buildDeviceSnapshot(row.scopes as never,row.sessions,row.usage);
        if (row.operation === 'parse') return parseDeviceCredentialState(row.value);
        if (row.operation === 'message') return deviceMessageAllowed(row.value);
        return mergeDeviceCredentialState(row.local as never, row.peer as never);
      } catch { return null; }
    });
    const dir = mkdtempSync(join(tmpdir(), 'device-credential-native-'));
    try {
      const binary = join(dir, 'native');
      execFileSync('swiftc', ['-swift-version','6','-module-cache-path',join(dir,'modules'),'-parse-as-library', swift,
        'apple/AgentDeck/Daemon/Core/DaemonActor.swift','apple/AgentDeck/Daemon/Server/DeviceCredentialStore.swift','apple/AgentDeck/Daemon/Server/DeviceSnapshotRules.swift',
        'apple/AgentDeck/Daemon/Server/DeviceTLSServer.swift','apple/AgentDeck/Daemon/Server/DeviceTLSIdentity.swift',
        'apple/AgentDeck/Daemon/Server/DeviceSecurityRules.swift','apple/AgentDeck/Daemon/Server/DeviceSecurityStore.swift',
        'apple/AgentDeck/Daemon/Server/PairingCredentialRules.generated.swift','apple/AgentDeck/App/AgentDeckPaths.swift',
        'bridge/src/__tests__/fixtures/device-credential-main.swift','-o',binary], {timeout:120000});
      expect(JSON.parse(execFileSync(binary, [], {input: JSON.stringify(rows), encoding:'utf8', timeout:15000}))).toEqual(expected);
      const profile = join(dir, 'profile'), store = new DeviceCredentialStore(profile);
      const native = JSON.parse(execFileSync(binary, ['issue', profile], {encoding:'utf8', timeout:15000}));
      expect(store.authenticate(native.token)?.id).toBe(native.id);
      const node = store.issue('Node dock', ['usage.read']);
      expect(execFileSync(binary, ['authenticate', profile], {input:node.token, encoding:'utf8', timeout:15000}).trim()).toBe('true');
      execFileSync(binary, ['revoke', profile, node.device.id], {timeout:15000});
      expect(store.authenticate(node.token)).toBeNull();
      expect(store.authenticate(native.token)).not.toBeNull();
      store.revoke(native.id);
      const custody = new DeviceSecurityStore(profile), peerProfile=join(dir,'native-profile');
      custody.install({version:1,role:'owner',hostname:'agentdeck-test.local',port:9443,pfx:'dGVzdA==',password:'test-only',caDER:'dGVzdA=='});
      const sealed=custody.seal('1'.repeat(32));
      execFileSync(binary,['security-adopt',peerProfile,'1'.repeat(32)],{input:JSON.stringify(sealed),timeout:15000});
      const peerIssue=JSON.parse(execFileSync(binary,['issue',peerProfile],{encoding:'utf8',timeout:15000}));
      const peerSeal=JSON.parse(execFileSync(binary,['security-seal',peerProfile,'2'.repeat(32)],{encoding:'utf8',timeout:15000}));
      custody.adopt(peerSeal,'2'.repeat(32));
      expect(custody.read()?.role).toBe('owner');
      expect(store.authenticate(peerIssue.token)).not.toBeNull();
      expect(store.authenticate(native.token)).toBeNull();

      expect(execFileSync(binary, ['authenticate', profile], {input:native.token, encoding:'utf8', timeout:15000}).trim()).toBe('false');

    } finally { rmSync(dir, {recursive:true, force:true}); }
  }, 130000);
});
