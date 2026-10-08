import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const overview = read('scripts/pages-index.html');
const readme = read('README.md');
const workflow = read('.github/workflows/test-report.yml');

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
