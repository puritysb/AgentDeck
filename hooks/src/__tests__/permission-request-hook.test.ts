/**
 * Claude Code's `PermissionRequest` hook as a display signal.
 *
 * Claude Code runs it the moment it is about to draw its permission dialog
 * (https://code.claude.com/docs/en/hooks — "Runs when Claude Code is about to
 * ask you for permission to use a tool"), while the `permission_prompt`
 * Notification waits for about six seconds without typing. AgentDeck installs
 * it fire-and-forget: it must return at once and print nothing, because a
 * printed `hookSpecificOutput.decision` would answer the dialog and Claude Code
 * waits for the hook before showing it.
 *
 * The three writers (`@agentdeck/hooks`, `@agentdeck/setup`, Swift
 * `HookInstaller`) co-own `~/.claude/settings.json`, so the event list and the
 * tool-matcher list must agree in all three or they rewrite each other's hooks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  HOOK_EVENTS,
  applyHooks,
  buildHookCommand,
  buildHookEntry,
  claudeSettingsPaths,
  hasUnboundedHookCurl,
  migrateHooksIfNeeded,
} from '../install.js';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Quoted names in the first `[ … ]` after `anchor`. */
function quotedList(source: string, anchor: string): string[] {
  const at = source.indexOf(anchor);
  expect(at, anchor).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('[', at);
  const close = source.indexOf(']', open);
  return [...source.slice(open, close).matchAll(/['"]([A-Za-z]+)['"]/g)].map((m) => m[1]);
}

describe('PermissionRequest in the three co-owned hook writers', () => {
  const writers = {
    hooks: read('hooks/src/install.ts'),
    setup: read('setup/src/setup.ts'),
    swift: read('apple/AgentDeck/Daemon/Core/HookInstaller.swift'),
  };

  it('installs the same events, in the same order, from every writer', () => {
    expect(HOOK_EVENTS).toContain('PermissionRequest');
    expect(quotedList(writers.hooks, 'export const HOOK_EVENTS')).toEqual([...HOOK_EVENTS]);
    expect(quotedList(writers.setup, 'const HOOK_EVENTS')).toEqual([...HOOK_EVENTS]);
    expect(quotedList(writers.swift, 'private static let hookEvents')).toEqual([...HOOK_EVENTS]);
  });

  it('gives PermissionRequest the tool matcher in every writer, as its event matches on the tool name', () => {
    const expected = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];
    expect(quotedList(writers.hooks, 'const needsToolMatcher')).toEqual(expected);
    expect(quotedList(writers.setup, 'const needsToolMatcher')).toEqual(expected);
    expect(quotedList(writers.swift, 'let needsToolMatcher')).toEqual(expected);
    expect(buildHookEntry('PermissionRequest').matcher).toBe('*');
    expect(buildHookEntry('PermissionRequest').hooks).toHaveLength(1);
  });

  it('is the bounded fire-and-forget form, which no writer special-cases', () => {
    const cmd = buildHookCommand('PermissionRequest');
    expect(cmd).not.toContain('RESP=');
    expect(cmd).not.toContain('printf');
    expect(cmd).toContain('curl -sf --connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/hooks/PermissionRequest"');
    expect(cmd).toContain('-d @- >/dev/null 2>&1 || true');
    expect(cmd).toContain('-H "X-AgentDeck-Pid: $PPID"');
    // Only PreToolUse and Stop are request-response in any writer; a writer
    // branching on PermissionRequest would have drifted from the others.
    for (const source of Object.values(writers)) {
      expect(source).not.toMatch(/eventName === 'PermissionRequest'|event == "PermissionRequest"/);
    }
  });

  it.skipIf(process.platform === 'win32')('prints nothing even when the daemon answers with a body', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentdeck-permreq-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      const capture = join(home, 'curl.log');
      // A daemon that answered a decision-shaped body: the hook must still
      // print nothing, or Claude would read it as the dialog's answer.
      writeFileSync(join(bin, 'curl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CAPTURE_FILE"
cat >/dev/null
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
`);
      chmodSync(join(bin, 'curl'), 0o755);
      const out = execFileSync('/bin/sh', ['-c', buildHookCommand('PermissionRequest')], {
        env: { ...process.env, HOME: home, AGENTDECK_PORT: '19999', CAPTURE_FILE: capture, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
        input: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }),
        encoding: 'utf8',
      });
      expect(out).toBe('');
      expect(readFileSync(capture, 'utf8')).toContain('http://127.0.0.1:19999/hooks/PermissionRequest');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('migration 13 — installs PermissionRequest into existing installs', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentdeck-hooks-m13-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const ownPermissionHook = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-approver' }] };

  it('adds AgentDeck\'s hook next to a user\'s own PermissionRequest hook, then leaves the file alone', () => {
    const { settings: settingsPath } = claudeSettingsPaths(home);
    const current = applyHooks({}, home);
    // An install from before this change: every current hook, but the
    // PermissionRequest slot holds only the user's own approver.
    current.hooks.PermissionRequest = [ownPermissionHook];
    writeFileSync(settingsPath, JSON.stringify(current, null, 2) + '\n');

    migrateHooksIfNeeded(home);
    const migrated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(migrated.hooks.PermissionRequest).toHaveLength(2);
    expect(migrated.hooks.PermissionRequest[0]).toEqual(ownPermissionHook);
    expect(migrated.hooks.PermissionRequest[1]).toEqual(buildHookEntry('PermissionRequest', home));
    expect(hasUnboundedHookCurl(migrated)).toBe(false);

    const once = readFileSync(settingsPath, 'utf8');
    migrateHooksIfNeeded(home);
    expect(readFileSync(settingsPath, 'utf8')).toBe(once);
  });

  it('adds it to an install that has no PermissionRequest slot at all', () => {
    const { settings: settingsPath } = claudeSettingsPaths(home);
    const current = applyHooks({}, home);
    delete current.hooks.PermissionRequest;
    writeFileSync(settingsPath, JSON.stringify(current, null, 2) + '\n');
    migrateHooksIfNeeded(home);
    const migrated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(migrated.hooks.PermissionRequest).toEqual([buildHookEntry('PermissionRequest', home)]);
  });
});
