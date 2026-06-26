import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'UserPromptSubmit',
] as const;

function buildHookCommand(eventName: string): string {
  return [
    `PORT="\${AGENTDECK_PORT:-}"`,
    `if [ -z "$PORT" ]; then`,
    `  for F in "$HOME/.agentdeck/daemon.json" "$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json" "$HOME/Library/Group Containers/group.bound.serendipity.agent.deck/daemon.json"; do`,
    `    [ -f "$F" ] || continue`,
    `    P=$(python3 -c "import json;d=json.load(open('$F'));print(d.get('httpPort') or d.get('port',''))" 2>/dev/null)`,
    `    [ -n "$P" ] && curl -sf --max-time 0.3 "http://127.0.0.1:$P/health" >/dev/null 2>&1 && { PORT="$P"; break; }`,
    `  done`,
    `fi`,
    `PORT="\${PORT:-9120}"`,
    `curl -sf -X POST "http://127.0.0.1:$PORT/hooks/${eventName}" -H 'Content-Type: application/json' -d @- 2>/dev/null || true`,
  ].join('\n');
}

function buildHookEntry(eventName: string) {
  const needsToolMatcher = ['PreToolUse', 'PostToolUse'].includes(eventName);
  return {
    matcher: needsToolMatcher ? '*' : '',
    hooks: [{ type: 'command', command: buildHookCommand(eventName) }],
  };
}

function applyHooks(settings: any): any {
  if (!settings.hooks) settings.hooks = {};
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    settings.hooks[event] = settings.hooks[event].filter((h: any) => {
      if (h.command?.includes('AGENTDECK_PORT') || h.command?.includes('localhost:9120')) return false;
      if (Array.isArray(h.hooks) && h.hooks.some((hh: any) =>
        hh.command?.includes('AGENTDECK_PORT') || hh.command?.includes('localhost:9120')
      )) {
        return false;
      }
      return true;
    });
    settings.hooks[event].push(buildHookEntry(event));
  }
  return settings;
}

function migrateHooks(settings: any): { settings: any; migrated: boolean } {
  let migrated = false;
  if (!settings.hooks) return { settings, migrated };

  for (const event of Object.keys(settings.hooks)) {
    const hooks = settings.hooks[event];
    if (!Array.isArray(hooks)) continue;
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];

      if (hook.command?.includes('localhost:9120') && !hook.command?.includes('AGENTDECK_PORT')) {
        hook.command = hook.command.replace(
          /localhost:9120/g,
          'localhost:${AGENTDECK_PORT:-9120}',
        );
        migrated = true;
      }

      if (hook.type === 'command' && hook.command?.includes('AGENTDECK_PORT') && !hook.hooks) {
        hooks[i] = { matcher: '', hooks: [{ type: hook.type, command: hook.command }] };
        migrated = true;
      }

      if (Array.isArray(hook.hooks)) {
        for (const inner of hook.hooks) {
          if (inner.command?.includes('localhost:9120') && !inner.command?.includes('AGENTDECK_PORT')) {
            inner.command = inner.command.replace(
              /localhost:9120/g,
              'localhost:${AGENTDECK_PORT:-9120}',
            );
            migrated = true;
          }
        }
      }
    }
  }
  return { settings, migrated };
}

export function migrateHooksIfNeeded(): void {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.local.json');
    if (!existsSync(settingsPath)) return;

    const raw = readFileSync(settingsPath, 'utf-8');
    if (!raw.includes('AGENTDECK_PORT') && !raw.includes('localhost:9120')) return;

    const settings = JSON.parse(raw);
    let { migrated } = migrateHooks(settings);

    if (raw.includes('AGENTDECK_PORT') && !raw.includes('daemon.json')) {
      applyHooks(settings);
      migrated = true;
    }

    if (migrated) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } catch {
    // Best effort only; hook migration must not block session startup.
  }
}
