import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { appIconExports, resizeIconPixels, generateAppIcons } from '../generate-app-icons.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('AgentDeck app icon exports', () => {
  it('keeps a transparent master large enough for the Store export, with recorded edit provenance', async () => {
    const master = await sharp(resolve(root, 'design/brand/agentdeck-icon.png')).metadata();
    const recipe = JSON.parse(readFileSync(resolve(root, 'design/brand/agentdeck-icon.recipe.json'), 'utf8'));
    expect(master.width).toBeGreaterThanOrEqual(1024);
    expect(master.width).toBe(master.height);
    expect(master.hasAlpha).toBe(true);
    expect([master.width, master.height]).toEqual([recipe.output.width, recipe.output.height]);
    expect(createHash('sha256').update(readFileSync(resolve(root, recipe.output.path))).digest('hex')).toBe(recipe.output.sha256);
    expect(recipe.input.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(recipe.prompts.every((prompt: string) => prompt.length > 100)).toBe(true);
  });

  it('matches every active export to the master and platform alpha policy', async () => {
    await expect(generateAppIcons({ check: true })).resolves.toBe(appIconExports.length);
  }, 30_000);

  it('averages colour by coverage without bleeding invisible RGB into transparent edges', () => {
    const pixels = Buffer.from([255,0,0,255, 0,255,0,0, 0,0,255,255, 0,255,0,0]);
    expect([...resizeIconPixels(pixels, 2, 1)]).toEqual([128, 0, 128, 128]);
    expect([...resizeIconPixels(pixels, 2, 1, [0, 0, 0])]).toEqual([64, 0, 64]);
    expect([...resizeIconPixels(pixels, 2, 1, [255, 255, 255])]).toEqual([191, 128, 191]);
  });

  it('uses exact area weights at fractional reduction ratios and refuses enlargement', () => {
    const row = [0,0,0,255, 120,120,120,255, 240,240,240,255];
    const pixels = Buffer.from([...row, ...row, ...row]);
    expect([...resizeIconPixels(pixels, 3, 2)]).toEqual([
      40,40,40,255, 200,200,200,255, 40,40,40,255, 200,200,200,255,
    ]);
    expect(() => resizeIconPixels(pixels, 3, 4)).toThrow('reduction');
  });

  it('covers every configured Apple app icon slot and Android launcher density', () => {
    const catalog = JSON.parse(readFileSync(resolve(root, 'apple/AgentDeck/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json'), 'utf8'));
    const outputs = new Set(appIconExports.map((entry: { path: string }) => entry.path));
    for (const image of catalog.images) {
      expect(outputs.has(`apple/AgentDeck/Resources/Assets.xcassets/AppIcon.appiconset/${image.filename}`)).toBe(true);
    }
    const manifest = readFileSync(resolve(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('android:icon="@mipmap/ic_launcher"');
    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      expect(outputs.has(`android/app/src/main/res/mipmap-${density}/ic_launcher.png`)).toBe(true);
    }
  });
});
