/**
 * Behavior gate for the Claude permission predictor. The vector file is the
 * contract both daemons replay (Swift: ClaudePermissionRulesTests); the unit
 * cases below pin the pieces the vectors exercise only indirectly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  bashRuleMatches,
  splitCompoundCommand,
  stripCommandWrappers,
  isBuiltinReadOnlyCommand,
  isAcceptEditsFsCommand,
  evaluatePermissionRules,
  predictPreToolUseHold,
  shouldGatePreToolUse,
  gateSignature,
  globMatch,
  GATE_LEARN_WINDOW_MS,
  type MergedPermissionRules,
} from '../claude-permission-rules.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Vector {
  note: string;
  tool: string;
  command: string | null;
  mode: string | null;
  rules: MergedPermissionRules | null;
  hold: boolean;
}

describe('claude permission vectors (shared with the Swift suite)', () => {
  const vectors = JSON.parse(
    readFileSync(join(repoRoot, 'shared', 'claude-permission-vectors.json'), 'utf8'),
  ) as Vector[];

  it('is large enough to be a gate', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
  });

  for (const v of vectors) {
    it(v.note, () => {
      const prediction = predictPreToolUseHold({
        tool: v.tool,
        toolInput: v.command == null ? {} : { command: v.command },
        permissionMode: v.mode ?? undefined,
        rules: v.rules,
      });
      expect(prediction.hold, prediction.reason).toBe(v.hold);
    });
  }
});

describe('bashRuleMatches — documented wildcard table', () => {
  const table: Array<[string, string, boolean]> = [
    ['npm run build', 'npm run build', true],
    ['npm run build', 'npm run build --watch', false],
    ['npm run *', 'npm run build', true],
    ['npm run *', 'npm run test --watch', true],
    ['npm run *', 'npm run', true],
    ['npm run *', 'npm install', false],
    ['git log * main', 'git log --oneline main', true],
    ['git log * main', 'git log -5 main', true],
    ['git log * main', 'git log main', false],
    ['git log * main', 'git push origin main', false],
    ['git * main', 'git merge main', true],
    ['git * main', 'git -c core.fsmonitor=x diff main', true],
    ['git * main', 'git log', false],
    ['* --version', 'node --version', true],
    ['* --version', "bash -c 'echo hi' --version", true],
    ['* --version', 'node -v', false],
    ['ls *', 'ls -la', true],
    ['ls *', 'ls', true],
    ['ls *', 'lsof', false],
    ['ls*', 'ls -la', true],
    ['ls*', 'lsof', true],
    ['* --help *', 'npm --help x', true],
    ['* --help *', 'npm --help', false],
    ['ls:*', 'ls -la', true],
    ['ls:*', 'ls', true],
    ['ls:*', 'lsof', true], // raw-prefix reading kept: over-matching only costs a missed hold
    ['npm run test:*', 'npm run test:watch', true],
    ['*', 'anything at all', true],
  ];
  for (const [spec, command, expected] of table) {
    it(`Bash(${spec}) ${expected ? 'matches' : 'does not match'} "${command}"`, () => {
      expect(bashRuleMatches(spec, command)).toBe(expected);
    });
  }

  it('globMatch is linear on adversarial input (many wildcards, long text)', () => {
    const pattern = 'a*a*a*a*a*a*a*a*a*b';
    const text = 'a'.repeat(5000);
    const started = Date.now();
    expect(globMatch(pattern, text)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('splitCompoundCommand', () => {
  it('splits on every documented operator', () => {
    expect(splitCompoundCommand('a && b || c ; d | e |& f & g\nh')).toEqual(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    );
  });
  it('keeps operators inside quotes', () => {
    expect(splitCompoundCommand('grep "a|b" x; echo \'c&&d\'')).toEqual(['grep "a|b" x', "echo 'c&&d'"]);
  });
  it('refuses heredocs, substitutions and unbalanced quotes', () => {
    expect(splitCompoundCommand("cat <<'EOF'\nx\nEOF")).toBeNull();
    expect(splitCompoundCommand('echo $(rm -rf /)')).toBeNull();
    expect(splitCompoundCommand('echo `ls`')).toBeNull();
    expect(splitCompoundCommand('echo "unterminated')).toBeNull();
  });
  it('refuses an operator with nothing after it', () => {
    expect(splitCompoundCommand('npm test &&')).toBeNull();
  });
});

describe('wrapper stripping and built-in sets', () => {
  it('strips env assignments and wrappers', () => {
    expect(stripCommandWrappers('LANG=C NO_COLOR=1 timeout 30 npm test')).toBe('npm test');
    expect(stripCommandWrappers('nice -n 10 nohup make')).toBe('make');
    expect(stripCommandWrappers('xargs grep pattern')).toBe('grep pattern');
    expect(stripCommandWrappers('xargs -n1 grep pattern')).toBe('xargs -n1 grep pattern');
  });
  it('recognises the documented read-only set and its git forms', () => {
    for (const c of ['ls -la', 'cat x', 'git status', 'git log -5', 'git diff HEAD~1', 'git branch', 'git branch -a', 'wc -l *.py']) {
      expect(isBuiltinReadOnlyCommand(c), c).toBe(true);
    }
    for (const c of ['git branch x', 'git push', 'find . -delete *', 'ls > x', 'npm test', 'git checkout -- .']) {
      expect(isBuiltinReadOnlyCommand(c), c).toBe(false);
    }
  });
  it('recognises the acceptEdits filesystem commands', () => {
    expect(isAcceptEditsFsCommand('mkdir -p x')).toBe(true);
    expect(isAcceptEditsFsCommand('LANG=C sed -i s/a/b/ f')).toBe(true);
    expect(isAcceptEditsFsCommand('npm test')).toBe(false);
  });
});

describe('evaluatePermissionRules', () => {
  const rules = { allow: ['Bash(git *)'], deny: ['Bash(git push *)'], ask: ['Bash(git rebase *)'] };
  it('deny outranks allow', () => {
    expect(evaluatePermissionRules('Bash', 'git push origin x', rules)).toBe('deny');
  });
  it('ask outranks allow', () => {
    expect(evaluatePermissionRules('Bash', 'git rebase main', rules)).toBe('ask');
  });
  it('allow covers the rest', () => {
    expect(evaluatePermissionRules('Bash', 'git fetch', rules)).toBe('allow');
  });
  it('unknown when rules are unreadable', () => {
    expect(evaluatePermissionRules('Bash', 'git fetch', null)).toBe('unknown');
  });
  it('none when nothing decides', () => {
    expect(evaluatePermissionRules('Bash', 'npm test', rules)).toBe('none');
  });
});

describe('mode gate, signature, learn window', () => {
  it('gates only default/acceptEdits (non-edit) calls', () => {
    expect(shouldGatePreToolUse(undefined, 'Bash')).toBe(true);
    expect(shouldGatePreToolUse('acceptEdits', 'Edit')).toBe(false);
    expect(shouldGatePreToolUse('acceptEdits', 'Bash')).toBe(true);
    for (const m of ['auto', 'plan', 'dontAsk', 'bypassPermissions']) {
      expect(shouldGatePreToolUse(m, 'Bash')).toBe(false);
    }
  });
  it('signature is the first two Bash tokens', () => {
    expect(gateSignature('Bash', { command: '  git push origin main' })).toBe('Bash|git push');
    expect(gateSignature('Edit', { file_path: 'x' })).toBe('Edit');
  });
  it('learn window outlasts a slow tool (was 8 s, which a curl fetch exceeds)', () => {
    expect(GATE_LEARN_WINDOW_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
