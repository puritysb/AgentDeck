import { describe, it, expect } from 'vitest';
import {
  renderReviewHtml, renderJudgeGuidanceHtml, judgeTierNote,
  reviewBrowserCommand,
  type ReviewFinding,
} from '../review-runner.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

describe('review browser opening', () => {
  it.each(['review with spaces.html', 'review&echo injected.html', 'review%PATH%.html', 'review$(echo injected).html', 'review`echo injected`.html', 'review\"quoted\".html'])('keeps %s as a file URL argument without a command interpreter', (name) => {
    const path = resolve('fixture reviews', name);
    const windows = reviewBrowserCommand(path, 'win32');
    expect(windows.file).toBe('rundll32.exe');
    expect(windows.args).toHaveLength(2);
    expect(windows.args[0]).toBe('url.dll,FileProtocolHandler');
    expect(fileURLToPath(windows.args[1])).toBe(path);
    expect(windows.args[1]).toMatch(/^file:\/\//);
    for (const platform of ['darwin', 'linux'] as const) {
      const command = reviewBrowserCommand(path, platform);
      expect(command.file).toBe(platform === 'darwin' ? 'open' : 'xdg-open');
      expect(command.args).toEqual([windows.args[1]]);
    }
  });
});

const FINDINGS: ReviewFinding[] = [
  { severity: 'high', title: 'rm -rf on user path', detail: 'destructive', file: 'x.sh' },
  { severity: 'low', title: 'TODO left', detail: 'incomplete' },
];

describe('renderReviewHtml', () => {
  it('is self-contained (no external asset URLs) and shows risk + findings', () => {
    const html = renderReviewHtml({
      projectName: 'proj', sessionLabel: 'sid',
      outcome: { risk: 'high', summary: 'risky change', findings: FINDINGS, backend: 'mlx:qwen3-30b' },
      deltaStat: ' x.sh | 3 +++', generatedAt: new Date(0),
      tierNote: judgeTierNote('mlx'),
    });
    expect(html).not.toMatch(/https?:\/\//); // fully offline
    expect(html).toContain('RISK HIGH');
    expect(html).toContain('rm -rf on user path');
    expect(html).toContain('mlx:qwen3-30b');
    expect(html).toContain('judge tier'); // tier note in footer
  });

  it('escapes HTML in judge-provided text (no injection)', () => {
    const html = renderReviewHtml({
      projectName: 'p', sessionLabel: 's',
      outcome: { risk: 'low', summary: '<script>alert(1)</script>', findings: [], backend: 'b' },
      deltaStat: '', generatedAt: new Date(0),
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('empty findings renders a calm "nothing worth flagging" note, not an empty grid', () => {
    const html = renderReviewHtml({
      projectName: 'p', sessionLabel: 's',
      outcome: { risk: 'low', summary: 'clean', findings: [], backend: 'foundation-models' },
      deltaStat: '', generatedAt: new Date(0),
    });
    expect(html).toContain('No risky findings');
  });
});

describe('judgeTierNote — honest capability labelling', () => {
  it('flags on-device models as basic screening', () => {
    expect(judgeTierNote('foundationModels')).toMatch(/basic screening/i);
  });
  it('flags local MLX depth as model-size dependent', () => {
    expect(judgeTierNote('mlx')).toMatch(/8B|model size/i);
  });
  it('does not append a caveat for frontier backends', () => {
    expect(judgeTierNote('api')).toBeUndefined();
    expect(judgeTierNote('openclaw')).toBeUndefined();
  });
});

describe('renderJudgeGuidanceHtml — no-judge setup flow', () => {
  it('ranks API → OpenRouter → OpenClaw → local → Apple, and states the local model minimum', () => {
    const html = renderJudgeGuidanceHtml({ backend: 'foundationModels', reason: 'not ready' });
    const apiIdx = html.indexOf('Anthropic API');
    const openrouterIdx = html.indexOf('OpenRouter');
    const openclawIdx = html.indexOf('OpenClaw gateway');
    const localIdx = html.indexOf('Local Ollama');
    const appleIdx = html.indexOf('Apple Intelligence');
    expect(apiIdx).toBeGreaterThan(0);
    expect(apiIdx).toBeLessThan(openrouterIdx);
    expect(openrouterIdx).toBeLessThan(openclawIdx);
    expect(openclawIdx).toBeLessThan(localIdx);
    expect(localIdx).toBeLessThan(appleIdx);
    expect(html).toMatch(/8B/); // realistic local minimum
    expect(html).toMatch(/ANTHROPIC_API_KEY|ant auth login/);
    // OpenRouter path uses the generic openai backend.
    expect(html).toContain('openrouter.ai/api/v1');
  });

  it('reassures that not using REVIEW is a supported choice (no background nagging)', () => {
    const html = renderJudgeGuidanceHtml({ backend: 'mlx' });
    expect(html).toMatch(/Not planning to use REVIEW/i);
    expect(html).toMatch(/nothing runs in the background/i);
  });

  it('surfaces the current backend + reason so the user knows what failed', () => {
    const html = renderJudgeGuidanceHtml({ backend: 'mlx', model: 'tinyllama', reason: 'connection refused' });
    expect(html).toContain('mlx');
    expect(html).toContain('tinyllama');
    expect(html).toContain('connection refused');
  });
});

import { openAIChatUrl } from '../apme/runner.js';

describe('openAIChatUrl — endpoint normalization (Ollama / OpenRouter / LM Studio)', () => {
  it('bare host → /v1/chat/completions', () => {
    expect(openAIChatUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
  it('base with /v1 → appends chat/completions', () => {
    expect(openAIChatUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions');
  });
  it('already-full URL is preserved', () => {
    expect(openAIChatUrl('http://127.0.0.1:1234/v1/chat/completions')).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });
  it('trailing slash tolerated', () => {
    expect(openAIChatUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
});

describe('renderJudgeGuidanceHtml — detected local providers', () => {
  it('surfaces detected servers with a ready-to-paste openai config', () => {
    const html = renderJudgeGuidanceHtml({
      backend: 'foundationModels', reason: 'change too large',
      detected: [{ provider: 'ollama', label: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1', models: ['qwen2.5-coder:32b', 'llama3.1:8b'] }],
    });
    expect(html).toContain('Detected on this machine');
    expect(html).toContain('Ollama');
    expect(html).toContain('http://127.0.0.1:11434/v1');
    expect(html).toContain('qwen2.5-coder:32b');
    expect(html).toContain('"backend": "openai"');
  });
  it('omits the detected block when nothing is running', () => {
    const html = renderJudgeGuidanceHtml({ backend: 'foundationModels', detected: [] });
    expect(html).not.toContain('Detected on this machine');
    // Still lists OpenRouter + local options as opt-in.
    expect(html).toContain('OpenRouter');
    expect(html).toContain('Ollama');
  });
});
