import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

test('local server exposes only prototype assets, with no action/network channel', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of [
    '/',
    '/style.css',
    '/app.js',
    '/model.mjs',
    '/assets/tokens.css',
    '/assets/plex.ttf',
    '/assets/plex-bold.ttf',
    '/assets/plex-kr.ttf',
    '/assets/plex-kr-bold.ttf',
    '/assets/mono.ttf',
    '/assets/baseline.png',
    '/assets/logo.png',
    '/assets/claudecode.svg',
    '/assets/codex.svg',
    '/assets/opencode.svg',
    '/assets/openclaw.svg',
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.arrayBuffer()).byteLength > 0, path);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  }
  for (const path of ['/CLAUDE.md', '/.env', '/.git/config', '/assets/../package.json', '/api/sessions', '/events']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/', { method: 'POST', body: '{}' })).status, 405);
  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
