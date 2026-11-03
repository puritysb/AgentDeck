import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('blocks prototype poisoning from both merge operands without breaking normal merges', () => {
    const merge = createRequire(cli.resolve('@rollup/plugin-node-resolve'))('deepmerge');
    const source = JSON.parse('{"__proto__":{"securitySentinel":true},"nested":{"b":2}}');
    for (const [target, input] of [[Object.create(null), source], [source, { nested: { a: 1 } }]]) {
      const result = merge(target, input);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(result.securitySentinel).toBeUndefined();
      expect(Object.hasOwn(result, '__proto__')).toBe(false);
    }
    expect(merge({ nested: { a: 1 }, list: [1] }, { nested: { b: 2 }, list: [2] }))
      .toEqual({ nested: { a: 1, b: 2 }, list: [1, 2] });
    expect(({} as Record<string, unknown>).securitySentinel).toBeUndefined();
  });

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
