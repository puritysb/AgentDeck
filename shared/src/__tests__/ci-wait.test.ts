import { describe, expect, it } from 'vitest';
import { CI_WAIT_MAX_COMMAND_CHARS, classifyCiWaitIntent } from '../ci-wait.js';

describe('CI wait command evidence', () => {
  it.each([
    ['gh pr checks 456 --watch --interval 30 > /tmp/checks.log 2>&1',
      { mode: 'watch', pr: 456 }],
    ['gh run watch 37251975190 --exit-status --repo puritysb/AgentDeck',
      { mode: 'watch', runId: 37251975190, repo: 'puritysb/AgentDeck' }],
    ['command /opt/homebrew/bin/gh -R puritysb/AgentDeck pr checks 433 --watch',
      { mode: 'watch', pr: 433, repo: 'puritysb/AgentDeck' }],
    ['GH_PAGER=cat gh pr checks https://github.com/puritysb/AgentDeck/pull/433 --watch',
      { mode: 'watch', pr: 433, repo: 'puritysb/AgentDeck' }],
    ['until gh pr checks 432 --required; do sleep 30; done',
      { mode: 'poll', pr: 432 }],
    ['while true; do gh run list --branch codex/ci-wait-evidence --json status --limit 1; sleep 30; done',
      { mode: 'poll', ref: 'codex/ci-wait-evidence' }],
    ['while ! gh pr checks --repo=puritysb/AgentDeck --json state; do sleep 30; done',
      { mode: 'poll', repo: 'puritysb/AgentDeck' }],
    ['until gh run list -b "codex/ci-wait-evidence" -q ".[] | .status" --json status; do sleep 30; done',
      { mode: 'poll', ref: 'codex/ci-wait-evidence' }],
    ['gh pr checks codex/ci-wait-evidence --watch',
      { mode: 'watch', ref: 'codex/ci-wait-evidence' }],
  ])('classifies an executable background intent: %s', (command, fields) => {
    expect(classifyCiWaitIntent(command, true)).toEqual({
      kind: 'ci', provider: 'github-actions', ...fields,
    });
  });

  it.each([
    'gh pr checks 456', 'gh run list --branch master',
    'echo "gh pr checks 456 --watch"', "printf '%s' 'gh run watch 42'",
    '# gh run watch 42', 'echo test # ignored; gh run watch 42',
    'echo while; gh run list --branch master',
    "'while' true; gh run list --branch master", 'gh api repos/a/b/actions/runs',
    'gh pr checks 456 --watch=false', 'gh pr checks 456 --watchdog',
    'gh run watch', 'gh run watch 0', 'gh run watch 9007199254740992',
    'gh pr checks 9007199254740992 --watch',
    'gh pr checks https://github.com/a/b/pull/9007199254740992 --watch',
    'gh pr checks https://github.com/a/b/pull/42 --watch --repo c/d',
    'gh run watch 42 --json status',
    'gh pr checks 42 --watch --branch master',
    'while true; do gh run list --exit-status; done',
    'gh pr checks 1 --watch && gh pr checks 2 --watch',
    'while true; do gh pr checks 456; sleep 30',
    'while gh pr checks 456; done', 'do gh run watch 42',
    'done; gh run watch 42', 'gh run watch 42 &&',
    'gh run watch 42 |', 'gh run watch 42 --unknown-flag',
    'gh run watch 42 --interval', 'gh run watch 42 "unterminated',
    'echo $(gh run watch 42)', "sh -c 'gh run watch 42'",
    'cat <<EOF\ngh run watch 42\nEOF',
    '"NOT_AN_ASSIGNMENT=1" gh run watch 42',
  ])('does not invent a wait: %s', command => {
    expect(classifyCiWaitIntent(command, true)).toBeNull();
  });

  it('requires an explicit boolean background flag and bounded valid input', () => {
    for (const value of [false, undefined, 'true', 1]) {
      expect(classifyCiWaitIntent('gh run watch 42', value)).toBeNull();
    }
    for (const value of [null, {}, 42, 'gh run watch 42\0', 'x'.repeat(CI_WAIT_MAX_COMMAND_CHARS + 1)]) {
      expect(classifyCiWaitIntent(value, true)).toBeNull();
    }
  });

  it('does not infer a repo/run or carry credentials, arguments or output', () => {
    expect(classifyCiWaitIntent('GH_TOKEN=secret gh pr checks --watch --json state --jq secret', true))
      .toEqual({ kind: 'ci', provider: 'github-actions', mode: 'watch' });
    expect(classifyCiWaitIntent('gh pr checks --watch --repo https://secret@example.test/a/b', true))
      .toEqual({ kind: 'ci', provider: 'github-actions', mode: 'watch' });
  });

  it('keeps loop scope separate from subsequent one-shot reads', () => {
    expect(classifyCiWaitIntent('while true; do echo waiting; done; gh pr checks 42', true)).toBeNull();
    expect(classifyCiWaitIntent('while true; do gh pr checks 42; done; gh pr checks 43', true)?.pr).toBe(42);
  });
});
