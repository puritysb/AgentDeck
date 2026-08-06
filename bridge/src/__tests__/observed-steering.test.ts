// Precision guard for the observed-session steering primitives. The single
// most important property under test: the PreToolUse gate must NEVER hold a
// tool call Claude would auto-approve (allowlist rules, permission modes,
// never-prompt tools, session "always allow") — the false-attention bug that
// got the first gate removed. Every uncertainty must resolve to "don't hold".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  shouldHoldPreToolUse, beginAskGate, gateReleased, buildGateQuestion,
  buildAskAnswerReason, gateSignature,
  requestStop, clearStop, isStopRequested, consumeStop,
  queueDirective, takeDirective, queuedDirectiveCount, clearOnUserPrompt,
  notePermissionPromptShown, noteToolEnd, steeringSnapshot,
  _resetSteering,
} from '../observed-steering.js';
import {
  evaluatePermissionRules, _setHomeOverrideForTests, _clearRulesCache,
} from '../claude-permission-rules.js';

let fixtureRoot: string;
let homeDir: string;
let cwd: string;

function writeSettings(dir: string, file: string, permissions: Record<string, string[]>): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', file), JSON.stringify({ permissions }, null, 2));
}

function baseCtx(overrides: Partial<Parameters<typeof shouldHoldPreToolUse>[0]> = {}) {
  return {
    sessionId: 'sid-1',
    tool: 'Bash',
    toolInput: { command: 'git push origin master' },
    permissionMode: 'default',
    cwd,
    clientCount: 1,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  _resetSteering();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'agentdeck-steering-'));
  homeDir = join(fixtureRoot, 'home');
  cwd = join(fixtureRoot, 'project');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  _setHomeOverrideForTests(homeDir);
});

afterEach(() => {
  _setHomeOverrideForTests(null);
  _clearRulesCache();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('shouldHoldPreToolUse — precision guards (never hold auto-approved calls)', () => {
  it('holds a prompt-prone Bash call with no matching rules (the genuine-wait case)', () => {
    const d = shouldHoldPreToolUse(baseCtx());
    expect(d.hold).toBe(true);
    expect(d.requestId).toBeTruthy();
  });

  it('never holds when disabled', () => {
    expect(shouldHoldPreToolUse(baseCtx({ enabled: false })).hold).toBe(false);
  });

  it('never holds with zero connected clients (nobody can answer)', () => {
    expect(shouldHoldPreToolUse(baseCtx({ clientCount: 0 })).hold).toBe(false);
  });

  it('never holds never-prompt tools (Read/Glob/Grep/TodoWrite)', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'TodoWrite']) {
      expect(shouldHoldPreToolUse(baseCtx({ tool, toolInput: {} })).hold).toBe(false);
    }
  });

  it('never holds MCP tools (per-server trust state is invisible)', () => {
    expect(shouldHoldPreToolUse(baseCtx({ tool: 'mcp__github__create_issue', toolInput: {} })).hold).toBe(false);
  });

  it('never holds unknown tools (not in the prompt-prone set)', () => {
    expect(shouldHoldPreToolUse(baseCtx({ tool: 'SomeFutureTool', toolInput: {} })).hold).toBe(false);
  });

  it('never holds in auto-approving permission modes', () => {
    for (const mode of ['bypassPermissions', 'dontAsk', 'auto', 'plan']) {
      expect(shouldHoldPreToolUse(baseCtx({ permissionMode: mode })).hold).toBe(false);
    }
  });

  it('acceptEdits: never holds edit-family tools, still holds Bash', () => {
    expect(shouldHoldPreToolUse(baseCtx({
      permissionMode: 'acceptEdits', tool: 'Edit', toolInput: { file_path: '/x' },
    })).hold).toBe(false);
    expect(shouldHoldPreToolUse(baseCtx({ permissionMode: 'acceptEdits' })).hold).toBe(true);
  });

  it('never holds when a user-level allow rule prefix-matches the command', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['Bash(git push:*)'] });
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(false);
  });

  it('never holds when a PROJECT-LOCAL allow rule matches (session "always allow" persists here)', () => {
    writeSettings(cwd, 'settings.local.json', { allow: ['Bash(git push:*)'] });
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(false);
  });

  it('never holds on a bare tool-name allow rule', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['Bash'] });
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(false);
  });

  it('never holds a non-Bash tool when any allow rule exists for it (loose spec match)', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['WebFetch(domain:github.com)'] });
    expect(shouldHoldPreToolUse(baseCtx({
      tool: 'WebFetch', toolInput: { url: 'https://example.com' },
    })).hold).toBe(false);
  });

  it('never holds when a deny rule may match (Claude auto-denies without prompting)', () => {
    writeSettings(homeDir, 'settings.json', { deny: ['Bash(git push:*)'] });
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(false);
  });

  it('never holds when ANY settings file is unparseable (rule picture unknown)', () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'settings.json'), '{ not json');
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(false);
  });

  it('compound command: allow rule on the first segment suppresses the hold', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['Bash(git status:*)'] });
    expect(shouldHoldPreToolUse(baseCtx({
      toolInput: { command: 'git status && rm -rf /' },
    })).hold).toBe(false);
  });

  it('holds on a strict ask-rule match (Claude will definitely prompt)', () => {
    writeSettings(homeDir, 'settings.json', { ask: ['Bash(git push:*)'] });
    const d = shouldHoldPreToolUse(baseCtx());
    expect(d.hold).toBe(true);
    expect(d.reason).toContain('ask');
  });

  it('allows only one held gate per session (parallel tool calls pass through)', () => {
    const first = shouldHoldPreToolUse(baseCtx());
    expect(first.hold).toBe(true);
    expect(shouldHoldPreToolUse(baseCtx({ toolInput: { command: 'npm test' } })).hold).toBe(false);
  });
});

