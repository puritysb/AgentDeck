/** CLI editor: a running owner wins; unknown/unavailable is never an offline write. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonPortWindow, getDataDir } from '../session-registry.js';
import { resolveDaemonPort } from '../daemon-port.js';
import { isForeignDaemon } from '../daemon-takeover.js';
import { parsePixooConfiguration, type PixooConfiguration } from '@agentdeck/shared';
import { readPixooConfiguration, writePixooConfiguration } from '../daemon-configuration.js';
export interface PixooEditTarget { port?: number; revision?: string; configuration: PixooConfiguration }
export async function loadPixooEditTarget(portOption?: string): Promise<PixooEditTarget> {
  let registered: number | undefined;
  try { const info = JSON.parse(readFileSync(join(getDataDir(),'daemon.json'),'utf8')); registered = info.httpPort ?? info.port; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Daemon registry is unreadable; settings were not changed.'); }
  const [lo,hi] = daemonPortWindow();
  const candidates = portOption !== undefined ? [Number(portOption)] : [...new Set([registered,resolveDaemonPort({}).port,...Array.from({length:hi-lo+1},(_,i)=>lo+i)].filter((v):v is number=>v!==undefined))];
  let unknown = false;
  for (const port of candidates) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid daemon port');
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(700),redirect:'error'});
      if (!health.ok) { unknown = true; continue; }
      const info = await health.json() as Record<string, unknown>;
      if (info.mode !== 'daemon' || isForeignDaemon(info)) { unknown = true; continue; }
    } catch (error) {
      if ((error as {cause?:{code?:string}}).cause?.code !== 'ECONNREFUSED') unknown = true;
      else {
        // A v4 refusal alone is not absence: a v6-only owner must not license
        // editing the inactive local profile.
        try { await fetch(`http://[::1]:${port}/health`,{signal:AbortSignal.timeout(700),redirect:'error'}); unknown = true; }
        catch (v6) { if ((v6 as {cause?:{code?:string}}).cause?.code !== 'ECONNREFUSED') unknown = true; }
      }
      continue;
    }
    const response = await fetch(`http://127.0.0.1:${port}/configuration/pixoo`,{signal:AbortSignal.timeout(5000),redirect:'error'});
    if (!response.ok) throw new Error(`Active daemon configuration unavailable (${response.status}); inactive settings were not changed.`);
    const raw = await response.json() as Record<string, unknown>, configuration = parsePixooConfiguration(raw.configuration);
    if (!configuration || typeof raw.revision !== 'string') throw new Error('Invalid daemon configuration');
    return {port,revision:raw.revision,configuration};
  }
  if (unknown || portOption !== undefined) throw new Error('Daemon state is unknown; settings were not changed.');
  return {configuration:readPixooConfiguration(getDataDir())};
}
export async function savePixooEditTarget(target: PixooEditTarget, value: PixooConfiguration): Promise<void> {
  const configuration = parsePixooConfiguration(value);
  if (!configuration) throw new Error('Invalid Pixoo configuration');
  if (target.port === undefined) { writePixooConfiguration(getDataDir(),configuration); return; }
  const response = await fetch(`http://127.0.0.1:${target.port}/configuration/pixoo`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:target.revision,configuration}),
    signal:AbortSignal.timeout(7000),redirect:'error',
  });
  if (!response.ok) throw new Error(`Settings were not confirmed (${response.status}); reload and retry. No inactive file was written.`);
}
