import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, renameSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTokens, scanPaths, policy, reviewFixtures } from '../scan-agentdeck-tokens.mjs';

// Constructed here; no real credential or checked-in matching secret literal.
const token = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16)).join('');
test('recognizes generated Node/Swift shapes in field, bearer and URL contexts', () => {
  for (const key of ['pairingToken', 'authToken', 'auth_token', 'pairing_token', 'AGENTDECK_TOKEN']) {
    for (const value of [token, token.toUpperCase()]) {
      assert.equal(detectTokens(`{"${key}": "${value}"}`).length, 1);
      assert.equal(detectTokens(`${key} = '${value}'`).length, 1);
    }
  }
  for (const context of [`Bearer ${token}`, `bearer\t${token}`, `bEaReR ${token}`, `WSS://host/path?token=${token}`, `ws://localhost:9120/?token=${token}`, `wss://host/custom?x=1&token=${token}&x=2`]) assert.equal(detectTokens(context).length, 1);
});
test('rejects bare checksums, code expressions, redaction, unsupported encodings and wrong boundaries', () => {
  for (const value of [token, `md5="${token}"`, 'authToken = randomBytes(16)', 'pairingToken="[redacted]"',
    `authToken="${token.slice(1)}"`, `authToken="${token}f"`, `authToken="${token}${token}"`,
    `authToken="${token}_"`, `authToken="${token}-"`, `not_authToken="${token}"`, `Bearer ${'g'.repeat(32)}`]) {
    assert.equal(detectTokens(value).length, 0);
  }
});
test('retains adjacent matches and line numbers without exposing secret values', () => {
  const findings = detectTokens(`\nBearer ${token}\nBearer ${token}\nauthToken='${token}'`, 'example.txt');
  assert.deepEqual(findings.map(f => f.line), [2, 3, 4]);
  assert.ok(!JSON.stringify(findings).includes(token));
  assert.ok(findings.every(f => Object.keys(f).sort().join() === 'line,path,pattern'));
});
test('scans regular text, reports binary/symlink omissions, and refuses missing or escaping inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-fixture-'));
  try {
    writeFileSync(join(dir, 'leak.txt'), `Bearer ${token}`);
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 1, 2]));
    symlinkSync('/does/not/exist', join(dir, 'external'));
    const r = scanPaths(dir, ['leak.txt', 'image.bin', 'external']);
    assert.equal(r.findings.length, 1); assert.equal(r.skipped.length, 2);
    assert.throws(() => scanPaths(dir, ['../escape'])); assert.throws(() => scanPaths(dir, ['missing']));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('pattern policy uses bounded Hyperscan-compatible constructs, with explicit coverage limits', () => {
  assert.equal(policy.schema, 1); assert.equal(policy.patterns.length, 3);
  for (const p of policy.patterns) assert.ok(!/\(\?[=!<]|\\[1-9]|\(\?i/.test(p.start_delimiter + p.pattern + p.end_delimiter));
  assert.ok(policy.limits.some(l => l.includes('GitHub Hyperscan')));
});
test('synthetic exceptions require the exact reviewed file and count; new findings stay blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-review-'));
  try {
    const path = 'android/app/src/test/Fixture.kt';
    mkdirSync(join(dir, 'android/app/src/test'), { recursive: true });
    const text = `ws://192.168.1.10?token=${token}`;
    writeFileSync(join(dir, path), text);
    const exceptions = { schema: 1, fixtures: [{ path, pattern: 'websocket-query', count: 1,
      sha256: createHash('sha256').update(text).digest('hex'), reason: 'Synthetic test only' }] };
    const result = { findings: [...detectTokens(text, path), ...detectTokens(`Bearer ${token}`, 'new-file')] };
    const reviewed = reviewFixtures(dir, result, exceptions);
    assert.equal(reviewed.reviewedFixtures.length, 1); assert.equal(reviewed.findings.length, 1);
    assert.throws(() => reviewFixtures(dir, { findings: [] }, exceptions), /changed/);
    writeFileSync(join(dir, path), text + '\nnew content');
    assert.throws(() => reviewFixtures(dir, result, exceptions), /changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('large match sets fail explicitly and many line numbers remain correct', () => {
  assert.throws(() => detectTokens(`Bearer ${token}\n`.repeat(1001)), /Too many/);
  assert.equal(detectTokens('\n'.repeat(10000) + `Bearer ${token}`)[0].line, 10001);
});
test('a last-moment symlink replacement cannot redirect a tracked read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-open-race-'));
  try {
    writeFileSync(join(dir, 'tracked'), 'safe source');
    writeFileSync(join(dir, 'outside'), `Bearer ${token}`);
    const result = scanPaths(dir, ['tracked'], { open: (path, flags) => {
      renameSync(path, join(dir, 'original'));
      symlinkSync(join(dir, 'outside'), path);
      return openSync(path, flags);
    } });
    assert.equal(result.scanned, 0); assert.equal(result.findings.length, 0);
    assert.equal(result.skipped[0].reason, 'symlink; not followed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('same-file content changes during descriptor reads refuse a clean result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-content-race-'));
  try {
    const path = join(dir, 'tracked'); writeFileSync(path, 'initial source');
    let first = true;
    assert.throws(() => scanPaths(dir, ['tracked'], { read: (...args) => {
      const count = readSync(...args);
      if (first) { first = false; writeFileSync(path, `Bearer ${token}`); }
      return count;
    } }), /changed while scanning/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