describe('auto-approval learner (session "always allow" is invisible — learn it)', () => {
  it('suppresses a signature after undecided release + tool_end with no permission prompt', () => {
    const d = shouldHoldPreToolUse(baseCtx());
    expect(d.hold).toBe(true);
    // Timeout release (pass) arms the learner; tool ran right after.
    gateReleased('sid-1', d.requestId!, { undecided: true, tool: 'Bash', toolInput: { command: 'git push origin master' } });
    noteToolEnd('sid-1', 'Bash');
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(false);
    expect(shouldHoldPreToolUse(baseCtx()).reason).toContain('learned');
  });

  it('does NOT suppress when a permission prompt was shown in between (genuine wait)', () => {
    const d = shouldHoldPreToolUse(baseCtx());
    gateReleased('sid-1', d.requestId!, { undecided: true, tool: 'Bash', toolInput: { command: 'git push origin master' } });
    notePermissionPromptShown('sid-1');
    noteToolEnd('sid-1', 'Bash');
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(true);
  });

  it('does NOT learn from device-decided releases', () => {
    const d = shouldHoldPreToolUse(baseCtx());
    gateReleased('sid-1', d.requestId!, { undecided: false, tool: 'Bash', toolInput: { command: 'git push origin master' } });
    noteToolEnd('sid-1', 'Bash');
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(true);
  });

  it('signature granularity: Bash uses the first two command tokens', () => {
    expect(gateSignature('Bash', { command: 'git push origin master' })).toBe('Bash|git push');
    expect(gateSignature('Edit', { file_path: '/x' })).toBe('Edit');
  });
});

describe('soft STOP', () => {
  it('consumeStop is one-shot', () => {
    requestStop('s');
    expect(isStopRequested('s')).toBe(true);
    expect(consumeStop('s')).toBe(true);
    expect(consumeStop('s')).toBe(false);
  });

  it('clearOnUserPrompt clears stop + directives (user took over)', () => {
    requestStop('s');
    queueDirective('s', 'continue');
    expect(clearOnUserPrompt('s')).toBe(true);
    expect(isStopRequested('s')).toBe(false);
    expect(queuedDirectiveCount('s')).toBe(0);
  });

  it('clearStop drops the flag without consuming semantics', () => {
    requestStop('s');
    expect(clearStop('s')).toBe(true);
    expect(isStopRequested('s')).toBe(false);
  });
});

describe('turn-end directive queue', () => {
  it('caps the queue and pops exactly one per takeDirective', () => {
    expect(queueDirective('s', 'a')).toBe(true);
    expect(queueDirective('s', 'b')).toBe(true);
    expect(queueDirective('s', 'c')).toBe(true);
    expect(queueDirective('s', 'd')).toBe(false); // cap 3
    expect(takeDirective('s')).toBe('a');
    expect(queuedDirectiveCount('s')).toBe(2);
  });

  it('rejects empty text', () => {
    expect(queueDirective('s', '   ')).toBe(false);
  });

  it('a pending STOP outranks directives: queue is discarded, nothing delivered', () => {
    queueDirective('s', 'continue');
    requestStop('s');
    expect(takeDirective('s')).toBeUndefined();
    expect(queuedDirectiveCount('s')).toBe(0);
  });

  it('empty queue always returns undefined (no stop_hook_active loop)', () => {
    expect(takeDirective('s')).toBeUndefined();
    expect(takeDirective('s')).toBeUndefined();
  });

  it('steeringSnapshot reflects both flags for device badges', () => {
    requestStop('s');
    queueDirective('s', 'x');
    // stop discards on take, but snapshot before take shows both
    expect(steeringSnapshot('s')).toEqual({ stopRequested: true, queuedDirectives: 1 });
  });
});

