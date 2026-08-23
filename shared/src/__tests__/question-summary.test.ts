// `summarizeQuestionForKey` — how a permission question is cut to fit a key.
//
// The rule exists because a head cut is the WORST cut for this string class.
// Every one of these questions is a shell command; a command puts its verb
// first and its object last, so `slice(0, 18)` keeps the part every request
// shares and drops the only part that identifies THIS one. Measured on real
// OpenClaw traffic (2026-08-23) the deck key read `sed -n '20,35p' ~…` — the
// path, and therefore the file, cut off at exactly the byte it began.
import { describe, it, expect } from 'vitest';
import { summarizeQuestionForKey } from '../svg-renderers/session-slot-renderer.js';

describe('summarizeQuestionForKey', () => {
  it('keeps the verb and the object, dropping the middle', () => {
    const q = "sed -n '20,35p' ~/github/OpenClaw/yt_dubber/config.py";
    const out = summarizeQuestionForKey(q, 18);
    expect(out).toBe('sed … config.py');
    expect(out.length).toBeLessThanOrEqual(18);
  });

  it('takes the object of the VERB it kept, not of a later pipeline stage', () => {
    // Backward-scanning would answer `serve.py` here and render `sed … serve.py`
    // — a pair that never appeared together, which is a wrong reading rather
    // than a partial one.
    const q = "sed -n '1,60p' ~/a/config.py; echo '=== x ==='; grep -n PORT ~/a/serve.py | head";
    expect(summarizeQuestionForKey(q, 18)).toBe('sed … config.py');
  });

  it('drops the verb before it drops the object when both will not fit', () => {
    const q = "sed -n '90,135p' ~/github/OpenClaw/scripts/health-check.sh";
    expect(summarizeQuestionForKey(q, 18)).toBe('health-check.sh');
  });

  it('surfaces the target of a destructive command — the case a head cut hid', () => {
    // `rm -rf /tmp/buil…` is the shape that made a head cut dangerous, not just
    // uninformative: the user approves a verb whose object they never saw.
    expect(summarizeQuestionForKey('rm -rf /tmp/build-cache', 18)).toBe('rm … build-cache');
  });

  it('does not mistake a flag or a quoted range for the object', () => {
    // `-n`, `'20,35p'` and `--include="*.py"` are not objects; only a path or a
    // filename is.
    const q = 'grep -rn -i "cloudflared" ~/github/OpenClaw --include="*.py"';
    expect(summarizeQuestionForKey(q, 18)).toBe('grep … OpenClaw');
  });

  it('returns a fitting string untouched — the elision must buy something', () => {
    expect(summarizeQuestionForKey('npm install', 18)).toBe('npm install');
    expect(summarizeQuestionForKey('Bash(git status)', 18)).toBe('Bash(git status)');
  });

  it('falls back to a plain head cut when there is no path-like object', () => {
    const q = 'please confirm you want to proceed with the whole migration now';
    const out = summarizeQuestionForKey(q, 18);
    expect(out.length).toBe(18);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is total on empty and degenerate input', () => {
    expect(summarizeQuestionForKey('', 18)).toBe('');
    expect(summarizeQuestionForKey('short', 18)).toBe('short');
    expect(summarizeQuestionForKey('anything at all', 0)).toBe('');
  });
});
