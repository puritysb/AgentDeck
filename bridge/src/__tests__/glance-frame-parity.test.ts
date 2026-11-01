import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { buildGlance } from '../card-feed.js';
import type { SessionInfo } from '@agentdeck/shared';
import type { UsageEvent } from '../types.js';
import { GLANCE_POLICY } from '@agentdeck/shared';
import { renderGlanceFrame, renderGlanceFrameSvg, GLANCE_FRAME_BOARDS, type GlanceFrameInput } from '../glance-frame.js';
import { emitGlancePolicy, emitTypeScriptPolicy, OUTPUT } from '../../../scripts/generate-glance-policy.mjs';

const glance = {
  weather: { place: '서울 & Tokyo <home>', tempC: -2.5, code: 0, summary: '맑음 晴れ', todayMinC: -4, todayMaxC: 8,
    rain: { startHm: '14:00', endHm: '15:20', probability: 65, amountMm: 1.5 },
    tomorrow: { summary: 'Cloudy', minC: 0, maxC: 9, rainProbability: 0 } },
  usage: [{ provider: 'claude' as const, label: 'Claude', primaryPercent: 99.5, primaryResetHm: '19:40', secondaryPercent: 0, stale: true },
    { provider: 'codex' as const, label: 'Codex', primaryPercent: 12.5, secondaryPercent: 101, stale: false }],
  events: [{ title: 'Review & "verify" — 日本語 한국어 ' + 'very long '.repeat(12), startHm: '09:00', endHm: '10:00' }, { title: 'All day' }],
  wrapup: ['AgentDeck · Render 🚀 é e\u0301 <> &', 'Wim il1.,\t spaces\u00a0\ufeff ' + '가日本語'.repeat(60), ...Array(30).fill('more')],
};
const snapshots = [
  {sessions:[{projectName:'BOM',state:'processing',activity:'\ufeff task \ufeff'},{projectName:'Unicode',state:'idle',activity:'\u0085'}]},
  { sessions: [] },
  { sessions: [
    { projectName: 'idle', state: 'idle' }, { projectName: 'working', state: 'processing', currentTask: ' task ' },
    { projectName: 'approval', state: 'idle', requestId: 'r' }, { projectName: 'needs', state: 'awaiting_permission' },
    { projectName: '日本語한국어'.repeat(16), state: 'error', activity: ' review ' },
  ], usage: { fiveHourPercent: 21.5, sevenDayPercent: 100.4, fiveHourResetsAt: '2026-10-30T12:15:00.000Z', usageStale: true,
    codexRateLimits: { primary: { usedPercent: -2, stale: true }, secondary: { usedPercent: 58.5, stale: false } },
    zaiRateLimits: { secondary: { usedPercent: 12, stale: true } } }, weather: glance.weather },
  { sessions: [{projectName:'긴 작업'.repeat(30), state:'error'}], usage: { codexRateLimits: {primary:{usedPercent: 14, resetsAt:'invalid', stale:true}} } },
];
const vectors: GlanceFrameInput[] = Object.values(GLANCE_FRAME_BOARDS).flatMap(geometry => [
  { geometry, serverHm: '12:34' }, { geometry, glance, serverHm: '12:34' },
]);
for (const code of [1, 2, 3, 45, 48, 51, 67, 71, 77, 80, 82, 85, 86, 95, 99, 4]) {
  vectors.push({ geometry: GLANCE_FRAME_BOARDS.xteink_x4, serverHm: '', glance: { weather: { ...glance.weather, code } } });
}
vectors.push({ geometry: { width: 529, height: 797, landscape: false }, serverHm: '23:59', glance });
vectors.push({ geometry: { width: 128, height: 128, landscape: false }, serverHm: '', glance });
vectors.push({ geometry: GLANCE_FRAME_BOARDS.xteink_x4, serverHm: '12:35', glance });

