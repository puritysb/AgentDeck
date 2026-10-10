// Ship the direct host inside the published bridge, without a private runtime package dependency.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../bridge/package.json', import.meta.url));
const { build } = require('esbuild');
await build({ entryPoints: [fileURLToPath(new URL('./src/runtime.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../../bridge/dist/dot-runtime.mjs', import.meta.url)),
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
