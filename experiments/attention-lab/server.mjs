import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '../..');
// Explicit files only: never serve the checkout, daemon state or user data.
const files = new Map([
  ...['index.html', 'style.css', 'app.js', 'model.mjs'].map((f) => [`/${f}`, resolve(here, f)]),
  ['/assets/tokens.css', resolve(repo, 'design/tokens.css')],
  ['/assets/plex.ttf', resolve(repo, 'bridge/assets/fonts/IBMPlexSans-Regular.ttf')],
  ['/assets/plex-bold.ttf', resolve(repo, 'bridge/assets/fonts/IBMPlexSans-Bold.ttf')],
  ['/assets/plex-kr.ttf', resolve(repo, 'design/fonts/IBMPlexSansKR-Regular.ttf')],
  ['/assets/plex-kr-bold.ttf', resolve(repo, 'design/fonts/IBMPlexSansKR-Bold.ttf')],
  ['/assets/mono.ttf', resolve(repo, 'bridge/assets/fonts/JetBrainsMono-Regular.ttf')],
  ['/assets/baseline.png', resolve(repo, 'docs/media/macos-dashboard.png')],
  ['/assets/logo.png', resolve(repo, 'design/brand/agentdeck-icon.png')],
  ...['claudecode', 'codex', 'opencode', 'openclaw'].map((f) => [
    `/assets/${f}.svg`,
    resolve(repo, `design/brand/${f}.svg`),
  ]),
]);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = files.get(pathname === '/' ? '/index.html' : pathname);
    if (!file) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch {
      res.writeHead(500);
      res.end('Missing prototype asset');
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.AGENTDECK_LAB_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid AGENTDECK_LAB_PORT');
  const server = createServer();
  server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`AgentDeck attention lab: http://127.0.0.1:${port}`));
}
