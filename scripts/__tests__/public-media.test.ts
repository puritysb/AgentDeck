import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const ROOT = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const overview = read('scripts/pages-index.html');
const readme = read('README.md');
const workflow = read('.github/workflows/test-report.yml');

describe('public language selection contract', () => {
  it('recomputes fragment clearance when translated navigation wraps', () => {
    const nav = read('scripts/pages-nav.html');
    const script = /<script>([\s\S]*?)<\/script>/.exec(nav)![1]!;
    let height = 68;
    let resized: (() => void) | undefined;
    const values = new Map<string, string>();
    runInNewContext(script, {
      document: {
        querySelector: () => ({ getBoundingClientRect: () => ({ height }) }),
        documentElement: { style: { setProperty: (key: string, value: string) => values.set(key, value) } },
      },
      window: { ResizeObserver: true },
      ResizeObserver: class {
        constructor(callback: () => void) { resized = callback; }
        observe() {}
      },
    });
    expect(values.get('--pages-nav-height')).toBe('68px');
    height = 184; // longer labels make a third row at a narrow viewport
    resized!();
    expect(values.get('--pages-nav-height')).toBe('184px');
  });
  it('offers full native names aligned with the supported catalog locales', () => {
    const nav = read('scripts/pages-nav.html');
    const catalog = JSON.parse(read('agentdeck-design-system/catalog.json'));
    const options = [...nav.matchAll(/<option value="([^"]+)" lang="([^"]+)">([^<]+)<\/option>/g)];
    expect(options.map(option => option[1])).toEqual(catalog.locales);
    expect(options.map(option => option[3])).toEqual(['English', '한국어', '日本語']);
    expect(options.every(option => option[1] === option[2])).toBe(true);
    // One locale list feeds the styled menu and no-JS native fallback.
    // The control remains outside the horizontally scrolling link row.
    expect(nav).toMatch(/<\/div>\s*<div class="ad-language-control" data-language-control>/);
    expect(nav).toContain('<select id="lang" class="lang" aria-label="Language">');
    expect(nav).toContain('const options = [...control.options].map(source =>');
    expect(nav).toContain('role="menuitemradio"');
    expect(nav).toContain('aria-haspopup="menu"');
    const specimen = read('agentdeck-design-system/viewer/app.js');
    expect(specimen).toContain("document.querySelector('[data-language-control]').cloneNode(true)");
    expect(specimen).toContain("document.querySelector('[data-language-menu]').cloneNode(true)");
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

describe('archived aquarium recordings', () => {
  // The 2026-11-06 cleanup removed these from the overview and README, but older
  // links and store records still point at the files, so they stay published.
  const archived = [
    'aquarium-demo.mp4',
    'aquarium-180-showcase.mp4',
    'aquarium-180-overview.jpg',
    'aquarium-180-ci.jpg',
    'aquarium-180-complete.jpg',
  ];

  it('no longer embeds them on the overview or links their removed sections', () => {
    expect(overview).not.toMatch(/id="(?:showcase-180|aquarium)"/);
    for (const file of archived) expect(overview, file).not.toContain(`media/${file}`);
    expect(readme).not.toMatch(/AgentDeck\/#(?:showcase-180|aquarium)\b/);
  });

  it('keeps every archived file in the repository and in the Pages copy commands', () => {
    const copyLines = workflow
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('cp ') && line.includes(' _site/'));
    const files = readdirSync(join(ROOT, 'docs/media'));
    for (const file of archived) {
      expect(files, file).toContain(file);
      const source = `docs/media/${file}`;
      expect(
        copyLines.some((line) => line.split(/\s+/).some((token) => globMatches(token, source))),
        `Pages assembly omits ${source}`,
      ).toBe(true);
    }
  });
});

describe('whole-product 2.0 introduction', () => {
  it('waits for metadata before a chapter click seeks an unloaded video', () => {
    const script = [...overview.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map(m => m[1]!).find(s => s.includes("querySelectorAll('[data-tour-seek]')"))!;
    let click: () => void = () => {};
    let loaded: () => void = () => {};
    let played = 0;
    let loads = 0;
    const video = { readyState: 0, currentTime: 0,
      play: () => { played++; return Promise.resolve(); }, load: () => { loads++; },
      addEventListener: (event: string, callback: () => void) => { expect(event).toBe('loadedmetadata'); loaded = callback; },
    };
    runInNewContext(script, { document: {
      querySelectorAll: () => [{ dataset: { tourSeek: '28' }, addEventListener: (_: string, callback: () => void) => { click = callback; } }],
      getElementById: () => video,
    }});
    click();
    expect(loads).toBe(1); expect(video.currentTime).toBe(0); expect(played).toBe(0);
    video.readyState = 1; loaded();
    expect(video.currentTime).toBe(28); expect(played).toBe(1);
  });

  it('keeps the product tour primary and the real control take a separate feature detail', () => {
    const html = section('product-tour');
    expect(overview.indexOf('id="product-tour"')).toBeLessThan(overview.indexOf('id="controller-workflow"'));
    expect(readme).toContain('#product-tour');
    expect(tags(html, 'source')[0]?.src).toBe('media/current/agentdeck-200-product-tour.mp4');
    expect(tags(section('controller-workflow'), 'source')[0]?.src).toBe('media/current/agentdeck-200-workflow.mp4');
    expect(tags(html, 'track').map(t => t.srclang)).toEqual(['en', 'ko', 'ja']);
    const video = tags(html, 'video')[0]!;
    expect(video).toHaveProperty('controls');
    expect(video).not.toHaveProperty('autoplay');
    expect(video.preload).toBe('none');
    for (const media of mediaReferences(html)) expect(statSync(join(ROOT, 'docs', media)).size).toBeGreaterThan(0);
  });
  it('covers the product beyond approval and keeps chapter, source and caption clocks aligned', () => {
    const story = JSON.parse(read('scripts/product-tour-story.json'));
    const cuts = JSON.parse(read('docs/media/current/agentdeck-200-product-tour-cuts.json'));
    const ids = story.chapters.map((c: any) => c.id);
    for (const id of ['overview','tablet','session','collaboration','usage','answer','controllers',
      'native-controls','evaluation','evidence','eink','compact','led','terminal']) expect(ids).toContain(id);
    expect(cuts.duration).toBeGreaterThan(120);
    expect(cuts.duration).toBeLessThan(180);
    let at = 0;
    for (const [i, c] of story.chapters.entries()) {
      expect(c.duration).toBeGreaterThanOrEqual(8);
      expect(cuts.chapters[i].start).toBeCloseTo(at, 3);
      at += c.duration;
      expect(cuts.chapters[i].end).toBeCloseTo(at, 3);
      expect(cuts.chapters[i].proof).toBe(c.proof);
      expect(cuts.chapters[i].layers.every((l: any) => /^[a-f0-9]{64}$/.test(l.sha256))).toBe(true);
      for (const locale of ['en','ko','ja']) expect(c[locale].length).toBeGreaterThan(10);
    }
    expect(cuts.duration).toBeCloseTo(at, 3);
    const bytes = readFileSync(join(ROOT, 'docs/media/current/agentdeck-200-product-tour.mp4'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(cuts.videoSha256);
    const html = section('product-tour');
    for (const button of tags(html, 'button')) {
      const target = Number(button['data-tour-seek']);
      expect(cuts.chapters.some((c: any) => Math.abs(c.start - target) < .001)).toBe(true);
    }
  });
});
