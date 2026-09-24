import { rollup } from 'rollup';
import config from '../rollup.config.mjs';
import { installedPath, inspectInstallation } from './deployment-state.mjs';
import { fileURLToPath } from 'node:url';

const configs = Array.isArray(config) ? config : [config];

try {
  for (const item of configs) {
    const { output, ...inputOptions } = item;
    const bundle = await rollup(inputOptions);
    try {
      const outputs = Array.isArray(output) ? output : [output];
      for (const outputOptions of outputs) {
        await bundle.write(outputOptions);
      }
    } finally {
      await bundle.close();
    }
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}

if (process.platform === 'darwin' || process.platform === 'win32') {
  const source = fileURLToPath(new URL('../bound.serendipity.agentdeck.sdPlugin', import.meta.url));
  const problem = inspectInstallation(source, installedPath());
  console.warn(problem ? `Built only; ${problem}. Run pnpm plugin:deploy from the main checkout.` : 'Built only; restart and verify the running plugin with pnpm plugin:deploy.');
}
process.exit(0);
