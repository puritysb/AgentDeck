import { describe, it, expect } from 'vitest';
import {
  parseTmuxPanes, buildItermSelectScript, buildTerminalAppSelectTabScript,
  buildPostKeysScript, buildAppButtonPressScript, buildAppKeysScript,
  escapeAppleScript,
} from '../observed-inject.js';
import { parseProcessTable, appNameFromCommand, resolveHostApp } from '../passive-observer.js';

describe('parseTmuxPanes', () => {
  it('maps pane ttys (dev-prefix stripped) to pane ids', () => {
    const out = '/dev/ttys004\t%1\n/dev/ttys008\t%3\n';
    const map = parseTmuxPanes(out);
    expect(map.get('ttys008')).toBe('%3');
    expect(map.get('ttys004')).toBe('%1');
  });

  it('ignores malformed lines', () => {
    expect(parseTmuxPanes('garbage\n\n').size).toBe(0);
  });
});

describe('buildItermSelectScript', () => {
  it('targets the session by tty and types Down x index then Enter', () => {
    const s = buildItermSelectScript('ttys008', 2);
    expect(s).toContain('if tty of s is "/dev/ttys008"');
    expect(s.match(/character id 27/g)?.length).toBe(2);
    expect(s).toContain('write s text ""');
  });

  it('index 0 is a bare Enter', () => {
    const s = buildItermSelectScript('ttys001', 0);
    expect(s).not.toContain('character id 27');
    expect(s).toContain('write s text ""');
  });

  // Measured 2026-08-06 on a live picker: arrows and the Enter that acts on
  // them, delivered as one burst, make the TUI answer with the option the
  // cursor was on BEFORE the arrows — every device answer silently became
  // option 0. The caller sends them as separate, paced calls, so the arrow
  // script must be able to omit its Enter.
  it('can emit the arrows without the Enter that would act on them', () => {
    const s = buildItermSelectScript('ttys008', 2, { enter: false });
    expect(s.match(/character id 27/g)?.length).toBe(2);
    expect(s).not.toContain('write s text ""');
  });
});

describe('parseProcessTable with tty column', () => {
  it('parses tty and treats ?? as none', () => {
    const out = '  123   1  1000 ttys008 claude\n  456   1  2000 ?? claude daemon run\n';
    const rows = parseProcessTable(out);
    expect(rows[0].tty).toBe('ttys008');
    expect(rows[1].tty).toBeUndefined();
  });
});

describe('buildTerminalAppSelectTabScript', () => {
  it('selects the tab by tty without activating the app', () => {
    const s = buildTerminalAppSelectTabScript('ttys003');
    expect(s).toContain('if tty of t is "/dev/ttys003"');
    expect(s).toContain('set selected of t to true');
    // focus-free: selecting a tab must never raise Terminal
    expect(s).not.toContain('activate');
  });

  it('returns notfound when no tab matches', () => {
    expect(buildTerminalAppSelectTabScript('ttys009')).toContain('return "notfound"');
  });
});

describe('buildPostKeysScript', () => {
  it('matches by bundle id first, then localized name', () => {
    const s = buildPostKeysScript({ bundleIds: ['com.apple.Terminal'], names: ['Terminal', '터미널'] }, 2);
    const bundleAt = s.indexOf('wantBundles.indexOf');
    const nameAt = s.indexOf('wantNames.indexOf');
    expect(bundleAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(bundleAt);
    expect(s).toContain('"com.apple.Terminal"');
    expect(s).toContain('터미널');
  });

  it('posts to the pid (never activates) and ends with Return', () => {
    const s = buildPostKeysScript({ bundleIds: ['com.openai.chat'] }, 3);
    expect(s).toContain('CGEventPostToPid');
    expect(s).toContain('for (let i = 0; i < 3; i++) key(125)');
    expect(s).toContain('key(36)');
    expect(s).not.toContain('activate');
  });

  // A grouped AskUserQuestion does not close on its last answer: it shows a
  // "Review your answers → Submit answers" confirmation. Nobody is at that
  // screen when a device answered, so the last selection carries a second
  // Return. Single-question prompts must NOT get one — it would land in the
  // prompt box as an empty submit.
  it('carries a second Return only when a grouped prompt needs submitting', () => {
    expect(buildPostKeysScript({ bundleIds: ['com.apple.Terminal'] }, 1, 2))
      .toContain('i < 2; i++) { key(36)');
    expect(buildPostKeysScript({ bundleIds: ['com.apple.Terminal'] }, 1))
      .toContain('i < 1; i++) { key(36)');
  });
});

describe('buildAppButtonPressScript', () => {
  it('matches the button by label with prefix tolerance and clicks it', () => {
    const s = buildAppButtonPressScript('ChatGPT', 'Allow once');
    expect(s).toContain('tell process "ChatGPT"');
    expect(s).toContain('bt is "Allow once"');
    expect(s).toContain('bt starts with "Allow once"');
    expect(s).toContain('click target');
    // AXPress path must never raise the app
    expect(s).not.toContain('activate');
  });

  it('escapes quotes in labels', () => {
    expect(buildAppButtonPressScript('Claude', 'Say "hi"')).toContain('Say \\"hi\\"');
  });
});

describe('buildAppKeysScript', () => {
  it('raises the app, keys, and restores the previous frontmost app', () => {
    const s = buildAppKeysScript('Claude', 1);
    expect(s).toContain('tell application "Claude" to activate');
    expect(s.match(/key code 125/g)?.length).toBe(1);
    expect(s).toContain('tell application prevApp to activate');
  });
});

describe('escapeAppleScript', () => {
  it('escapes backslashes and quotes', () => {
    expect(escapeAppleScript('a\\b"c')).toBe('a\\\\b\\"c');
  });
});

describe('app-host resolution', () => {
  it('extracts the app name from a bundle path', () => {
    expect(appNameFromCommand('/Applications/ChatGPT.app/Contents/Resources/codex app-server'))
      .toBe('ChatGPT');
    expect(appNameFromCommand('/Users/me/.local/bin/claude')).toBeUndefined();
  });

  it('walks the ancestry to find the hosting app', () => {
    const rows = parseProcessTable([
      ' 100 1 1000 ?? /Applications/Claude.app/Contents/MacOS/Claude',
      ' 200 100 1000 ?? /Users/me/.local/bin/node helper.js',
      ' 300 200 1000 ?? /Users/me/.local/bin/claude',
    ].join('\n'));
    const byPid = new Map(rows.map((p) => [p.pid, p]));
    expect(resolveHostApp(300, byPid)).toBe('Claude');
  });

  it('returns undefined for a plain terminal session', () => {
    const rows = parseProcessTable([
      ' 10 1 1000 ttys001 -zsh',
      ' 20 10 1000 ttys001 /Users/me/.local/bin/claude',
    ].join('\n'));
    const byPid = new Map(rows.map((p) => [p.pid, p]));
    expect(resolveHostApp(20, byPid)).toBeUndefined();
  });
});