describe('Glance common rasterizer parity', () => {
  it('keeps generated geometry, raster rules, layout units, icons and fonts in sync', () => {
    expect(fs.readFileSync(OUTPUT, 'utf8')).toBe(emitGlancePolicy());
    expect(fs.readFileSync('shared/src/glance-frame-policy.ts', 'utf8')).toBe(emitTypeScriptPolicy());
    for (const font of GLANCE_POLICY.fonts.slice(4)) {
      expect(fs.readFileSync(`bridge/assets/fonts/${font}`).equals(fs.readFileSync(`design/fonts/${font}`)), font).toBe(true);
    }
    expect(JSON.parse(fs.readFileSync('bridge/package.json', 'utf8')).dependencies['@resvg/resvg-js']).toBe('2.6.2');
  });
  it.skipIf(process.platform !== 'darwin')('matches real Swift SVG, 1bpp bytes, signature, orientation and PNG pixels', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-parity-'));
    try {
      execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', 'shared/glance-raster/Cargo.toml'], { timeout: 180_000, stdio: 'pipe' });
      const main = path.join(dir, 'main.swift'), binary = path.join(dir, 'replay');
      fs.writeFileSync(main, `import Foundation
let payload = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
let inputs = payload["vectors"] as! [[String: Any]]
var fonts = Data()
for name in GlancePolicy.fonts {
 let data = try Data(contentsOf: URL(fileURLWithPath: "bridge/assets/fonts/" + name))
 var length = UInt32(data.count).littleEndian
 withUnsafeBytes(of: &length) { fonts.append(contentsOf: $0) }; fonts.append(data)
}
var results: [[String: Any]] = []
for input in inputs {
 let g = input["geometry"] as! [String: Any]
 let geometry = GlanceFrame.Geometry(width: g["width"] as! Int, height: g["height"] as! Int, landscape: g["landscape"] as! Bool, rotate: g["rotateToPhysical"] as? Bool ?? false)
 let glance = input["glance"] as? [String: Any] ?? [:], hm = input["serverHm"] as! String
 let frame = try GlanceFrame.render(glance: glance, serverHm: hm, geometry: geometry, fonts: fonts)
 results.append(["svg":GlanceFrame.svg(glance: glance, serverHm: hm, geometry: geometry), "sig":frame.sig, "packed":frame.packed.base64EncodedString(), "png":try frame.png().base64EncodedString(), "width":frame.width,"height":frame.height])
}
let snapshots = (payload["snapshots"] as! [[String: Any]]).map {
 GlanceSnapshot.build(sessions: $0["sessions"] as! [[String: Any]], usage: $0["usage"] as? [String: Any], weather: $0["weather"] as? [String: Any])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:["vectors":results,"snapshots":snapshots]))
`);
      execFileSync('xcrun', ['swiftc', '-swift-version', '6', '-module-cache-path', path.join(dir, 'modules'),
        '-I', 'shared/glance-raster/include', 'apple/AgentDeck/Daemon/Server/GlancePolicy.generated.swift',
        'apple/AgentDeck/Daemon/Server/GlanceFrame.swift', 'apple/AgentDeck/Daemon/Server/GlanceSnapshot.swift', main, '-L', 'shared/glance-raster/target/release',
        '-lagentdeck_glance_raster', '-framework', 'Security', '-liconv', '-o', binary], { timeout: 120_000, stdio: 'pipe' });
      const output = JSON.parse(execFileSync(binary, [], { input: JSON.stringify({ vectors, snapshots }), maxBuffer: 32e6, timeout: 60_000, encoding: 'utf8' }));
      const native = output.vectors;
      for (let i = 0; i < snapshots.length; i++) {
        const input = snapshots[i];
        expect(output.snapshots[i]).toEqual(buildGlance(input as unknown as {sessions: SessionInfo[]; usage?: UsageEvent}) ?? {});
      }
      for (let i = 0; i < vectors.length; i++) {
        const input = vectors[i], actual = native[i], label = `vector ${i} ${input.geometry.width}x${input.geometry.height}`;
        expect(actual.svg, label).toBe(renderGlanceFrameSvg(input));
        const expected = await renderGlanceFrame(input);
        expect(actual.sig, label).toBe(expected.sig);
        expect([actual.width, actual.height], label).toEqual([expected.width, expected.height]);
        expect(Buffer.from(actual.packed, 'base64').equals(expected.packed), label).toBe(true);
        const decoded = await sharp(Buffer.from(actual.png, 'base64')).raw().toBuffer({ resolveWithObject: true });
        const nodePNG = await sharp(await expected.png()).raw().toBuffer({ resolveWithObject: true });
        expect(decoded.info.width).toBe(expected.width); expect(decoded.info.height).toBe(expected.height);
        expect(decoded.data.equals(nodePNG.data), label).toBe(true);
      }
      // Clock can alter pixels while the content signature remains conditional.
      expect(native.at(-1).sig).toBe(native[3].sig);
      expect(native.at(-1).packed).not.toBe(native[3].packed);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 300_000);
});