describe('evaluatePermissionRules verdicts', () => {
  it('none when no files exist', () => {
    expect(evaluatePermissionRules('Bash', { command: 'ls' }, cwd)).toBe('none');
  });

  it('exact vs prefix Bash specs', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['Bash(git status)'] });
    expect(evaluatePermissionRules('Bash', { command: 'git status' }, cwd)).toBe('allow');
    _clearRulesCache();
    expect(evaluatePermissionRules('Bash', { command: 'git status -sb' }, cwd)).toBe('none');
  });

  it('deny beats allow', () => {
    writeSettings(homeDir, 'settings.json', { allow: ['Bash'], deny: ['Bash(rm:*)'] });
    expect(evaluatePermissionRules('Bash', { command: 'rm -rf x' }, cwd)).toBe('deny');
  });

  it('ask rules never match loosely on unparseable specs (no over-holding)', () => {
    writeSettings(homeDir, 'settings.json', { ask: ['WebFetch(domain:evil.com)'] });
    expect(evaluatePermissionRules('WebFetch', { url: 'https://x.com' }, cwd)).toBe('none');
  });
});

// The permission gate's precision guards exist because PreToolUse fires for
// calls Claude auto-approves without ever prompting. AskUserQuestion is the
// opposite — it always prompts — so the ask-gate deliberately skips them, which
// is also what makes it work in the sandboxed daemon that cannot read ~/.claude.
describe('beginAskGate (AskUserQuestion always prompts — no precision guards)', () => {
  const askCtx = (o: Partial<Parameters<typeof beginAskGate>[0]> = {}) =>
    ({ sessionId: 'sid-ask', clientCount: 1, enabled: true, ...o });

  it('holds without consulting permission rules or the prompt-prone set', () => {
    // An allow rule covering everything would suppress a permission hold…
    writeSettings(homeDir, 'settings.json', { allow: ['Bash', 'AskUserQuestion'] });
    expect(shouldHoldPreToolUse(baseCtx()).hold).toBe(false);
    // …but cannot stop the picker appearing, so the ask-gate still holds.
    expect(beginAskGate(askCtx()).hold).toBe(true);
  });

  it('holds even where the rule surface is unreadable (the sandbox case)', () => {
    _setHomeOverrideForTests(join(fixtureRoot, 'does-not-exist'));
    _clearRulesCache();
    expect(beginAskGate(askCtx()).hold).toBe(true);
  });

  it('never holds when disabled or with nobody to answer', () => {
    expect(beginAskGate(askCtx({ enabled: false })).hold).toBe(false);
    expect(beginAskGate(askCtx({ clientCount: 0 })).hold).toBe(false);
  });

  it('keeps the one-gate-per-session invariant in both directions', () => {
    expect(beginAskGate(askCtx()).hold).toBe(true);
    expect(beginAskGate(askCtx()).hold).toBe(false);
    // A permission gate cannot slip in underneath a held ask-gate either.
    expect(shouldHoldPreToolUse(baseCtx({ sessionId: 'sid-ask' })).hold).toBe(false);
  });

  it('releases the session so the next question can hold again', () => {
    const first = beginAskGate(askCtx());
    gateReleased('sid-ask', first.requestId!, { undecided: false, tool: 'AskUserQuestion' });
    expect(beginAskGate(askCtx()).hold).toBe(true);
  });

  it('an unanswered ask teaches the auto-approval learner nothing', () => {
    const gate = beginAskGate(askCtx());
    // undecided:false is the contract — an ask timeout says nothing about what
    // Claude auto-approves, so it must not suppress any signature.
    gateReleased('sid-ask', gate.requestId!, { undecided: false, tool: 'AskUserQuestion' });
    noteToolEnd('sid-ask', 'AskUserQuestion');
    expect(shouldHoldPreToolUse(baseCtx({ sessionId: 'sid-ask' })).hold).toBe(true);
  });
});

describe('buildAskAnswerReason (the device answer reaching the agent)', () => {
  it('states every Q→A pair and forbids re-asking', () => {
    const reason = buildAskAnswerReason([
      { question: 'Pick a language', label: 'Swift' },
      { question: 'Ship it?', label: 'Yes' },
    ]);
    expect(reason).toContain('Q: Pick a language\nA: Swift');
    expect(reason).toContain('Q: Ship it?\nA: Yes');
    expect(reason).toContain('do not call AskUserQuestion again');
    // Must read as the user's own answer, not as a policy refusal.
    expect(reason).toContain("user's own answers");
  });

  it('drops groups that were never answered', () => {
    expect(buildAskAnswerReason([
      { question: 'Answered', label: 'A' },
      { question: 'Skipped', label: '' },
    ])).not.toContain('Skipped');
  });
});

describe('buildGateQuestion (device-native semantics, no TUI mirroring)', () => {
  it('previews the Bash command / file path / url', () => {
    expect(buildGateQuestion('Bash', { command: 'git push' })).toBe('Allow Bash: git push');
    expect(buildGateQuestion('Edit', { file_path: '/a/b.ts' })).toBe('Allow Edit: /a/b.ts');
    expect(buildGateQuestion('WebFetch', { url: 'https://x.com' })).toBe('Allow WebFetch: https://x.com');
    expect(buildGateQuestion('Write', {})).toBe('Allow Write?');
  });
});
