import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from './session-registry.js';
import { importDotAppearance, saveDotAppearance } from './dot-appearance.js';
import { readDotConfiguration } from './dot-host.js';

export function registerDotCommands(program: Command) {
  const dot = program.command('dot').description('Operate the opt-in direct HTTPS MCP host');
  const character = dot.command('character').description('Choose the local Dot character; no ChatGPT avatar synchronization');
  character.command('import <file>').description('Import a static character image').action(async (file: string) => {
    const asset = await importDotAppearance(file, getDataDir()); console.log('Dot character imported: ' + asset.id.slice(0, 12));
  });
  character.command('reset').description('Restore the default Dot orb').action(() => { saveDotAppearance(null, getDataDir()); console.log('Dot character restored'); });
  async function request(path: string, value?: unknown) {
    const directory = getDataDir(), config = readDotConfiguration(directory);
    if (!config?.enabled) throw new Error('Configure the private dot-host.json first; see the direct hosting guide.');
    const token = readFileSync(join(directory, 'dot-operator-token'), 'utf8');
    const response = await fetch(`http://127.0.0.1:${config.controlPort}/operator/${path}`, {
      method: value === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    if (!response.ok) throw new Error(`Dot operation refused (${response.status})`);
    console.log(JSON.stringify(await response.json(), null, 2));
  }
  dot.command('status').description('Show pending local approvals, grants and briefing results').action(() => request('status'));
  dot.command('approve <id>').requiredOption('--code <code>', 'Code displayed in the connecting browser')
    .action((id: string, options: { code: string }) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(id) || options.code !== id.slice(0, 8)) throw new Error('Connection code does not match');
      return request('consent', { id, approve: true });
    });
  dot.command('deny <id>').action((id: string) => request('consent', { id, approve: false }));
  dot.command('disconnect <grantId>').action((grantId: string) => request('revoke', { grantId }));
  dot.command('request <grantId>').requiredOption('--context-file <path>', 'UTF-8 context to explicitly share')
    .option('--profile <id>', 'Subscribed integration profile', 'desk')
    .action((grantId: string, options: { contextFile: string; profile: string }) => request('request', {
      grantId, integrationId: options.profile, context: readFileSync(options.contextFile, 'utf8'), idempotencyKey: randomUUID(), capturedAt: Date.now(),
    }));
}
