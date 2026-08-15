#!/usr/bin/env node
// Generate the Swift mirror of the agent state machine's transition table
// (shared/src/states.ts: State / TransitionSource / transitions).
//
//   pnpm generate-state-transitions            regenerate the mirror
//   pnpm generate-state-transitions --check    exit 1 if the mirror drifted
//
// Requires shared to be built first (`pnpm --filter @agentdeck/shared build`
// or `pnpm build`) — the CLI imports the table from shared/dist. The vitest
// sync test imports the emitter below directly against the TS source, so
// drift fails CI even if this CLI is never run.
//
// WHY a generator rather than the hand-mirror that lived in StateMachine.swift:
// this table is a set of rules two daemons must agree on exactly. Node's hub
// and the in-process Swift daemon both drive real sessions, and a row present
// in one and absent in the other is not a cosmetic difference — it is a
// session that wedges in AWAITING_* on one platform and recovers on the
// other, with nothing in either log saying why. Hand-mirrors of a rule table
// drift silently by construction; this one had already grown a platform note
// that existed only on the Swift side.
//
// Swift-only by design: Android/Kotlin has no state machine — it renders
// states the daemon computed, and never runs a transition of its own.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/states.ts (State, TransitionSource, transitions)\n' +
  'Regenerate: pnpm generate-state-transitions (drift gated by shared/src/__tests__/state-transitions.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

/** `awaiting_permission` → `awaitingPermission`. The Swift enum keeps the wire
 *  string as its rawValue, so only the case NAME is camelCased. */
export function swiftCaseName(stateValue) {
  return stateValue.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Swift `enum AgentState` case declaration — a raw value is emitted only when
 *  the case name and the wire string differ, matching how Swift derives it. */
function swiftStateCase(stateValue) {
  const name = swiftCaseName(stateValue);
  return name === stateValue ? `    case ${name}` : `    case ${name} = "${stateValue}"`;
}

function swiftNoteLines(note, indent) {
  return note.split('\n').map((l) => `${indent}// ${l}`).join('\n');
}

export function emitSwift({ states, sources, transitions }) {
  const rows = transitions.map((t) => {
    // `from: '*'` is a wildcard, which Swift models as an optional rather than
    // a magic case — an enum case would have to be excluded at every match.
    const from = t.from === '*' ? 'nil' : `.${swiftCaseName(t.from)}`;
    const source = t.source === 'internal' ? '.internal' : `.${t.source}`;
    const row = `    .init(from: ${from}, to: .${swiftCaseName(t.to)}, trigger: "${t.trigger}", source: ${source}),`;
    return t.note ? `${swiftNoteLines(t.note, '    ')}\n${row}` : row;
  }).join('\n');

  return `${comment('//')}

import Foundation

enum AgentState: String, Codable, Sendable {
${states.map(swiftStateCase).join('\n')}
}

enum TransitionSource: String, Sendable {
    case ${sources.map((s) => (s === 'internal' ? '`internal`' : s)).join(', ')}
}

struct StateTransition: Sendable {
    let from: AgentState?  // nil = wildcard *
    let to: AgentState
    let trigger: String
    let source: TransitionSource
}

/// The agent state machine's transition table, mirrored from shared/src/states.ts.
///
/// NOTE for this daemon specifically: it multiplexes every observed session
/// into one machine, so — exactly like the Node daemon hub's
/// \`toolActivityRecovery: false\` — the driver (DaemonServer) must never EMIT
/// "tool_activity". Those rows exist because the table is a faithful mirror,
/// not because this daemon drives them.
let stateTransitions: [StateTransition] = [
${rows}
]
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Core/StateTransitions.generated.swift', emitSwift],
];

/** Files that are generated for macOS-only targets must carry the platform
 *  guard, or the iOS archive breaks while every macOS build stays green. */
const MACOS_ONLY = new Set(['apple/AgentDeck/Daemon/Core/StateTransitions.generated.swift']);

function withPlatformGuard(rel, body) {
  return MACOS_ONLY.has(rel) ? `#if os(macOS)\n${body}#endif\n` : body;
}

export function renderOutput(rel, emit, table) {
  return withPlatformGuard(rel, emit(table));
}

/** The emitter's input, read off the built shared package. */
export function tableFrom(mod) {
  return {
    states: Object.values(mod.State),
    // Declaration order of the union in states.ts, which the Swift enum mirrors.
    sources: ['hook', 'pty', 'user', 'internal'],
    transitions: mod.transitions,
  };
}

async function main() {
  let mod;
  try {
    mod = await import('../shared/dist/states.js');
  } catch {
    console.error('shared/dist not found — run `pnpm --filter @agentdeck/shared build` first');
    process.exit(1);
  }
  const table = tableFrom(mod);
  const check = process.argv.includes('--check');
  let drifted = false;
  for (const [rel, emit] of OUTPUTS) {
    const abs = path.join(projectDir, rel);
    const next = renderOutput(rel, emit, table);
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (check) {
      if (prev !== next) {
        console.error(`DRIFT: ${rel}`);
        drifted = true;
      }
    } else if (prev !== next) {
      fs.writeFileSync(abs, next);
      console.log(`wrote ${rel}`);
    } else {
      console.log(`up-to-date ${rel}`);
    }
  }
  if (check) {
    console.log(drifted ? 'state transition mirrors DRIFTED' : 'state transition mirrors in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
