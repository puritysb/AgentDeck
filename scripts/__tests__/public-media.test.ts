import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

const ROOT = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const overview = read('scripts/pages-index.html');
const readme = read('README.md');
const workflow = read('.github/workflows/test-report.yml');

describe('public language selection contract', () => {
  it('offers full native names aligned with the supported catalog locales', () => {
    const nav = read('scripts/pages-nav.html');
    const catalog = JSON.parse(read('agentdeck-design-system/catalog.json'));
    const options = [...nav.matchAll(/<option value="([^"]+)" lang="([^"]+)">([^<]+)<\/option>/g)];
    expect(options.map(option => option[1])).toEqual(catalog.locales);
    expect(options.map(option => option[3])).toEqual(['English', '한국어', '日本語']);
    expect(options.every(option => option[1] === option[2])).toBe(true);
    // The native select retains keyboard/touch semantics and stays outside the
    // horizontally scrolling link row, so it remains reachable at small widths.
    expect(nav).toMatch(/<\/div>\s*<label class="ad-language-control" data-language-control>/);
    expect(nav).toContain('<select id="lang" class="lang" aria-label="Language">');
    const specimen = read('agentdeck-design-system/viewer/app.js');
    expect(specimen).toContain("document.querySelector('[data-language-control]').outerHTML");
  });
  it('loads the CJK faces on every public surface that offers those languages', () => {
    for (const page of ['scripts/pages-index.html', 'docs/hardware/index.html', 'tools/creature-simulator/index.html',
      'tools/web-flasher/index.html', 'agentdeck-design-system/viewer/index.html', 'scripts/generate-html-report.py']) {
      expect(read(page), page).toContain('family=IBM+Plex+Sans+KR');
      expect(read(page), page).toContain('family=IBM+Plex+Sans+JP');
    }
  });
});

describe('current habitat publication', () => {
  it('keeps native evidence, host renders and the composite distinguishable and intact', () => {
    const manifest = JSON.parse(read('docs/media/current/manifest.json'));
    const assets = new Map<string, any>(manifest.assets.map((asset: any) => [asset.file, asset]));
    for (const [file, asset] of assets) {
      const bytes = readFileSync(join(ROOT, 'docs/media/current', file));
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(asset.sha256);
      expect(asset.bytes, file).toBe(bytes.length);
    }
    expect(assets.get('shared-home.mp4').kind).toBe('native-app-recording');
    expect(assets.get('macos-working.png').kind).toBe('native-app-capture');
    expect(assets.get('trmnl_75-working.png').kind).toBe('firmware-host-render');
    const composite = assets.get('box86-composite.png');
    expect(composite.kind).toBe('ai-composite');
    expect(composite.inputs.map((input: any) => input.file)).toEqual([
      'docs/media/box86.jpg', 'docs/media/current/box86-working.png', 'docs/media/current/composite-prompt.txt',
    ]);
    for (const input of composite.inputs) {
      expect(createHash('sha256').update(readFileSync(join(ROOT, input.file))).digest('hex')).toBe(input.sha256);
    }
    const catalog = read('docs/hardware/index.html');
    expect(catalog).toMatch(/data-evidence="ai-composite"[\s\S]*?AI-assisted composite/);
    expect(catalog).toContain('Original desk photographs remain below.');
    expect(read('docs/pages-site.md')).toContain('not physical-device evidence');
  });

  it('publishes a controlled, captioned current recording and all referenced current assets', () => {
    const html = section('current-habitat');
    const [video] = tags(html, 'video');
    expect(video).toHaveProperty('controls');
    expect(video).toHaveProperty('playsinline');
    expect(video).not.toHaveProperty('autoplay');
    expect(video!.preload).toBe('none');
    expect(video!['aria-describedby']).toBe('current-caption');
    expect(tags(html, 'track').map(track => track.srclang)).toEqual(['en', 'ko', 'ja']);
    for (const media of mediaReferences(html)) expect(statSync(join(ROOT, 'docs', media)).size).toBeGreaterThan(0);
    expect(workflow).toContain('cp -R docs/media/current _site/media/');
    expect(readme).toContain('#current-habitat');
  });

  it('offers the newer residents in the interactive controls', () => {
    const page = read('tools/creature-simulator/index.html');
    for (const agent of ['kiro', 'hermes', 'dot']) expect(page).toContain(`<option value="${agent}">`);
  });
});

