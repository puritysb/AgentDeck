import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = createRequire(resolve('package.json'));
const cli = createRequire(root.resolve('@elgato/cli'));
const sdk = createRequire(createRequire(resolve('plugin/package.json')).resolve('@elgato/streamdeck'));

describe('security dependency compatibility', () => {
  for (const [name, consumer] of [['CLI', cli], ['plugin', sdk]] as const) {
    it(`${name} keeps recursive options and RPC validation with patched Zod`, async () => {
      const base = dirname(consumer.resolve('@elgato/utils'));
      const { OptionGroup } = await import(pathToFileURL(resolve(base, 'lists/option-group.js')).href);
      const { JsonRpcRequest } = await import(pathToFileURL(resolve(base, 'rpc/json-rpc/request.js')).href);
      const group = { type: 'option-group', label: 'Models', options: [
        { type: 'option-group', label: 'Local', options: [{ type: 'option', label: 'A', value: 'a' }] },
      ] };
      expect(OptionGroup.parse(group)).toEqual(group);
      expect(OptionGroup.safeParse({ ...group, options: [{ type: 'option', value: {} }] }).success).toBe(false);
      expect(JsonRpcRequest.parse({ jsonrpc: '2.0', method: 'get', params: { path: 'model' }, id: '1' }).method).toBe('get');
      expect(JsonRpcRequest.safeParse({ jsonrpc: '1.0', method: 42 }).success).toBe(false);

      const zod = createRequire(consumer.resolve('@elgato/utils'))('zod/v4');
      let parsed = 0;
      const schema = zod.array(zod.string().refine(() => { parsed++; return true; })).max(1);
      expect(schema.safeParse(['a', 'b', 'c']).success).toBe(false);
      expect(parsed).toBe(0); // reject oversized containers before traversing elements
    });
  }

  for (const entry of ['cjs', 'es'] as const) {
    it(`resolves Node exports and bundles CommonJS through the ${entry} resolver without deepmerge`, async () => {
      const plugin = createRequire(resolve('plugin/package.json'));
      const cjsEntry = plugin.resolve('@rollup/plugin-node-resolve');
      const resolverEntry = resolve(dirname(cjsEntry), `../${entry}/index.js`);
      expect(() => createRequire(resolverEntry).resolve('deepmerge')).toThrow(/Cannot find module/);
      const { nodeResolve, DEFAULTS } = await import(pathToFileURL(resolverEntry).href);
      expect(DEFAULTS).toEqual({
        dedupe: [], extensions: ['.mjs', '.js', '.json', '.node'], resolveOnly: [],
        moduleDirectories: ['node_modules'], modulePaths: [],
        ignoreSideEffectsForRoot: false, allowExportsFolderMapping: true,
      });
      expect(Object.isFrozen(DEFAULTS)).toBe(true);
      expect(Object.isFrozen(DEFAULTS.extensions)).toBe(true);
      expect(() => DEFAULTS.extensions.push('.poison')).toThrow(TypeError);

      const dir = mkdtempSync(resolve(tmpdir(), 'agentdeck-resolver-'));
      try {
        const dependency = resolve(dir, 'node_modules/fixture-package');
        mkdirSync(dependency, { recursive: true });
        writeFileSync(resolve(dependency, 'package.json'), JSON.stringify({
          name: 'fixture-package', type: 'module',
          exports: { node: './node.cjs', default: './browser.js' },
        }));
        writeFileSync(resolve(dependency, 'node.cjs'), "module.exports = { answer: 42 };\n");
        writeFileSync(resolve(dependency, 'browser.js'), "export default { answer: 'wrong-condition' };\n");
        const input = resolve(dir, 'input.mjs');
        writeFileSync(input, "import value from 'fixture-package'; import { sep } from 'node:path'; export default [value.answer, typeof sep];\n");
        const { rollup } = plugin('rollup');
        const commonjs = plugin('@rollup/plugin-commonjs');
        const bundle = await rollup({
          input, plugins: [nodeResolve({ browser: false, exportConditions: ['node'], preferBuiltins: true }), commonjs()],
          onwarn(warning: { message: string }) { throw new Error(warning.message); },
        });
        try {
          const output = resolve(dir, 'bundle.mjs');
          await bundle.write({ file: output, format: 'es' });
          const result = await import(pathToFileURL(output).href);
          expect(result.default).toEqual([42, 'string']);
          expect(readFileSync(output, 'utf8')).not.toContain('wrong-condition');
        } finally { await bundle.close(); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it('keeps the EJS CLI/Jake path usable with the compatible filelist upgrade', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'agentdeck-ejs-'));
    try {
      const template = resolve(dir, 'input.ejs');
      const data = resolve(dir, 'input.json');
      const output = resolve(dir, 'output.txt');
      writeFileSync(template, '<%= label %>');
      writeFileSync(data, JSON.stringify({ label: 'AgentDeck' }));
      execFileSync(process.execPath, [resolve(dirname(cli.resolve('ejs')), '../bin/cli.js'), template, '-f', data, '-o', output], { timeout: 10_000 });
      expect(readFileSync(output, 'utf8')).toBe('AgentDeck');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
