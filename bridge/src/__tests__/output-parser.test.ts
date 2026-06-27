import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutputParser } from '../output-parser.js';
import type { PromptOption } from '../types.js';

function createParser(): OutputParser {
  return new OutputParser();
}

/** Arm the parser by feeding an idle prompt (enables spinner detection) */
function armParser(): OutputParser {
  const p = createParser();
  p.feed('❯ \n');
  return p;
}

/** Collect all emissions of a given event */
function collectEvents(parser: OutputParser, event: string): any[] {
  const events: any[] = [];
  parser.on(event, (data: any) => events.push(data));
  return events;
}

describe('OutputParser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // === Option Parsing: Basic ===

  describe('basic option parsing', () => {
    it('parses clean numbered options with newlines', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Default\n  2. Sonnet\n  3. Haiku\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0]).toMatchObject({ index: 0, label: 'Default' });
      expect(opts[1]).toMatchObject({ index: 1, label: 'Sonnet' });
      expect(opts[2]).toMatchObject({ index: 2, label: 'Haiku' });
    });

    it('detects (recommended) marker', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Default (recommended)\n  2. Sonnet\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options[0].recommended).toBe(true);
      expect(events[0].options[1].recommended).toBeUndefined();
    });

    it('detects ✔ selected marker', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Default\n❯ 2. Sonnet ✔\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options[0].selected).toBeUndefined();
      expect(events[0].options[1].selected).toBe(true);
    });

    it('handles both recommended and selected on different options', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Default (recommended)\n  2. Sonnet\n❯ 3. Haiku ✔\n');
      vi.advanceTimersByTime(200);

      const opts = events[0].options;
      expect(opts[0].recommended).toBe(true);
      expect(opts[0].selected).toBeUndefined();
      expect(opts[2].selected).toBe(true);
      expect(opts[2].recommended).toBeUndefined();
    });

    it('parses full Claude model selector with labels and middle dot', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed(
        '  1. Default (recommended)  Opus 4.6 \u00B7 Most capable\n' +
        '  2. Sonnet  Sonnet 4.6 \u00B7 Best for everyday\n' +
        '❯ 3. Haiku ✔  Haiku 4.5 \u00B7 Fastest\n',
      );
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0].recommended).toBe(true);
      expect(opts[0].label).toContain('Default');
      expect(opts[2].selected).toBe(true);
      expect(opts[2].label).toContain('Haiku');
    });
  });

  // === ANSI-stripped Options (no spaces) ===

  describe('ANSI-stripped options', () => {
    it('parses concatenated text with · delimiter', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Simulates ANSI stripping removing all spaces
      p.feed('1.Default(recommended)Opus4.6\u00B7Mostcapableforcomplexwork\n\n\n2.SonnetSonnet4.6\u00B7Bestforeverydaytasks\n\n\n\u276F3.Haiku\u2714Haiku4.5\u00B7Fastestforquickanswers\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0].recommended).toBe(true);
      expect(opts[0].label).toContain('Default');
      expect(opts[2].selected).toBe(true);
      expect(opts[2].label).toContain('Haiku');
    });

    it('extracts version numbers from · delimited labels', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.Opus4.6\u00B7Complex\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      // Should contain "Opus" and version "4.6"
      expect(label).toContain('Opus');
      expect(label).toContain('4.6');
    });
  });

  // === Chunked Input with Debounce (CRITICAL) ===

  describe('chunked input debounce', () => {
    it('does NOT emit immediately on first chunk', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Partial chunk with just option 1 (incomplete)
      p.feed('1.Default(rec');

      // No immediate emission
      expect(events).toHaveLength(0);
    });

    it('batches multiple chunks into single emission', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Chunk 1: partial data
      p.feed('\n\n1.Default(recommended)Opus4.6\u00B7Most\n');
      expect(events).toHaveLength(0);

      // Chunk 2: more options
      p.feed('2.SonnetSonnet4.6\u00B7Best\n');
      expect(events).toHaveLength(0);

      // Chunk 3: final option
      p.feed('\u276F3.Haiku\u2714Haiku4.5\u00B7Fastest\n');
      expect(events).toHaveLength(0);

      // Advance past debounce (150ms)
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
    });

    it('resets debounce timer when new chunk with options arrives', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.First\n');
      // Advance 100ms — not yet fired (150ms debounce)
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(0);

      // New chunk with more options resets timer
      p.feed('2.Second\n');
      // Advance another 100ms (200ms total from first, 100ms from second)
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(0);

      // Advance to fire (50ms more — 150ms from second chunk)
      vi.advanceTimersByTime(60);
      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
    });

    it('simulates real /model flow: split across chunks', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Chunk 1: like real PTY — contains old context + partial new option
      p.feed('\u276F /model \n\n\n \u23BFSetmodeltohaiku(claude-haiku-4-5-20251001)\n\n\n\n\n\n\u276F /model  \n\n\n');
      vi.advanceTimersByTime(50);
      expect(events).toHaveLength(0);

      // Chunk 2: rest of options
      p.feed('1.Default(recommended)Opus4.6\u00B7Mostcapable\n\n\n2.SonnetSonnet4.6\u00B7Bestforeveryday\n\n\n\u276F3.Haiku\u2714Haiku4.5\u00B7Fastest\n');
      vi.advanceTimersByTime(200);

      expect(events.length).toBeGreaterThanOrEqual(1);
      // Last emission should have all 3 options
      const last = events[events.length - 1];
      expect(last.options).toHaveLength(3);
      expect(last.options[0].label).toContain('Default');
    });
  });

  // === Model ID Date Not Matching ===

  describe('model ID date rejection', () => {
    it('does NOT parse 20251001 from model ID as option number', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('\u23BFSetmodeltohaiku(claude-haiku-4-5-20251001)\n\n1.Default\n2.Sonnet\n3.Haiku\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      // Must be exactly 3, not 4 (ghost option from date)
      expect(events[0].options).toHaveLength(3);
      // No option with index >= 3
      expect(events[0].options.every((o: PromptOption) => o.index < 3)).toBe(true);
    });

    it('rejects large numbers that look like dates', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "20251001." should not be parsed as option 20251001
      p.feed('version20251001.Released\n1.First\n2.Second\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
    });
  });

  // === Version Numbers Not Matching ===

  describe('version number rejection', () => {
    it('does NOT parse version "4.6" followed by digit as option', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "4.6" followed by digit (e.g. "4.60") — (?!\d) lookahead prevents matching
      p.feed('Opus4.60release\n1.First\n2.Second\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
      expect(events[0].options[0]).toMatchObject({ index: 0, label: expect.stringContaining('First') });
    });

    it('does NOT parse "6)" from "4.6)" as option 6', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "text4.6)something" — the "6)" should NOT be parsed as option 6
      p.feed('text4.6)something\n1.First\n2.Second\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      // Should be exactly 2 options, not 3
      expect(events[0].options).toHaveLength(2);
    });
  });

  // === Stale Buffer Data ===

  describe('stale buffer overwrite', () => {
    it('newer options overwrite older ones with same index', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Old options in buffer
      p.feed('1.OldFirst\n2.OldSecond\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(1);
      events.length = 0;

      // New options (same indices, different labels)
      p.feed('1.NewFirst\n2.NewSecond\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(1);
      // Map keyed by index — later entries overwrite earlier
      expect(events[0].options[0].label).toContain('New');
      expect(events[0].options[1].label).toContain('New');
    });
  });

  // === Permission Prompts ===

  describe('permission prompts', () => {
    it('detects Yes/No/Always pattern', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('  \u276F Yes, allow once\n    No, deny\n    Always allow\n');

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
      expect(events[0].options[0]).toMatchObject({ label: 'Yes, allow once', shortcut: 'y' });
      expect(events[0].options[1]).toMatchObject({ label: 'No, deny', shortcut: 'n' });
      expect(events[0].options[2]).toMatchObject({ label: 'Always allow', shortcut: 'a' });
    });

    it('detects (Y)es/(N)o pattern', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('Allow? (Y)es/(N)o\n');

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
      expect(events[0].options[0].shortcut).toBe('y');
      expect(events[0].options[1].shortcut).toBe('n');
    });

    it('emits immediately with no debounce', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('  \u276F Yes, allow once\n    No, deny\n    Always allow\n');
      // No timer advance — should already be emitted
      expect(events).toHaveLength(1);
    });

    it('sets yes_no_always prompt type', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('  \u276F Yes, allow once\n    No, deny\n    Always allow\n');
      expect(events[0].promptType).toBe('yes_no_always');
    });

    it('sets yes_no prompt type', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('Allow? (Y)es/(N)o\n');
      expect(events[0].promptType).toBe('yes_no');
    });

    // === Question extraction (Gap 2) ===

    it('extracts the multi-line question header above yes/no/always options', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('Do you want to proceed?\n  ❯ Yes, allow once\n    No, deny\n    Always allow\n');
      expect(events).toHaveLength(1);
      expect(events[0].question).toBe('Do you want to proceed?');
    });

    it('extracts the question from a box-framed permission prompt', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed(
        '╭─────╮\n' +
        '│ Allow Bash to run this command? │\n' +
        '│ ❯ Yes, allow once │\n' +
        '│   No, deny │\n' +
        '│   Always allow │\n',
      );
      expect(events).toHaveLength(1);
      expect(events[0].question).toBe('Allow Bash to run this command?');
    });

    it('extracts the inline question from the (Y)es/(N)o line', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('Allow Bash to run this command? (Y)es/(N)o\n');
      expect(events[0].question).toBe('Allow Bash to run this command?');
    });

    it('does not mistake box-drawing or footer chrome for a question', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      // No question header — only a separator line above the options.
      p.feed('────────\n  ❯ Yes, allow once\n    No, deny\n    Always allow\n');
      expect(events).toHaveLength(1);
      expect(events[0].question).toBeUndefined();
    });

    it('suppresses false idle from user prompt echo after permission (interactive cooldown)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Permission prompt arrives in diff output
      p.feed('  \u276F Yes, allow once\n    No, deny\n    Always allow\n');
      expect(permEvents).toHaveLength(1);

      // 4ms later: user prompt echo in same PTY batch (❯ Review the code...)
      p.feed('❯ Review the commit log\n');
      vi.advanceTimersByTime(500);

      // Idle should NOT have fired — cooldown active
      expect(idleEvents).toHaveLength(0);
    });

    it('allows real idle after interactive cooldown expires', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Permission prompt
      p.feed('  \u276F Yes, allow once\n    No, deny\n    Always allow\n');
      expect(permEvents).toHaveLength(1);

      // Wait for cooldown to expire (200ms)
      vi.advanceTimersByTime(250);

      // Real idle prompt after user responds
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);

      expect(idleEvents).toHaveLength(1);
    });
  });

  // === Diff Prompts ===

  describe('diff prompts', () => {
    it('detects (V)iew/(A)pply/(D)eny pattern', () => {
      const p = armParser();
      const events = collectEvents(p, 'diff_prompt');

      p.feed('(V)iew diff  (A)pply  (D)eny\n');

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
      expect(events[0].options[0]).toMatchObject({ label: 'View diff', shortcut: 'v' });
      expect(events[0].options[1]).toMatchObject({ label: 'Apply', shortcut: 'a' });
      expect(events[0].options[2]).toMatchObject({ label: 'Deny', shortcut: 'd' });
    });

    it('detects lowercase (a)pply/(d)eny/(v)iew pattern', () => {
      const p = armParser();
      const events = collectEvents(p, 'diff_prompt');

      p.feed('(a)pply  (d)eny  (v)iew\n');

      expect(events).toHaveLength(1);
      expect(events[0].options.length).toBeGreaterThanOrEqual(3);
    });

    it('emits immediately with no debounce', () => {
      const p = armParser();
      const events = collectEvents(p, 'diff_prompt');

      p.feed('(V)iew diff  (A)pply  (D)eny\n');
      // No timer advance needed
      expect(events).toHaveLength(1);
    });

    it('suppresses false idle from user prompt echo after diff (interactive cooldown)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const diffEvents = collectEvents(p, 'diff_prompt');
      const idleEvents = collectEvents(p, 'idle');

      p.feed('(V)iew diff  (A)pply  (D)eny\n');
      expect(diffEvents).toHaveLength(1);

      // User prompt echo in same PTY batch
      p.feed('❯ fix the bug\n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
    });
  });

  // === Various Option Counts ===

  describe('various option counts', () => {
    it('handles 1 option', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.OnlyOne\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(1);
    });

    it('handles 2 options', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.Alpha\n2.Beta\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
    });

    it('handles 5+ options', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.One\n2.Two\n3.Three\n4.Four\n5.Five\n6.Six\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(6);
    });

    it('marks direct-input options as freeform instead of a normal choice', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('❯ 1. Proceed\n  2. Revise plan\n  3. Cancel\n  4. Type custom instructions\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(4);
      expect(opts[3]).toMatchObject({
        index: 3,
        label: 'Type custom instructions',
        kind: 'freeform_input',
      });
      expect(opts[0].kind).toBeUndefined();
    });

    it('handles bullet-style options', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('\u25BA First choice\n\u25B8 Second choice\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
      expect(events[0].options[0].label).toBe('First choice');
    });
  });

  // === Option Updates ===

  describe('option updates', () => {
    it('emits new options when data changes after first emission', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // First emission
      p.feed('1.Alpha\n2.Beta\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(1);

      // Second emission with different data
      p.feed('1.Gamma\n2.Delta\n3.Epsilon\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(2);
      expect(events[1].options).toHaveLength(3);
    });
  });

  // === Spinner Cancels Option Timer ===

  describe('spinner cancels option timer', () => {
    it('spinner cancels pending option debounce', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Feed options — debounce starts
      p.feed('1.First\n2.Second\n');
      expect(events).toHaveLength(0);

      // Spinner arrives before debounce fires
      p.feed('✻');
      vi.advanceTimersByTime(200);

      // Option prompt should NOT have fired
      expect(events).toHaveLength(0);
    });
  });

  // === Idle Cancels Option Timer ===

  describe('idle vs option debounce', () => {
    it('idle prompt is ignored when option debounce is pending', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Feed options — debounce starts
      p.feed('1.First\n2.Second\n');
      expect(optEvents).toHaveLength(0);

      // Idle prompt arrives before debounce fires — should be ignored
      p.feed('❯ \n');
      vi.advanceTimersByTime(500);

      // Option prompt SHOULD have fired (debounce completes normally)
      expect(optEvents).toHaveLength(1);
      expect(optEvents[0].options).toHaveLength(2);
      // Idle should NOT have fired
      expect(idleEvents).toHaveLength(0);
    });

    it('idle prompt fires normally when no option debounce is pending', () => {
      const p = armParser();
      vi.advanceTimersByTime(500); // clear boot idle timer

      const idleEvents = collectEvents(p, 'idle');

      // Just idle prompt, no option debounce pending
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);

      expect(idleEvents).toHaveLength(1);
    });
  });

  // === Interactive Prompt During Spinner ===

  describe('interactive prompt during spinner', () => {
    it('stops spinner when permission prompt arrives', () => {
      const p = armParser();
      vi.advanceTimersByTime(500); // clear idle timer from boot

      const events: string[] = [];
      p.on('spinner_start', () => events.push('spinner_start'));
      p.on('spinner_stop', () => events.push('spinner_stop'));
      p.on('permission_prompt', () => events.push('permission'));

      p.feed('✳'); // start spinner
      expect(events).toEqual(['spinner_start']);

      // Permission prompt during spinner
      p.feed('  ❯ Yes, allow once\n    No, deny\n    Always allow\n');
      expect(events).toContain('spinner_stop');
      expect(events).toContain('permission');
    });

    it('stops spinner when diff prompt arrives', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('spinner_start', () => events.push('spinner_start'));
      p.on('spinner_stop', () => events.push('spinner_stop'));
      p.on('diff_prompt', () => events.push('diff'));

      p.feed('✳');
      expect(events).toEqual(['spinner_start']);

      p.feed('(V)iew diff  (A)pply  (D)eny\n');
      expect(events).toContain('spinner_stop');
      expect(events).toContain('diff');
    });

    it('stops spinner when option prompt arrives', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('spinner_start', () => events.push('spinner_start'));
      p.on('spinner_stop', () => events.push('spinner_stop'));
      p.on('option_prompt', () => events.push('option'));

      p.feed('✳');
      expect(events).toEqual(['spinner_start']);

      p.feed('1. Alpha\n2. Bravo\n');
      vi.advanceTimersByTime(200);
      expect(events).toContain('spinner_stop');
      expect(events).toContain('option');
    });

    it('stops spinner when idle prompt arrives in small chunk', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('spinner_start', () => events.push('spinner_start'));
      p.on('spinner_stop', () => events.push('spinner_stop'));
      p.on('idle', () => events.push('idle'));

      p.feed('✳');
      expect(events).toEqual(['spinner_start']);

      // Small chunk with idle prompt
      p.feed('❯ \n');
      expect(events).toContain('spinner_stop');

      vi.advanceTimersByTime(400);
      expect(events).toContain('idle');
    });

    it('ignores idle prompt in large chunk during spinner (screen redraw)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const stops = collectEvents(p, 'spinner_stop');
      p.on('spinner_start', () => {});

      p.feed('✳');

      // Large chunk (>80 non-ws chars) with ❯ — screen redraw, not real idle
      const largeChunk = 'a'.repeat(100) + '❯ \n' + 'b'.repeat(50);
      p.feed(largeChunk);

      // Spinner should NOT have stopped
      expect(stops).toHaveLength(0);
    });
  });

  // === cleanOptionLabel Edge Cases ===

  describe('cleanOptionLabel (via parseOptions)', () => {
    it('deduplicates exact CamelCase matches', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "SonnetSonnet4.6·desc" → CamelCase split → ["Sonnet","Sonnet"] → dedup → "Sonnet"
      p.feed('1.SonnetSonnet4.6\u00B7description\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      expect(label).toContain('Sonnet');
      expect(label).toContain('4.6');
      // Should NOT contain duplicate "Sonnet Sonnet"
      const sonnetCount = (label.match(/Sonnet/gi) || []).length;
      expect(sonnetCount).toBe(1);
    });

    it('preserves labels without · delimiter', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1. Simple label here\n');
      vi.advanceTimersByTime(200);

      expect(events[0].options[0].label).toBe('Simple label here');
    });

    it('removes (recommended) from label text', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1. Default (recommended)\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      expect(label).not.toContain('recommended');
      expect(label).toContain('Default');
      expect(events[0].options[0].recommended).toBe(true);
    });

    it('removes ✔ from label text', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1. Haiku ✔\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      expect(label).not.toContain('✔');
      expect(label).toContain('Haiku');
      expect(events[0].options[0].selected).toBe(true);
    });

    it('extracts version from identity before middle dot', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.HaikuHaiku4.5\u00B7Fastest\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      expect(label).toContain('Haiku');
      expect(label).toContain('4.5');
    });
  });

  // === Metadata Events ===

  describe('metadata events', () => {
    it('emits project_name from startup banner', () => {
      const p = createParser();
      const events = collectEvents(p, 'project_name');

      p.feed('~/github/MyProject\n');

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('MyProject');
    });

    it('emits project_name only once (caches)', () => {
      const p = createParser();
      const events = collectEvents(p, 'project_name');

      p.feed('~/github/FirstProject\n');
      p.feed('~/github/SecondProject\n');

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('FirstProject');
    });

    it('parses absolute path for project_name', () => {
      const p = createParser();
      const events = collectEvents(p, 'project_name');

      p.feed('/Users/dev/projects/my-app\n');

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('my-app');
    });

    it('emits model_info with model and plan', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus 4.6 \u00B7 Claude Max\n');

      expect(events).toHaveLength(1);
      expect(events[0].model).toContain('Opus');
      expect(events[0].plan).toBe('Claude Max');
    });

    it('emits model_info without plan', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Sonnet 4.6\n');

      expect(events).toHaveLength(1);
      expect(events[0].model).toContain('Sonnet');
      expect(events[0].plan).toBeNull();
    });

    it('emits model_info only once for same model (caches)', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus 4.6 \u00B7 Claude Max\n');
      p.feed('Opus 4.6 \u00B7 Claude Max\n');

      expect(events).toHaveLength(1);
    });

    it('re-emits model_info when model changes', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus 4.6 \u00B7 Claude Max\n');
      p.feed('Sonnet 4.6\n');

      expect(events).toHaveLength(2);
      expect(events[0].model).toContain('Opus');
      expect(events[1].model).toContain('Sonnet');
    });

    it('parses ANSI-stripped model_info', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus4.6\u00B7ClaudeMax\n');

      expect(events).toHaveLength(1);
      expect(events[0].plan).toBe('ClaudeMax');
    });

    it('detects API billing plan', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus 4.6 \u00B7 api.anthropic.com\n');

      expect(events).toHaveLength(1);
      expect(events[0].plan).toBe('api.anthropic.com');
    });

    it('emits status_line with duration and tokens', () => {
      const p = createParser();
      const events = collectEvents(p, 'status_line');

      p.feed('1m 30s \u00B7 ↓ 2.5k tokens\n');

      expect(events).toHaveLength(1);
      expect(events[0].durationSec).toBe(90);
      expect(events[0].tokens).toBe(2500);
    });

    it('parses zero-minute status line', () => {
      const p = createParser();
      const events = collectEvents(p, 'status_line');

      p.feed('0m 15s \u00B7 ↓ 0.5k tokens\n');

      expect(events).toHaveLength(1);
      expect(events[0].durationSec).toBe(15);
      expect(events[0].tokens).toBe(500);
    });

    it('emits tool_action from ⏺ pattern', () => {
      const p = createParser();
      const events = collectEvents(p, 'tool_action');

      p.feed('⏺ Read(file.ts)\n');

      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Read');
    });

    it('extracts various tool names', () => {
      const p = createParser();
      const events = collectEvents(p, 'tool_action');

      p.feed('⏺ Write(output.ts)\n');
      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Write');
    });
  });

  // === User Prompt ===

  describe('user prompt', () => {
    it('emits user_prompt after first idle has been seen', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ hello world\n');
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('hello world');
    });

    it('does NOT emit user_prompt before first idle', () => {
      const p = createParser(); // no idle yet
      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ hello world\n');
      expect(events).toHaveLength(0);
    });

    it('filters out mode banner text', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ ⏸ plan mode on\n');
      expect(events).toHaveLength(0);
    });

    it('filters out numbered option lines', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ 3. Haiku ✔\n');
      expect(events).toHaveLength(0);
    });

    it('filters out keyboard hint text', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ ? for shortcuts\n');
      expect(events).toHaveLength(0);
    });

    it('filters out "esc to interrupt" text', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ esc to interrupt\n');
      expect(events).toHaveLength(0);
    });

    it('filters out autocomplete suggestions', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ Try \u201Crefactor the code\u201D\n');
      expect(events).toHaveLength(0);
    });

    it('filters out box-drawing decorative lines', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ ─────────────\n');
      expect(events).toHaveLength(0);
    });
  });

  // === Usage Info ===

  describe('usage info', () => {
    it('parses usage percentage', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('75% used\n');

      expect(events).toHaveLength(1);
      expect(events[0].sessionPercent).toBe(75);
    });

    it('parses usage cost', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('$1.50 / $5.00 spent\n');

      expect(events).toHaveLength(1);
      expect(events[0].costSpent).toBe(1.5);
      expect(events[0].costLimit).toBe(5.0);
    });

    it('parses session percentage with hour limit', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('80% of 5 hour limit\n');

      expect(events).toHaveLength(1);
      expect(events[0].sessionPercent).toBe(80);
    });

    it('parses reset time with timezone', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('42% used\nResets 3pm (PST)\n');

      expect(events.length).toBeGreaterThanOrEqual(1);
      const withReset = events.find((e) => e.resetTime);
      if (withReset) {
        expect(withReset.resetTime).toBe('3pm');
        expect(withReset.resetTimezone).toBe('PST');
      }
    });

    it('parses time remaining', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('30 minutes remaining\n');

      expect(events).toHaveLength(1);
      expect(events[0].timeRemaining).toContain('30');
    });
  });

  // === Spinner Lifecycle ===

  describe('spinner lifecycle', () => {
    it('emits spinner_start on spinner char (after idle seen)', () => {
      const p = armParser();
      const starts = collectEvents(p, 'spinner_start');

      p.feed('✻');

      expect(starts).toHaveLength(1);
    });

    it('does NOT emit spinner_start before first idle', () => {
      const p = createParser(); // no idle prompt fed
      const starts = collectEvents(p, 'spinner_start');

      p.feed('✻');

      expect(starts).toHaveLength(0);
    });

    it('emits spinner_stop after debounce (2000ms)', () => {
      const p = armParser();
      const stops = collectEvents(p, 'spinner_stop');

      p.feed('✻');
      vi.advanceTimersByTime(2100);

      expect(stops).toHaveLength(1);
    });

    it('does NOT emit duplicate spinner_start on repeated chars', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const starts = collectEvents(p, 'spinner_start');

      p.feed('✳');
      p.feed('✢');
      p.feed('✶');

      expect(starts).toHaveLength(1);
    });

    it('resets spinner debounce timer on repeated chars', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('spinner_start', () => events.push('start'));
      p.on('spinner_stop', () => events.push('stop'));

      p.feed('✳');
      vi.advanceTimersByTime(1500); // 1500ms elapsed
      p.feed('✢'); // resets timer
      vi.advanceTimersByTime(1500); // 3000ms total, 1500 from last
      expect(events).toEqual(['start']); // no stop yet

      vi.advanceTimersByTime(600); // now >2000ms from last char
      expect(events).toEqual(['start', 'stop']);
    });

    it('ignores spinner chars in large text blocks (>80 non-ws)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const starts = collectEvents(p, 'spinner_start');

      // Large chunk with spinner char embedded
      const largeText = 'a'.repeat(100) + '✳' + 'b'.repeat(100);
      p.feed(largeText);

      expect(starts).toHaveLength(0);
    });

    it('recognizes all spinner characters', () => {
      const spinnerChars = ['✢', '✳', '✶', '✻', '✽'];
      for (const ch of spinnerChars) {
        const p = armParser();
        vi.advanceTimersByTime(500);

        const starts = collectEvents(p, 'spinner_start');
        p.feed(ch);
        expect(starts).toHaveLength(1);
      }
    });
  });

  // === Idle Detection ===

  describe('idle detection', () => {
    it('emits idle after IDLE_DEBOUNCE_MS (300ms)', () => {
      const p = createParser();
      const events = collectEvents(p, 'idle');

      p.feed('❯ \n');
      expect(events).toHaveLength(0); // debounce pending

      vi.advanceTimersByTime(400);
      expect(events).toHaveLength(1);
    });

    it('sets seenFirstIdle on first idle prompt', () => {
      const p = createParser();
      const spinners = collectEvents(p, 'spinner_start');

      // Before idle — spinner disabled
      p.feed('✳');
      expect(spinners).toHaveLength(0);

      // See first idle prompt
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);

      // After idle — spinner enabled
      p.feed('✳');
      expect(spinners).toHaveLength(1);
    });

    it('cancels idle timer when spinner starts', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('idle', () => events.push('idle'));
      p.on('spinner_start', () => events.push('spinner'));

      p.feed('❯ \n'); // idle timer starts
      p.feed('✳');    // spinner should cancel idle timer
      vi.advanceTimersByTime(500);

      expect(events).toContain('spinner');
      expect(events).not.toContain('idle');
    });

    it('recognizes > as idle prompt char', () => {
      const p = createParser();
      const events = collectEvents(p, 'idle');

      p.feed('> \n');
      vi.advanceTimersByTime(400);

      expect(events).toHaveLength(1);
    });
  });

  // === Mode Detection ===

  describe('mode detection', () => {
    it('detects plan mode', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.feed('\u23F8 plan mode on\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('plan');
    });

    it('detects accept edits mode', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.feed('\u23F5\u23F5 accept edits on\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('acceptEdits');
    });

    it('detects default mode after Shift+Tab', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.notifyModeSwitchSent();
      p.feed('? for shortcuts\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('default');
    });

    it('detects default mode via idle prompt after Shift+Tab', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.notifyModeSwitchSent();
      p.feed('❯ \n'); // idle with no mode banner

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('default');
    });

    it('emits default mode on Shift+Tab timeout (2s)', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.notifyModeSwitchSent();
      vi.advanceTimersByTime(2100);

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('default');
    });

    it('detects ANSI-stripped plan mode text', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.feed('\u23F8planmodeon\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('plan');
    });

    it('detects ANSI-stripped accept edits text', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.feed('\u23F5\u23F5accepteditson\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('acceptEdits');
    });

    it('clears pending mode switch when mode banner is detected', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.notifyModeSwitchSent();
      p.feed('\u23F8 plan mode on\n');

      // Should emit plan, not default
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('plan');

      // Timeout should not fire another event
      vi.advanceTimersByTime(2100);
      expect(events).toHaveLength(1);
    });
  });

  // === Reset ===

  describe('reset', () => {
    it('clears cached project name and model name', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      p.feed('~/github/TestProject\n');
      p.feed('Opus 4.6\n');

      expect(p.getProjectName()).toBe('TestProject');
      expect(p.getModelName()).toContain('Opus');

      p.reset();

      expect(p.getProjectName()).toBeNull();
      expect(p.getModelName()).toBeNull();
    });

    it('disables spinner detection (clears seenFirstIdle)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      p.reset();

      const events = collectEvents(p, 'spinner_start');
      p.feed('✳');
      expect(events).toHaveLength(0);
    });

    it('allows re-detection after new idle prompt post-reset', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      p.reset();

      // New idle prompt
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);

      const events = collectEvents(p, 'spinner_start');
      p.feed('✳');
      expect(events).toHaveLength(1);
    });

    it('allows re-detection of project name after reset', () => {
      const p = createParser();
      p.feed('~/github/First\n');
      expect(p.getProjectName()).toBe('First');

      p.reset();
      p.feed('~/github/Second\n');
      expect(p.getProjectName()).toBe('Second');
    });

    it('allows re-detection of model info after reset', () => {
      const p = createParser();
      p.feed('Opus 4.6\n');
      expect(p.getModelName()).toContain('Opus');

      p.reset();
      p.feed('Sonnet 4.6\n');
      expect(p.getModelName()).toContain('Sonnet');
    });
  });

  // === Buffer Management ===

  describe('buffer management', () => {
    it('truncates buffer when exceeding 8192 chars', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Fill buffer past 8192
      p.feed('x'.repeat(9000));

      // Options at the tail should still be parseable
      p.feed('\n1. Alpha\n2. Bravo\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
    });

    it('keeps the last 4096 chars after truncation', () => {
      const p = createParser();
      // Feed exactly 8193 chars → triggers truncation
      p.feed('a'.repeat(8193));
      // Buffer should now be ~4096 chars

      // Feed option data that should be parseable from truncated buffer
      const events = collectEvents(p, 'option_prompt');
      p.feed('\n1. First\n2. Second\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
    });
  });

  // === Option Navigation (Cursor Keys) ===

  describe('option navigation', () => {
    it('cursor movement during option selection does NOT trigger idle', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Trigger initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);
      expect(optEvents.length).toBeGreaterThanOrEqual(1);

      // Simulate cursor wrap: down past last → back to first
      // PTY sends "❯\n" (no space after ❯) — must NOT trigger idle
      p.feed('\n❯\n Haiku\n\n\n\n\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
    });

    it('cursor movement does NOT trigger user_prompt', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const userEvents = collectEvents(p, 'user_prompt');

      // Initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);

      // Cursor navigation chunk — "❯\n Haiku" must NOT parse as user_prompt "Haiku"
      p.feed('\n❯\n Haiku\n\n\n\n\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);

      expect(userEvents).toHaveLength(0);
    });

    it('normal cursor movement between options emits no idle or user_prompt', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const idleEvents = collectEvents(p, 'idle');
      const userEvents = collectEvents(p, 'user_prompt');

      // Initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);

      // Cursor moves to Sonnet
      p.feed('\n \n❯Sonnet\n\n\n\n\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
      expect(userEvents).toHaveLength(0);
    });

    it('real idle prompt still works after option navigation', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const idleEvents = collectEvents(p, 'idle');

      // Initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);

      // Cursor navigation (no idle)
      p.feed('\n❯\n Haiku\n\n\n\n\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);
      expect(idleEvents).toHaveLength(0);

      // Real idle prompt: "❯ " (with space) should trigger idle
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(1);
    });

    it('effort/hint text during navigation does not trigger events', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const idleEvents = collectEvents(p, 'idle');
      const userEvents = collectEvents(p, 'user_prompt');

      // Initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);

      // Effort hint text that appears during navigation
      p.feed('\n▌ Effort not supported for Haiku\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
      expect(userEvents).toHaveLength(0);
    });

    it('IDLE_PROMPT requires space/tab/NBSP after ❯ (not newline)', () => {
      const p = createParser();
      const idleEvents = collectEvents(p, 'idle');

      // "❯\n" (newline immediately after ❯) — NOT an idle prompt
      p.feed('❯\n');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(0);

      // "❯ \n" (space after ❯) — IS an idle prompt
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(1);
    });

    it('USER_PROMPT requires space/tab after ❯ (not newline)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const userEvents = collectEvents(p, 'user_prompt');

      // "❯\nHaiku" — ❯ followed by newline then text — NOT a user prompt
      p.feed('❯\nHaiku\n');
      expect(userEvents).toHaveLength(0);

      // "❯ Haiku" — ❯ followed by space then text — IS a user prompt
      p.feed('❯ Haiku\n');
      expect(userEvents).toHaveLength(1);
      expect(userEvents[0].text).toBe('Haiku');
    });
  });

  // === Permission reclassification from numbered options ===

  describe('permission reclassification', () => {
    it('reclassifies numbered Yes/No options as permission_prompt', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const optEvents = collectEvents(p, 'option_prompt');

      // Tool approval prompt (Claude Code v2.1.50+ style)
      p.feed('❯1. Yes\n2. Yes, and don\'t ask again for: tail:*\n3. No\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      expect(optEvents).toHaveLength(0);
      expect(permEvents[0].options.length).toBeGreaterThanOrEqual(3);
      // Shortcuts should be inferred
      const labels = permEvents[0].options.map((o: PromptOption) => o.label.toLowerCase());
      expect(labels.some((l: string) => l.startsWith('yes'))).toBe(true);
      expect(labels.some((l: string) => l.startsWith('no'))).toBe(true);
    });

    it('does NOT reclassify regular options as permission', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const optEvents = collectEvents(p, 'option_prompt');

      // Regular model selection — no Yes/No
      p.feed('1. Default (recommended)\n❯2. Sonnet\n3. Haiku\n');
      vi.advanceTimersByTime(200);

      expect(optEvents).toHaveLength(1);
      expect(permEvents).toHaveLength(0);
    });

    it('does NOT reclassify cursor-selection UI with "Enter to confirm" as permission', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const optEvents = collectEvents(p, 'option_prompt');

      // Security Guide: cursor-navigable Yes/No with "Enter to confirm"
      p.feed('❯ 1. Yes, I trust this folder\n  2. No, exit\n\nEnter to confirm · Esc to cancel\n');
      vi.advanceTimersByTime(200);

      expect(optEvents).toHaveLength(1);
      expect(permEvents).toHaveLength(0);
      expect(optEvents[0].navigable).toBe(true);
    });

    it('detects cursor-selection UI even when ANSI stripping removes spaces', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const optEvents = collectEvents(p, 'option_prompt');

      // Real PTY output: ANSI cursor positioning strips spaces between words
      p.feed('❯1.Yes,Itrustthisfolder\n\n\n2.No,exit\n\n\n\n\n\nEntertoconfirm·Esctocancel\n');
      vi.advanceTimersByTime(200);

      expect(optEvents).toHaveLength(1);
      expect(permEvents).toHaveLength(0);
    });

    it('includes navigable and cursorIndex in reclassified permission_prompt', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');

      p.feed('❯1. Yes\n2. No\n3. Always\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      expect(permEvents[0].navigable).toBe(true);
      expect(permEvents[0].cursorIndex).toBe(0);
    });

    it('infers shortcuts for reclassified permission options', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');

      p.feed('❯1. Yes\n2. Always allow\n3. No\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      const opts = permEvents[0].options as PromptOption[];
      const yesOpt = opts.find(o => /^yes\b/i.test(o.label));
      const noOpt = opts.find(o => /^no\b/i.test(o.label));
      const alwaysOpt = opts.find(o => /^always\b/i.test(o.label));
      expect(yesOpt?.shortcut).toBe('y');
      expect(noOpt?.shortcut).toBe('n');
      expect(alwaysOpt?.shortcut).toBe('a');
    });

    it('infers shortcut "a" for "don\'t ask again" labels', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');

      p.feed('❯1. Yes\n2. Yes, and don\'t ask again for: tail:*\n3. No\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      const opts = permEvents[0].options as PromptOption[];
      // Plain "Yes" → 'y'
      expect(opts[0].shortcut).toBe('y');
      // "Yes, and don't ask again for: tail:*" → 'a' (not 'y')
      expect(opts[1].shortcut).toBe('a');
      // "No" → 'n'
      expect(opts[2].shortcut).toBe('n');
    });

    it('infers shortcut "a" for "allow all sessions" labels', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');

      p.feed('❯1. Yes\n2. Yes, allow all sessions in project\n3. No\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      const opts = permEvents[0].options as PromptOption[];
      expect(opts[0].shortcut).toBe('y');
      expect(opts[1].shortcut).toBe('a');
      expect(opts[2].shortcut).toBe('n');
    });
  });

  // === Ghost Text / Suggested Prompt ===

  describe('ghost text suggestion', () => {
    // All ghost text tests use realistic PTY format: ❯ prompt line + SGR 90 (bright black)
    // Dim (\x1b[2m) is intentionally excluded from detection — used broadly in Claude Code UI

    it('detects SGR 90 (bright black) ghost text on prompt line', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Realistic PTY: prompt char + gray ghost text on same line
      p.feed('❯ \x1b[90mrefactor the code\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');
    });

    it('detects ghost text via Strategy 1 (Try "..." in clean text)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Strategy 1: clean text matches ❯ Try "..." — no ANSI gray needed
      p.feed('❯ Try \u201Cwrite unit tests\u201D');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('write unit tests');
    });

    it('unwraps Try "..." wrapper with smart quotes', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90mTry \u201Crefactor the code\u201D\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');
    });

    it('unwraps Try "..." wrapper with straight quotes', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90mTry "fix the bug"\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('fix the bug');
    });

    it('detects ghost text on first idle (❯ and suggestion in same chunk)', () => {
      const p = createParser(); // no idle yet
      const events = collectEvents(p, 'suggested_prompt');

      // ❯ sets seenFirstIdle via detectPatterns, then detectGhostText picks up the suggestion
      p.feed('❯ \x1b[90mrefactor the code\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');
    });

    it('clears suggestion on spinner start', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // First, establish a suggestion
      p.feed('❯ \x1b[90mrefactor the code\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');

      // Spinner starts — should clear
      p.feed('✻');
      expect(events).toHaveLength(2);
      expect(events[1].text).toBeNull();
    });

    it('debounces rapid updates', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Rapid-fire ghost text updates on prompt line
      p.feed('❯ \x1b[90mfirst\x1b[0m');
      vi.advanceTimersByTime(100);
      p.feed('❯ \x1b[90msecond\x1b[0m');
      vi.advanceTimersByTime(100);
      p.feed('❯ \x1b[90mthird\x1b[0m');
      vi.advanceTimersByTime(600);

      // Only the last one should have been emitted
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('third');
    });

    it('ignores dim (SGR 2) text without ❯ prompt context', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Dim text without ❯ prompt — should NOT trigger (no prompt line context)
      p.feed('\x1b[2msome dim text\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(0);
    });

    it('detects dim (SGR 2) ghost text on ❯ prompt line', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Dim ghost text inline with ❯ — Claude Code uses SGR 2 for suggestions
      p.feed('❯ \x1b[2mrefactor the auth module\x1b[22m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the auth module');
    });

    it('detects ghost text with cursor-forward spacing (Strategy 1)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Claude Code TUI uses \x1b[1C (cursor forward) instead of spaces between words
      p.feed('❯\xa0\x1b[1CTry\x1b[1C\x1b[2m"fix the login bug"\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('fix the login bug');
    });

    it('filters UI chrome fragments', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Single char "?" — too short
      p.feed('❯ \x1b[90m?\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(0);

      // "esc to cancel" — UI chrome
      p.feed('❯ \x1b[90mesc to cancel\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(0);

      // "shift+tab to cycle" — UI chrome
      p.feed('❯ \x1b[90mshift+tab to cycle\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(0);
    });

    it('filters box-drawing lines as UI chrome', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Pure box-drawing line on ❯ prompt line
      p.feed('❯ \x1b[90m───────────────────────────────────\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(0);

      // Mixed box-drawing with dashes
      p.feed('❯ \x1b[90m─────━━━━━═════\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(0);
    });

    it('filters file paths (false positive from screen redraws)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Absolute path — common false positive from PTY redraws mixing prompt + banner
      p.feed('❯ \x1b[90m/Users/foo/github/MyProject\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(0);

      // Home-relative path
      p.feed('❯ \x1b[90m~/github/MyProject\x1b[0m');
      vi.advanceTimersByTime(600);
      expect(events).toHaveLength(0);
    });

    it('detects 256-color gray ghost text', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // 256-color gray (e.g. color 245) on prompt line
      p.feed('❯ \x1b[38;5;245mexplain this function\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('explain this function');
    });

    it('handles multi-segment ghost text on prompt line', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Ghost text split across multiple ANSI segments (e.g. Korean + English)
      p.feed('❯ \x1b[90mrefactor \x1b[90mthe code\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');
    });

    it('ignores ghost text on non-prompt lines', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Gray text NOT on ❯ line — should be ignored (e.g. diff line numbers)
      p.feed('some output\n\x1b[90m65\x1b[0m\n');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('detects 24-bit RGB gray ghost text', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // \x1b[38;2;153;153;153m — Claude Code's actual ghost text color
      p.feed('❯ \x1b[38;2;153;153;153mrefactor the code\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');
    });

    it('ignores 24-bit RGB non-gray colors (e.g. blue prompt char)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // \x1b[38;2;177;185;249m — blue-ish, not gray
      p.feed('❯ \x1b[38;2;177;185;249msome colored text\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('filters out short gray text like prompt char itself', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // The ❯ character in gray (80,80,80) — filtered by scheduleSuggestion length/content check
      p.feed('\x1b[38;2;80;80;80m❯ \x1b[38;2;255;255;255muser text\x1b[0m');
      vi.advanceTimersByTime(600);

      // No ❯-line match (no "❯ " in clean text from a line that also has gray segments)
      // or gray segment is just "❯ " which is too short / no meaningful content
      expect(events).toHaveLength(0);
    });

    it('suppresses ghost text detection during spinner (processing)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Establish ❯ in buffer so strategy 3 would normally trigger
      p.feed('❯ ');
      vi.advanceTimersByTime(600);

      // Start spinner (processing)
      p.feed('✻');
      vi.advanceTimersByTime(100);

      // Diff chunk with dim line numbers — strategy 3 would match buffer's ❯
      // but spinnerActive should suppress detection entirely
      p.feed('\x1b[38;2;248;248;242m\x1b[2m 96 +\x1b[22m');
      vi.advanceTimersByTime(600);

      // Only the null event from spinner clearing the first suggestion
      const nonNull = events.filter(e => e.text !== null);
      expect(nonNull).toHaveLength(0);
    });

    it('rejects digit+operator fragments like diff markers "96 +"', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'suggested_prompt');

      // Simulate ghost text that looks like a diff line marker
      p.feed('❯ \x1b[2m96 +\x1b[22m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });
  });

  // === UI Chrome False Positive Filtering ===

  describe('ghost text UI chrome filtering', () => {
    it('filters out "Tip:" segments on prompt line', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // ❯-line with ghost text + Tip in separate gray segments
      p.feed('❯ \x1b[38;2;153;153;153mshow me the diff\x1b[0m\x1b[70G\x1b[90mTip: Did you know you can...\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('show me the diff');
    });

    it('filters out "(ctrl+...)" shortcut hints on prompt line', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90m(ctrl+o to expand)(1m 23s · ↓ 5k tokens)\x1b[0m');
      vi.advanceTimersByTime(600);

      // Both segments are UI chrome — nothing should be emitted
      expect(events).toHaveLength(0);
    });

    it('filters concatenated UI chrome even in scheduleSuggestion', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Single gray segment that is UI chrome
      p.feed('❯ \x1b[90mTip: Use /commit to save\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('keeps ghost text when UI chrome is also present on the line', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Ghost text + "to expand" hint on the same ❯-line
      p.feed('❯ \x1b[90mrefactor the code\x1b[0m  \x1b[90m(ctrl+o to expand)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');
    });
  });

  // === Extended Thinking Indicator Filtering ===

  describe('filters out extended thinking indicators', () => {
    it('rejects "(thought for 1s)" as ghost text via isUiChrome', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Gray "(thought for 1s)" on the prompt line — should be filtered
      p.feed('❯ \x1b[90m(thought for 1s)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "(thought for 1s)>" via scheduleSuggestion', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Strategy 1 won't match (no "Try"), so if gray detection somehow
      // passes a concatenated "(thought for 1s)>" string, scheduleSuggestion catches it
      p.feed('❯ \x1b[90m(thought for 1s)>\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects longer thinking durations like "(thought for 15s)"', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90m(thought for 15s)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "(thought for 1m 30s)" multipart duration', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90m(thought for 1m 30s)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "✻ Cooked for 1m 26s" sparkle indicator', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90m✻ Cooked for 1m 26s\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "✻ Cooked for 5s" short duration variant', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90m✻ Cooked for 5s\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "Cooked for 10s" without sparkle (cross-chunk)', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Cross-chunk: ❯ in buffer, thinking text arrives separately
      p.feed('❯ ');
      vi.advanceTimersByTime(50);
      p.feed('\x1b[90mCooked for 10s\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });
  });

  // === Parenthesized Placeholder Filtering ===

  describe('parenthesized placeholder filtering', () => {
    it('rejects "(no content)" via SGR 2 (dim)', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[2m(no content)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "(no content)" via SGR 90 (bright black)', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90m(no content)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "(loading...)"', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[2m(loading...)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "(empty)"', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90m(empty)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('rejects "(waiting for response)"', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[2m(waiting for response)\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('allows "fix the broken (auth) module" — parens in middle', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[90mfix the broken (auth) module\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('fix the broken (auth) module');
    });

    it('allows "(optional) refactor the code" — paren prefix with text after', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      p.feed('❯ \x1b[2m(optional) refactor the code\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('(optional) refactor the code');
    });
  });

  // === Combined SGR + Cross-chunk Detection ===

  describe('stacked ANSI + cross-chunk ghost text', () => {
    it('detects ghost text with stacked ANSI escapes (gray + italic)', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // \x1b[38;2;153;153;153m (gray) + \x1b[3m (italic) stacked
      p.feed('❯ \x1b[38;2;153;153;153m\x1b[3mrefactor the code\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');
    });

    it('detects ghost text with combined SGR params (2;90 = dim+bright-black)', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Combined SGR: dim + bright black in a single escape
      p.feed('❯ \x1b[2;90mrefactor the code\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('refactor the code');
    });

    it('detects cross-chunk ghost text (❯ and gray text in separate feeds)', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Chunk 1: just the prompt
      p.feed('❯ ');
      vi.advanceTimersByTime(50);

      // Chunk 2: gray ghost text (same terminal line, no \n)
      p.feed('\x1b[38;2;153;153;153mshow me the diff\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('show me the diff');
    });

    it('does NOT cross-chunk detect when chunk contains ⎿ output fence', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Chunk 1: prompt (triggers idle)
      p.feed('❯ ');
      vi.advanceTimersByTime(50);

      // Chunk 2: interrupt message with ⎿ fence — gray text but NOT ghost text
      p.feed('\x1b[5A⎿ \x1b[38;2;153;153;153mInterrupted · What should Claude do instead?\x1b[39m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });

    it('does NOT cross-chunk detect when new chunk has \\n (different line)', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Chunk 1: prompt
      p.feed('❯ ');
      vi.advanceTimersByTime(50);

      // Chunk 2: gray text on a NEW line (not continuation of prompt line)
      p.feed('\n\x1b[90msome status text\x1b[0m');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(0);
    });
  });

  // === Ghost Option from Stale Buffer Content ===

  describe('ghost option from stale buffer', () => {
    it('excludes stale numbered list items before actual option prompt', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Simulates: Claude's plan response has "3. ...", "4. ...", "5. Deploy"
      // followed by a 4-option approval prompt. The stale "5." should NOT
      // appear as a ghost 5th option.
      p.feed(
        '3. Implement the feature\n' +
        '4. Run tests\n' +
        '5. Deploy to staging\n' +
        '\n' +
        'Would you like to proceed?\n' +
        '\n' +
        '❯ 1. Yes, clear context (33% used) and auto-accept edits (shift+tab)\n' +
        '  2. Yes, auto-accept edits\n' +
        '  3. Yes, manually approve edits\n' +
        '  4. Type here to tell Claude what to change\n' +
        '\n' +
        'ctrl-g to edit in VS Code · ~/.claude/plans/crystalline-moseying-raccoon.md\n',
      );
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      // Exactly 4 real options, no ghost 5th
      expect(opts).toHaveLength(4);
      expect(opts[0]).toMatchObject({ index: 0 });
      expect(opts[3]).toMatchObject({ index: 3 });
      expect(opts.every((o: PromptOption) => o.index < 4)).toBe(true);
    });

    it('bypasses chunk size guard when ❯ cursor is present in large chunk', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Build a chunk whose non-ws chars exceed 200 — without ❯ cursor this
      // would be filtered out by the size guard as a "Claude response" false positive.
      const longPreamble =
        'This is a detailed plan description that includes many steps and explanations. ' +
        'Step one involves setting up the environment. Step two covers implementation. ' +
        'Step three is about testing. Step four handles deployment and monitoring.\n\n';
      p.feed(
        longPreamble +
        '❯ 1. Yes, clear context (33% used) and auto-accept edits (shift+tab)\n' +
        '  2. Yes, auto-accept edits\n' +
        '  3. Yes, manually approve edits\n' +
        '  4. Type here to tell Claude what to change\n' +
        '\n' +
        'ctrl-g to edit in VS Code · ~/.claude/plans/crystalline-moseying-raccoon.md\n',
      );
      vi.advanceTimersByTime(200);

      // Verify the chunk actually exceeds 200 non-ws chars (precondition)
      const fullChunk =
        longPreamble +
        '❯ 1. Yes, clear context (33% used) and auto-accept edits (shift+tab)\n' +
        '  2. Yes, auto-accept edits\n' +
        '  3. Yes, manually approve edits\n' +
        '  4. Type here to tell Claude what to change\n' +
        '\n' +
        'ctrl-g to edit in VS Code · ~/.claude/plans/crystalline-moseying-raccoon.md\n';
      expect(fullChunk.replace(/\s/g, '').length).toBeGreaterThan(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(4);
    });

    it('still works with scrambled TUI order after backward scan', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Stale content + scrambled options (ink TUI renders 2,1,3)
      p.feed(
        '5. Some old step\n' +
        '\n' +
        'Choose:\n' +
        '\n' +
        '  2. Sonnet\n' +
        '  1. Default\n' +
        '  3. Haiku\n',
      );
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
      expect(events[0].options[0]).toMatchObject({ index: 0, label: 'Default' });
    });

    it('excludes file path fragments from Read() tool in permission prompt', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      // Simulates: Read tool showing file path with D_01.png before permission options.
      // The "_01.png)" must NOT be normalized into a ghost option that overwrites "Yes".
      p.feed(
        '  Read(/tmp/agentdeck-thumbs/CAM_20260222191227_0013_D_01.png)\n' +
        '\n' +
        ' Do you want to proceed?\n' +
        '   1. Yes\n' +
        ' \u276F 2. Yes, allow reading from agentdeck-thumbs/ during this session\n' +
        '   3. No\n' +
        '\n' +
        ' Esc to cancel\n',
      );
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0]).toMatchObject({ index: 0, label: 'Yes' });
      expect(opts[1].label).toContain('Yes, allow');
      expect(opts[2]).toMatchObject({ index: 2, label: 'No' });
    });
  });

  describe('option index ordering', () => {
    it('returns options sorted by index even when TUI lines arrive out of order', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // TUI buffer has options in scrambled order: 2, 1, 3
      p.feed('  2. Sonnet\n  1. Default\n  3. Haiku\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0]).toMatchObject({ index: 0, label: 'Default' });
      expect(opts[1]).toMatchObject({ index: 1, label: 'Sonnet' });
      expect(opts[2]).toMatchObject({ index: 2, label: 'Haiku' });
    });
  });

  // === ANSI sequence split across chunks ===

  describe('split ANSI sequence buffering', () => {
    it('handles ANSI SGR codes split across chunks', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Chunk 1: incomplete SGR sequence (cut in the middle of color params)
      p.feed('❯ 1. Opus\x1b[0m\n  2. \x1b[38;2;177;185;249');
      // Chunk 2: completes the SGR sequence + text
      p.feed('mSonnet\x1b[0m\n  3. Haiku\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0]).toMatchObject({ index: 0, label: 'Opus' });
      expect(opts[1]).toMatchObject({ index: 1, label: 'Sonnet' });
      expect(opts[2]).toMatchObject({ index: 2, label: 'Haiku' });
    });

    it('handles bare ESC at end of chunk', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Option A\n  2. Option B\x1b');
      p.feed('[0m\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(2);
      expect(opts[0]).toMatchObject({ index: 0, label: 'Option A' });
      expect(opts[1]).toMatchObject({ index: 1, label: 'Option B' });
    });

    it('does not buffer complete ANSI sequences', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Complete SGR — should not be held back
      p.feed('  1. \x1b[1mBold\x1b[0m\n  2. Normal\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options[0]).toMatchObject({ index: 0, label: 'Bold' });
    });
  });

  // === Large chunk guard: numbered lists in response text ===

  describe('large chunk guard for option detection', () => {
    it('does NOT detect numbered items in large response chunks as options', () => {
      const p = armParser();
      const optionEvents = collectEvents(p, 'option_prompt');
      const permEvents = collectEvents(p, 'permission_prompt');
      const diffEvents = collectEvents(p, 'diff_prompt');

      // Simulate a large Claude response containing numbered items (>200 non-ws chars)
      const longResponse = [
        '잠재적 해결 방향:',
        '1. Output parser에서 AWAITING_DIFF 상태 중 diff 패턴이 사라진 청크(idle prompt나 spinner)를 감지하면 즉시 상태 전환하여 복구',
        '2. detectPatterns()에서 hasIdlePrompt와 hasInteractive가 동시 참일 때 현재 AWAITING 상태이면 idle를 우선하는 로직을 추가하여 해결',
        '3. Diff prompt가 ESC를 무시하는 경우라면 STUCK_TIMEOUT(현재 5분)을 더 짧게 조정하거나 PTY 입력 모니터링으로 ESC 키 입력을 감지하여 처리',
      ].join('\n');
      p.feed(longResponse + '\n');
      vi.advanceTimersByTime(200);

      expect(optionEvents).toHaveLength(0);
      expect(permEvents).toHaveLength(0);
      expect(diffEvents).toHaveLength(0);
    });

    it('still detects real options in small TUI chunks', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Small chunk — real interactive option prompt
      p.feed('  1. Default\n  2. Sonnet\n  3. Haiku\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
    });
  });

  // === CUP-positioned options (cursor positioning instead of newlines) ===

  describe('CUP-positioned options', () => {
    it('parses options using CUP (\\x1b[row;colH) instead of newlines', () => {
      const p = armParser();
      const permEvents = collectEvents(p, 'permission_prompt');

      // Simulates ink TUI output: options separated by CUP sequences, not \n
      const cupFeed =
        '  Bash command\x1b[4;3H' +
        '/Users/dev/project/openclaw models list --json 2>&1 | head -50\x1b[5;1H' +
        ' Do you want to proceed?\x1b[6;3H' +
        '  1. Yes\x1b[7;1H' +
        '\u276F 2. Yes, and don\'t ask again for: head:*\x1b[8;3H' +
        '  3. No\x1b[9;1H' +
        '  Esc to cancel \u00B7 ctrl+e to explain';
      p.feed(cupFeed);
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      const opts: PromptOption[] = permEvents[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0]).toMatchObject({ index: 0, label: 'Yes' });
      expect(opts[1].label).toContain('head:*');
      expect(opts[1].label).not.toContain('/Users/');
      expect(opts[2]).toMatchObject({ index: 2, label: 'No' });
    });

    it('parses options using CUD (\\x1b[B) for vertical movement', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Options separated by CUD (cursor down) sequences
      const cudFeed =
        '  1. Default\x1b[B' +
        '  2. Sonnet\x1b[B' +
        '  3. Haiku';
      p.feed(cudFeed);
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
      expect(events[0].options[0]).toMatchObject({ index: 0, label: 'Default' });
      expect(events[0].options[1]).toMatchObject({ index: 1, label: 'Sonnet' });
      expect(events[0].options[2]).toMatchObject({ index: 2, label: 'Haiku' });
    });
  });

  // === Trailing TUI chrome on last option ===

  describe('trailing TUI chrome stripping', () => {
    it('strips "Esc to cancel" from last option label', () => {
      const p = armParser();
      const permEvents = collectEvents(p, 'permission_prompt');

      // Last option concatenated with footer (no newline between)
      p.feed('❯1. Yes\n2. No  Esc to cancel \u00B7 ctrl+e to explain\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      const opts: PromptOption[] = permEvents[0].options;
      expect(opts).toHaveLength(2);
      expect(opts[0]).toMatchObject({ index: 0, label: 'Yes' });
      expect(opts[1]).toMatchObject({ index: 1, label: 'No' });
      expect(opts[1].label).not.toContain('Esc');
    });

    it('strips "Enter to confirm" from last option label', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('❯1. Default\n2. Sonnet\n3. Haiku  Enter to confirm \u00B7 Esc to exit\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts[2]).toMatchObject({ index: 2 });
      expect(opts[2].label).not.toContain('Enter');
      expect(opts[2].label).toContain('Haiku');
    });

    it('does NOT strip "Esc" when it appears within legitimate label text', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "Escape hatch" is a legitimate label word — only strip when preceded by 2+ spaces
      p.feed('❯1. Escape hatch\n2. Normal\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options[0].label).toContain('Escape hatch');
    });
  });

  // === CJK ghost text suggestion ===

  describe('CJK suggestion detection', () => {
    it('accepts ghost text containing CJK characters', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Strategy 1: "Try ..." pattern with CJK
      p.feed('❯ Try "코드를 리팩토링해봐"\n');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('코드를 리팩토링해봐');
    });

    it('accepts ghost text that is purely CJK (no ASCII words)', () => {
      const p = armParser();
      const events = collectEvents(p, 'suggested_prompt');

      // Strategy 2: gray ANSI segments with pure CJK on prompt line
      p.feed('❯ \x1b[90m버그를 수정해줘\x1b[0m\n');
      vi.advanceTimersByTime(600);

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('버그를 수정해줘');
    });
  });

  // === AskUserQuestion separator / description tolerance ===

  describe('AskUserQuestion with separators and descriptions', () => {
    it('handles AskUserQuestion with separator and descriptions', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed([
        '❯ 1. Option Alpha',
        '     Description for alpha.',
        '  2. Option Beta',
        '     Description for beta.',
        '  3. Option Gamma',
        '     Description for gamma.',
        '  4. Type something.',
        '────────────────────────────────────────',
        '  5. Chat about this',
        '  6. Skip interview and plan immediately',
        '',
        'Enter to select · ↑/↓ to navigate · Esc to cancel',
      ].join('\n'));
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(6);
      expect(events[0].options[0].label).toBe('Option Alpha');
      expect(events[0].options[5].label).toBe('Skip interview and plan immediately');
    });

    it('handles options starting from non-zero index (buffer truncation)', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Simulate buffer where option 1 was cut off
      p.feed('  2. Beta\n  3. Gamma\n  4. Delta\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
      expect(events[0].options[0].index).toBe(0); // re-indexed
      expect(events[0].options[0].label).toBe('Beta');
    });
  });

  // === Hierarchical CC prompt shapes ===
  //
  // Claude Code 2.x surfaces richer prompts than simple yes/no/always: plan
  // approvals (5+ options), OpenClaw OAuth scope pickers (numbered list with
  // long labels), etc. The popup UI rewrites itself per step — the parser
  // just has to classify each step's option set correctly and pass the full
  // labels through so the dashboard can render them verbatim instead of
  // collapsing everything into the legacy 3-button shape.

  describe('hierarchical CC prompt shapes', () => {
    it('captures 5-option plan approval with long labels', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed([
        'Here is the plan. Proceed?',
        '❯ 1. Approve and start in auto mode',
        '  2. Approve in acceptEdits mode',
        '  3. Approve in default mode',
        '  4. Keep planning',
        '  5. Refine with Ultraplan',
        '',
        'Enter to confirm · Esc to exit',
      ].join('\n'));
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(5);
      // Full labels must survive — the dashboard button reads the raw label.
      expect(opts[0].label).toBe('Approve and start in auto mode');
      expect(opts[2].label).toBe('Approve in default mode');
      expect(opts[4].label).toBe('Refine with Ultraplan');
      // Cursor tracked on ❯ line (option 1, re-indexed to 0).
      expect(events[0].navigable).toBe(true);
      expect(events[0].cursorIndex).toBe(0);
    });

    it('captures OpenClaw scope selection (numbered list)', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed([
        'Select authorization scope:',
        '❯ 1. user',
        '  2. project',
        '  3. session',
        '',
        'Enter to confirm · Esc to exit',
      ].join('\n'));
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts.map(o => o.label)).toEqual(['user', 'project', 'session']);
      expect(events[0].navigable).toBe(true);
      expect(events[0].cursorIndex).toBe(0);
    });

    it('captures OpenClaw token-action step (short numbered list)', () => {
      // After scope pick, Claude often surfaces a small "Grant / Cancel"
      // style follow-up. This confirms the parser emits it as its own
      // option_prompt so the popup can re-render per step instead of
      // freezing on the previous scope picker.
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed([
        'Open browser to complete OAuth?',
        '❯ 1. Grant access',
        '  2. Cancel',
      ].join('\n'));
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(2);
      expect(opts[0].label).toBe('Grant access');
      expect(opts[1].label).toBe('Cancel');
    });
  });

  describe('permission scroll does not trigger idle (Bug 1)', () => {
    it('scroll chunk with ❯ option text does NOT cause idle when navigable', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Initial permission prompt — sets lastNavigableEmit=true
      p.feed('❯ 1. Yes\n  2. Yes, and don\'t ask again for: file:*\n  3. No\n');
      vi.advanceTimersByTime(200);
      expect(permEvents).toHaveLength(1);

      // Simulate scroll: PTY redraws with ❯ on option text.
      // "❯ Yes, allow..." matches IDLE_PROMPT — but should NOT trigger idle.
      p.feed('\n \n  Yes\n \n❯ Yes, and don\'t ask again for: file:*\n \nctrl+e to explain');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
    });

    it('/model combined chunk: confirmation + idle prompt clears options', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Initial /model option prompt — sets lastNavigableEmit=true
      p.feed('❯ 1. Default (claude-sonnet-4-20250514)\n  2. claude-opus-4-20250514\n  3. claude-haiku-4-5-20251001\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);

      // User selects → confirmation text + idle prompt arrive as single chunk.
      // The bare idle line "❯ \n" should be detected even though
      // nonWsContent includes the confirmation text.
      p.feed('Set model to Default (claude-sonnet-4-20250514)\n\n❯ \n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(1);
    });

    it('/model separate chunks: ANSI reposition timer does not block idle', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Initial /model option prompt — sets lastNavigableEmit=true
      p.feed('❯ 1. Default (claude-sonnet-4-20250514)\n  2. claude-opus-4-20250514\n  3. claude-haiku-4-5-20251001\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);

      // Chunk 1: confirmation text (no ❯) — triggers ANSI reposition handler,
      // which sets optionTimer via setTimeout.
      p.feed('Set model to Default\n');

      // Chunk 2: genuine idle prompt. Should clear navigable state AND
      // cancel the stale optionTimer so idle is not suppressed at line 588.
      p.feed('❯ \n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(1);
    });

    it('cursor move chunk with option text does NOT falsely trigger idle', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Initial option prompt — sets lastNavigableEmit=true
      p.feed('❯ 1. Default\n  2. Sonnet\n  3. Haiku\n');
      vi.advanceTimersByTime(200);
      expect(optEvents).toHaveLength(1);

      // Cursor moves to "Sonnet" option. Contains ❯ + label text.
      // "❯ Sonnet" has a non-bare line, so should NOT trigger idle.
      p.feed('❯ Sonnet');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
    });

    it('genuine idle prompt exits navigable state and emits idle', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Initial permission prompt — sets lastNavigableEmit=true
      p.feed('❯ 1. Yes\n  2. No\n  3. Always\n');
      vi.advanceTimersByTime(200);
      expect(permEvents).toHaveLength(1);

      // Esc/selection → tiny idle prompt "❯ \n" arrives.
      // Only ❯ char as non-ws (nonWs=1, < 2) → genuine idle, not cursor-move.
      p.feed('❯ \n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(1);
    });
  });

  describe('TUI cursor-overwrite label correction (Bug 2)', () => {
    it('fixes contaminated permission option label using correction line', () => {
      const p = armParser();
      const permEvents = collectEvents(p, 'permission_prompt');

      // First TUI draw: full command text contaminates option 2
      p.feed(
        ' 1. Yes\n' +
        '\n' +
        '\n' +
        ' 2. Yes, and don\'t ask again for: file "/Users/puritysb/Desktop/AgentDeck"/* 2>/dev/nul\n',
      );

      // Correction draw: CUP-repositioned ":*" with trailing spaces
      p.feed('\n \n:*                                                \n');

      // Third draw with cursor and full option set
      p.feed('❯ 1. Yes\n  2. Yes, and don\'t ask again for: file:*\n  3. No\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      const opts = permEvents[0].options;
      // Option 2 should have the corrected label, not the contaminated one
      const opt2 = opts.find((o: PromptOption) => /don.t ask again/i.test(o.label));
      expect(opt2).toBeDefined();
      expect(opt2!.label).toContain('file:*');
      expect(opt2!.label).not.toContain('/Users/');
      expect(opt2!.label).not.toContain('2>/dev/nul');
    });

    it('leaves labels unchanged when no correction line is present', () => {
      const p = armParser();
      const permEvents = collectEvents(p, 'permission_prompt');

      p.feed('❯ 1. Yes\n  2. Yes, and don\'t ask again for: file:*\n  3. No\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      const opt2 = permEvents[0].options.find((o: PromptOption) => /don.t ask again/i.test(o.label));
      expect(opt2).toBeDefined();
      expect(opt2!.label).toContain('file:*');
    });
  });

  // === Genuine Idle Detection (Semantic) ===

  describe('genuine idle detection (semantic)', () => {
    it('"❯ \\n" is genuine idle — only prompt character, no label text', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Establish navigable state with non-permission labels
      p.feed('❯ 1. Alpha\n  2. Beta\n');
      vi.advanceTimersByTime(200);
      expect(optEvents.length).toBeGreaterThan(0);

      // Genuine idle: "❯" is the only non-whitespace character
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(1);
    });

    it('"❯ Beta" is NOT idle — has label text after prompt char', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Establish navigable state
      p.feed('❯ 1. Alpha\n  2. Beta\n');
      vi.advanceTimersByTime(200);
      expect(optEvents.length).toBeGreaterThan(0);

      // Cursor move to "Beta" option — should NOT be idle
      p.feed('❯ Beta');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(0);
    });

    it('"❯ A" is NOT idle — single-char label still counts', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Establish navigable state
      p.feed('❯ 1. Alpha\n  2. Bravo\n');
      vi.advanceTimersByTime(200);
      expect(optEvents.length).toBeGreaterThan(0);

      // Cursor move — "❯A" has nonWs content beyond just ❯
      p.feed('❯ A');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(0);
    });

    it('">" also treated as idle prompt character', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const idleEvents = collectEvents(p, 'idle');
      p.feed('> \n');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(1);
    });
  });

  // === Effort Level Parsing ===

  describe('effort level parsing', () => {
    // Real PTY patterns from Claude Code /model UI:
    // During selection: "▌ High effort ← → to adjust"
    // Confirmation: "with high effort"
    // Model info line: "Opus 4.6 with high effort · Claude Max"

    it('detects "High effort" selection pattern', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('▌ High effort ← → to adjust\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'high' });
    });

    it('detects "Medium effort" selection pattern', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('▌▌ Medium effort (default) ← → to adjust\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'medium' });
    });

    it('detects "Low effort" selection pattern', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('▌ Low effort ← → to adjust\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'low' });
    });

    it('detects "with high effort" confirmation line', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('Set model to Default (Opus 4.6) with high effort\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'high' });
    });

    it('detects effort in model info line', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('Opus 4.6 with high effort · Claude Max\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'high' });
    });

    it('caches effort level — no re-emit on same value', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('High effort ← → to adjust\n');
      p.feed('High effort ← → to adjust\n');
      expect(events).toHaveLength(1);
    });

    it('emits on effort level change', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('High effort ← → to adjust\n');
      p.feed('Low effort ← → to adjust\n');
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({ level: 'low' });
    });

    it('resets effort level on reset()', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('High effort ← → to adjust\n');
      p.reset();
      p.feed('High effort ← → to adjust\n');
      expect(events).toHaveLength(2);
    });

    it('does not match "effort" in unrelated context', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('▌▌▌ effort ← → to adjust\n');
      // The initial indicator line has no level word before "effort"
      expect(events).toHaveLength(0);
    });

    it('does not match effort inside numbered option lines', () => {
      const p = armParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('  1. High effort quality\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(0);
    });

    it('getter returns current effort level', () => {
      const p = createParser();
      expect(p.getEffortLevel()).toBeNull();
      p.feed('Low effort ← → to adjust\n');
      expect(p.getEffortLevel()).toBe('low');
    });

    // Claude Code 2.1+ effort variants exposed via /model
    it('detects "Max effort" (Opus 4.7 variant)', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('▌ Max effort ← → to adjust\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'max' });
    });

    it('detects "xhigh effort" (Opus 4.7 variant)', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('▌ xhigh effort ← → to adjust\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'xhigh' });
    });

    it('detects "default effort" (per-model default variant)', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('Set model to Opus 4.7 (1M context) (default) with default effort\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'default' });
    });

    it('detects "fast effort" (Opus 4.6 variant)', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('▌ Fast effort ← → to adjust\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'fast' });
    });

    it('detects effort in /model confirmation line with max', () => {
      const p = createParser();
      const events = collectEvents(p, 'effort_level');
      p.feed('Set model to Opus 4.7 (1M context) (default) with max effort\n');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ level: 'max' });
    });
  });
});