// These authored fragments use ordinary quoted attributes and boolean controls;
// inspect their contracts without introducing a browser or image decoder.
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)].map((match) => [
      match[1]!.toLowerCase(),
      match[2] ?? match[3] ?? '',
    ]),
  );
}
function tags(html: string, name: string) {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((match) => attributes(match[1]!));
}
function section(id: string) {
  const match = [...overview.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)].find(
    (candidate) => attributes(candidate[1]!).id === id,
  );
  expect(match, `overview section #${id}`).toBeDefined();
  return match![2]!;
}
function mediaReferences(html: string) {
  return [...new Set([...html.matchAll(/(?:src|href|poster)=["'](media\/[^"']+)["']/g)].map((match) => match[1]!))];
}
function globMatches(pattern: string, file: string) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`).test(file);
}

describe('public 1.8.0 media integration', () => {
  it('links the README supplement to the actual overview section and real local stills', () => {
    expect(readme).toContain('https://puritysb.github.io/AgentDeck/#showcase-180');
    const html = section('showcase-180');
    const references = mediaReferences(html);
    expect(references).toContain('media/aquarium-180-showcase.mp4');
    expect(references.filter((path) => path.endsWith('.jpg')).sort()).toEqual([
      'media/aquarium-180-ci.jpg',
      'media/aquarium-180-complete.jpg',
      'media/aquarium-180-overview.jpg',
    ]);
    for (const path of references) {
      const asset = statSync(join(ROOT, 'docs', path));
      expect(asset.isFile(), path).toBe(true);
      expect(asset.size, path).toBeGreaterThan(0);
    }
    for (const image of references.filter((path) => path.endsWith('.jpg'))) {
      expect(readme, image).toContain(`docs/${image}`);
    }
  });

  it('keeps the original introduction and makes both videos user-controlled with accessible captions', () => {
    // A supplement must not silently relabel or replace the historical take.
    const introduction = overview.match(/<figure\b[^>]*\bid="aquarium"[^>]*>([\s\S]*?)<\/figure>/)?.[1];
    expect(introduction).toBeDefined();
    expect(tags(introduction!, 'source')[0]?.src).toBe('media/aquarium-demo.mp4');
    expect(readme).toContain('docs/media/aquarium-preview.gif');
    for (const html of [introduction!, section('showcase-180')]) {
      const players = tags(html, 'video');
      expect(players).toHaveLength(1);
      const video = players[0]!;
      expect(video).toHaveProperty('controls');
      expect(video).toHaveProperty('playsinline');
      expect(video.preload).toBe('none');
      expect(video).not.toHaveProperty('autoplay');
      expect(video['aria-describedby']).toBeTruthy();
      expect(html).toContain(`id="${video['aria-describedby']}"`);
      const tracks = tags(html, 'track');
      expect(tracks.map((track) => track.srclang).sort()).toEqual(['en', 'ja', 'ko']);
      expect(tracks.filter((track) => 'default' in track).map((track) => track.srclang)).toEqual(['en']);
      for (const track of tracks) {
        expect(track.kind).toBe('captions');
        expect(track.label).toBeTruthy();
        expect(track.src).toMatch(new RegExp(`\\.${track.srclang}\\.vtt$`));
      }
    }
    for (const image of tags(section('showcase-180'), 'img')) {
      expect(image.alt?.trim()).toBeTruthy();
      expect(image.loading).toBe('lazy');
    }
  });

  it('publishes every referenced supplement asset through the actual Pages copy commands', () => {
    const copyLines = workflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('cp ') && line.includes(' _site/media/'));
    const files = readdirSync(join(ROOT, 'docs/media'));
    for (const reference of mediaReferences(section('showcase-180'))) {
      const source = `docs/media/${basename(reference)}`;
      const matching = copyLines.filter((line) => line.split(/\s+/).some((token) => globMatches(token, source)));
      expect(matching.length, `Pages assembly omits ${source}`).toBeGreaterThan(0);
      expect(files).toContain(basename(reference));
      // MP4/captions must fail assembly when missing, rather than disappear silently.
      if (/\.(mp4|vtt)$/.test(source)) {
        expect(
          matching.some((line) => !line.includes('||')),
          source,
        ).toBe(true);
      }
    }
  });

  it('ships nonempty, ordered WebVTT cues for each supplement caption track', () => {
    const seconds = (stamp: string) => {
      const parts = stamp.split(':').map(Number);
      return parts.reduce((total, part) => total * 60 + part, 0);
    };
    for (const track of tags(section('showcase-180'), 'track')) {
      const text = read(`docs/${track.src}`);
      expect(text.replace(/^\uFEFF/, '')).toMatch(/^WEBVTT(?:\r?\n|\s)/);
      const cues = [
        ...text.matchAll(
          /^(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s+-->\s+(\d{2}:\d{2}(?::\d{2})?\.\d{3})[^\n]*\r?\n([^\n]+)/gm,
        ),
      ];
      expect(cues.length, track.src).toBeGreaterThan(0);
      let previousEnd = 0;
      for (const cue of cues) {
        const start = seconds(cue[1]!);
        const end = seconds(cue[2]!);
        expect(start, track.src).toBeGreaterThanOrEqual(previousEnd);
        expect(end, track.src).toBeGreaterThan(start);
        expect(cue[3]!.trim(), track.src).toBeTruthy();
        previousEnd = end;
      }
    }
    // Duration and actual subtitle playback belong to media inspection; this
    // unit contract deliberately has no ffprobe or video/pixel dependency.
  });
});
