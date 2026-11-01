// Run after pnpm --filter @agentdeck/hooks build.
import { opencodePluginSource, OPENCODE_NATIVE_SETUP } from '../hooks/dist/opencode-install.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const sha = text => createHash('sha256').update(text).digest('hex');
const source = opencodePluginSource({ nativeObserver: true });
writeFileSync(new URL('../apple/AgentDeck/Resources/OpenCodeObserver.json', import.meta.url),
  JSON.stringify({ ...OPENCODE_NATIVE_SETUP, source, cliSHA256: sha(opencodePluginSource()) }, null, 2) + '\n');
