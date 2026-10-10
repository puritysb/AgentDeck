import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { startDirectHost, type DirectHostConfiguration } from './runtime.js';

const path = resolve(process.env.AGENTDECK_DOT_CONFIG ?? 'dot-host.json');
const config = JSON.parse(readFileSync(path, 'utf8')) as DirectHostConfiguration;
if (!config.enabled) throw new Error('Direct hosting is disabled in configuration');
const host = await startDirectHost(config, dirname(path));
process.once('SIGINT', () => void host.stop());
process.once('SIGTERM', () => void host.stop());
console.log(`AgentDeck direct HTTPS MCP started: ${host.origin}/mcp`);
