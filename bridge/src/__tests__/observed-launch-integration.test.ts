import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchObservedCommand } from '../observed-launch.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('real inherited-terminal shell', () => {
  it('preserves quoted executable/arguments, cwd and output redirection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad launch ')); dirs.push(dir);
    const script = join(dir, 'capture.cjs'); const output = join(dir, 'receipt.json');
    writeFileSync(script, 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),port:process.env.AGENTDECK_PORT??null}));process.exitCode=17;');
    const env = { ...process.env }; delete env.AGENTDECK_PORT;
    const quote = (s: string) => process.platform === 'win32' ? `"${s}"` : `'${s.replaceAll("'", "'\\''")}'`;
    const cmd = `${quote(process.execPath)} ${quote(script)} ${quote('two words')} ${quote('x&y')} > ${quote(output)}`;
    expect(launchObservedCommand(cmd, env)).toBe(17);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ args: ['two words', 'x&y'], cwd: process.cwd(), port: null });
  });
});
