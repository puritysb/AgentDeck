import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DOT_LIMITS, DOT_OAUTH_LIMITS, DOT_INTERACTION_RANK, DOT_INTERACTION_TERMINAL } from '@agentdeck/shared';
import { tools, schemas, eventDefinition, VERSION } from '../contracts.js';
it('keeps the native manifest and generated security budgets aligned with the canonical contract', () => {
  const root = new URL('../../../../', import.meta.url);
  const contract = JSON.parse(readFileSync(new URL('apple/AgentDeck/Resources/dot-mcp-contract.json', root), 'utf8'));
  expect(contract).toEqual({ version: VERSION, event: eventDefinition, schemas,
    tools: tools.map(({ read, ...t }) => ({ ...t, annotations: { readOnlyHint: read, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
  const swift = readFileSync(new URL('apple/AgentDeck/Daemon/Dot/DotRules.generated.swift', root), 'utf8');
  for (const [name, limits] of Object.entries({ DotLimits: DOT_LIMITS, DotOAuthLimits: DOT_OAUTH_LIMITS })) {
    const body = swift.match(new RegExp(`enum ${name} \\{([^}]+)\\}`))![1];
    const found = Object.fromEntries([...body.matchAll(/static let (\w+) = (\d+)/g)].map(m => [m[1], Number(m[2])]));
    expect(found).toEqual(limits);
  }
});
it('generates the same relation transition policy consumed by native rendering and storage', () => {
  const swift = readFileSync(new URL('../../../../apple/AgentDeck/Daemon/Dot/DotInteraction.generated.swift', import.meta.url), 'utf8');
  const rank = swift.match(/static let rank: \[String: Int\] = \[([^\]]+)\]/)![1];
  expect(Object.fromEntries([...rank.matchAll(/"([^"]+)": (\d+)/g)].map(m => [m[1], Number(m[2])]))).toEqual(DOT_INTERACTION_RANK);
  expect(swift).toContain('next.targetRef == prior.targetRef');
  const terminal = swift.match(/static let terminal = (\[[^\]]+\])/)![1];
  expect(JSON.parse(terminal)).toEqual(DOT_INTERACTION_TERMINAL);
});

it('checks every generated portable model, phase table, pixel overlay and firmware glyph against the generator', () => {
  execFileSync(process.execPath, ['services/dot-relay/generate-native.mjs', '--check'], { cwd: new URL('../../../../', import.meta.url), timeout: 30000 });
});
