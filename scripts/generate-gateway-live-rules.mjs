import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export const output = 'apple/AgentDeck/Daemon/Gateway/GatewayLiveActivity.generated.swift';
export function emitSwift(rules) {
  let source = fs.readFileSync(root + 'scripts/templates/gateway-live-activity.swift', 'utf8');
  const values = { MAX_RUNS: rules.maxRuns, MAX_TOOLS: rules.maxTools, RAW_LIMIT: rules.rawLimit,
    DETAIL_LIMIT: rules.detailLimit, TERMINAL: rules.terminalPhases, ACTIVE: rules.activePhases, QUIET: rules.quietProcessActions,
    FOLD_DETAIL: rules.foldDetailItems, FOLD_SUBJECTS: rules.foldSubjects };
  for (const [key, value] of Object.entries(values)) source = source.replaceAll(`@${key}@`, JSON.stringify(value));
  return source;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GATEWAY_LIVE_RULES } = await import('../shared/dist/gateway-live-activity.js');
  fs.writeFileSync(root + output, emitSwift(GATEWAY_LIVE_RULES));
}
