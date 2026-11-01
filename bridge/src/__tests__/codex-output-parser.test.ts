import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexOutputParser } from '../codex-output-parser.js';

describe('CodexOutputParser', () => {
  let parser: CodexOutputParser;

  beforeEach(() => {
    parser = new CodexOutputParser();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('terminal UI observation boundary', () => {
    it('does not infer lifecycle or tools, or schedule their timers', () => {
      const retired = vi.fn();
      for (const event of ['spinner_start', 'spinner_stop', 'idle', 'tool_action']) {
        parser.on(event, retired);
      }
      parser.feed('> \n');
      parser.feed('⠋ Thinking...\nWorking(0s • esc to interrupt)\n');
      parser.feed('Running: npm test\nReading src/main.ts\n');
      parser.feed('› next prompt\n');
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(retired).not.toHaveBeenCalled();
    });

    it('keeps the latest approval choices through idle and spinner redraws', () => {
      const approvals = vi.fn();
      parser.on('permission_prompt', approvals);
      parser.feed('Would you like to run the following command?\n$ npm test\n');
      vi.advanceTimersByTime(100);
      parser.feed('› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n');
      parser.feed('⠋ Working...\n');
      parser.feed('> \n');
      vi.advanceTimersByTime(149);
      expect(approvals).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(approvals).toHaveBeenCalledExactlyOnceWith({
        question: 'npm test', navigable: true, cursorIndex: 0,
        options: [
          { index: 0, label: 'Yes, proceed', shortcut: 'y' },
          { index: 1, label: 'No, and tell Codex what to do differently', shortcut: 'esc' },
        ],
      });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('permission prompt detection', () => {
    it.each([
      'The policy can approve or deny calls automatically.\n',
      'Tool output: Allow this command? Allow  Deny\n',
      'console.log("Allow once  Always allow  Deny")\n',
      'echo "Run this command? (y)es / (n)o"\n',
      'The old prompt was [Y/n], no choice is pending.\n',
      'Example: "Would you like to run the following command?"\n',
      'echo "Press enter to confirm or esc to cancel"\n',
    ])('ignores quoted prompts and approval prose in command output: %s', (output) => {
      const handler = vi.fn();
      parser.on('permission_prompt', handler);
      parser.feed(output);
      vi.advanceTimersByTime(500);
      expect(handler).not.toHaveBeenCalled();
    });

    it('emits permission_prompt on Allow/Deny pattern', () => {
      const handler = vi.fn();
      parser.on('permission_prompt', handler);

      parser.feed('> ');
      vi.advanceTimersByTime(300);

      parser.feed('Allow this command? Allow  Deny');
      vi.advanceTimersByTime(150);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].options).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'Deny' })]),
      );
    });

    it('emits permission_prompt on y/n pattern', () => {
      const handler = vi.fn();
      parser.on('permission_prompt', handler);

      parser.feed('Run this command? (y)es / (n)o');
      vi.advanceTimersByTime(150);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Yes' }),
          expect.objectContaining({ label: 'No' }),
        ]),
      );
    });

    it('extracts Allow once / Always allow options', () => {
      const handler = vi.fn();
      parser.on('permission_prompt', handler);

      parser.feed('Allow once  Always allow  Deny');
      vi.advanceTimersByTime(150);
      const opts = handler.mock.calls[0][0].options;
      expect(opts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Allow once' }),
          expect.objectContaining({ label: 'Always allow' }),
          expect.objectContaining({ label: 'Deny' }),
        ]),
      );
    });

    it('detects the current Codex command approval prompt as awaiting permission', () => {
      const handler = vi.fn();
      parser.on('permission_prompt', handler);

      parser.feed([
        'Would you like to run the following command?',
        '',
        '  Environment: local',
        '',
        '  Reason: Run the requested ips10 WiFi OTA round trip using the local pnpm agentdeck binary and Homebrew PlatformIO.',
        '',
        '  $ env PATH=/opt/homebrew/bin:/Users/puritysb/Library/pnpm:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin agentdeck esp32-ota',
        '  ips10 --build',
        '',
        '› 1. Yes, proceed (y)',
        "  2. Yes, and don't ask again for commands that start with `env 'PATH=/opt/homebrew/bin:/Users/puritysb/Library/pnpm:/usr/",
        "     local/bin:/usr/bin:/bin:/usr/sbin:/sbin' agentdeck esp32-ota ips10 --build` (p)",
        '  3. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel',
      ].join('\n'));
      vi.advanceTimersByTime(150);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual(expect.objectContaining({
        navigable: true,
        cursorIndex: 0,
        question: expect.stringContaining('env PATH='),
        options: expect.arrayContaining([
          expect.objectContaining({ index: 0, label: 'Yes, proceed', shortcut: 'y' }),
          expect.objectContaining({ index: 1, label: expect.stringContaining("Yes, and don't ask again") }),
          expect.objectContaining({ index: 2, label: 'No, and tell Codex what to do differently', shortcut: 'esc' }),
        ]),
      }));
    });
  });

  describe('model info detection', () => {
    it('detects gpt model name', () => {
      const handler = vi.fn();
      parser.on('model_info', handler);

      parser.feed('using gpt-5.3-codex');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.3-codex' }),
      );
    });

    it('detects o-series model', () => {
      const handler = vi.fn();
      parser.on('model_info', handler);

      parser.feed('model: o3');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'o3' }),
      );
    });

    it('does not re-emit same model', () => {
      const handler = vi.fn();
      parser.on('model_info', handler);

      parser.feed('model: o3');
      parser.feed('model: o3');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('project name detection', () => {
    it('detects working directory', () => {
      const handler = vi.fn();
      parser.on('project_name', handler);

      parser.feed('Working directory: /Users/dev/my-project');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'my-project' }),
      );
      expect(parser.getProjectName()).toBe('my-project');
    });

    it('detects project from path', () => {
      const handler = vi.fn();
      parser.on('project_name', handler);

      parser.feed('~/github/AgentDeck');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'AgentDeck' }),
      );
    });

    it('only detects project name once', () => {
      const handler = vi.fn();
      parser.on('project_name', handler);

      parser.feed('Working in /Users/dev/project-a');
      parser.feed('Working in /Users/dev/project-b');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('buffer management', () => {
    // `buffer` is private; read it directly to pin the bound and the clean text.
    const bufferOf = (p: CodexOutputParser) => (p as unknown as { buffer: string }).buffer;

    it('truncates buffer at 8192 chars', () => {
      const handler = vi.fn();
      parser.on('model_info', handler);

      parser.feed('x'.repeat(9000));
      // Past 8192 the buffer keeps only its last 4096 chars.
      expect(bufferOf(parser)).toHaveLength(4096);

      // Later input is still parsed after the truncation.
      parser.feed('model: o3');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ model: 'o3' }));
      expect(bufferOf(parser).endsWith('model: o3')).toBe(true);
    });

    it('handles incomplete ANSI sequences', () => {
      // Incomplete CSI sequence is held back until its tail arrives, so the
      // `32m` parameter bytes never leak into the clean text.
      parser.feed('some text \x1b[');
      expect(bufferOf(parser)).toBe('some text ');
      parser.feed('32m green \x1b[0m');
      expect(bufferOf(parser)).toBe('some text  green ');
    });
  });

  describe('getProjectName', () => {
    it('returns null when no project detected', () => {
      expect(parser.getProjectName()).toBeNull();
    });
  });
});
