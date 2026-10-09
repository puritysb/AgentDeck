import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOT_LIMITS, dotInteractionLabel, type DotInteraction } from '@agentdeck/shared';
import type { CardModule } from './card-modules.js';
interface DotResult { interactions?: DotInteraction[]; requestId: string; integrationId: string; createdAt: number; expiresAt: number; delivery: string; report: null | { state: string; summary: string; receivedAt: number } }
export function dotResultModule(reports: () => DotResult[]): CardModule {
  return { id: 'dot', build: ({ now }) => reports().filter(r => (r.report || r.interactions?.length) && r.createdAt + DOT_LIMITS.retentionMs > now)
    .sort((a, b) => Math.max(b.report?.receivedAt ?? 0, b.interactions?.at(-1)?.receivedAt ?? 0) - Math.max(a.report?.receivedAt ?? 0, a.interactions?.at(-1)?.receivedAt ?? 0)).slice(0, DOT_LIMITS.feedReports).map(r => ({
      key: r.requestId, actionClass: 'info', title: 'DOT',
      question: (r.interactions?.at(-1) ? dotInteractionLabel(r.interactions.at(-1)!) : r.report!.summary).replace(/[\p{Cc}\p{Cf}]/gu, ' '),
      context: r.interactions?.length ? [
        r.interactions.at(-1)!.summary, new Date(r.interactions.at(-1)!.receivedAt).toISOString(), "Dot report; target unverified",
      ] : [`Last report: ${r.report!.state}`, new Date(r.report!.receivedAt).toISOString(), `Profile: ${r.integrationId}`],
    })) };
}

export interface DirectDotHostConfiguration {
  enabled: boolean; origin: string; port: number; bind?: string; certificatePath: string; keyPath: string;
  clientId: string; clientSecret: string; redirectURI: string; controlPort: number;
}
export type DotHostConfiguration = DirectDotHostConfiguration | { enabled: boolean; mode: 'local'; port: number; controlPort: number; bind?: string };
export function readDotConfiguration(directory: string): DotHostConfiguration | undefined {
  try { return JSON.parse(readFileSync(join(directory, 'dot-host.json'), 'utf8')) as DotHostConfiguration; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function startConfiguredDotHost(directory: string, loopbackOnly: boolean) {
  const config = readDotConfiguration(directory);
  if (!config?.enabled) return undefined;
  if (loopbackOnly && !('mode' in config && config.mode === 'local') && !['127.0.0.1', '::1'].includes(config.bind ?? '0.0.0.0')) {
    throw new Error('Dot public binding conflicts with the daemon loopback posture');
  }
  const runtime = await import(new URL('./dot-runtime.mjs', import.meta.url).href) as {
    startDirectHost(config: DotHostConfiguration, directory: string): Promise<{ stop(): Promise<void>; origin: string; reports(): DotResult[]; deckSnapshot(): import('@agentdeck/shared').DotDeckSnapshot }>;
  };
  return runtime.startDirectHost(config, directory);
}
