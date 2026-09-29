/**
 * The ESP32 board SSOT and the gate that keeps the four hand-written copies of
 * it from disagreeing again.
 *
 * The failure this exists to stop is silent by construction: a board missing
 * from the release matrix ships no firmware and NOTHING fails. The workflow's
 * own comment has said so since it happened to `t_embed`, `t_display_pro` and
 * `esp32_c6_147` in 1.0.1 — a comment is not a gate.
 */

import { describe, it, expect } from 'vitest';
import {
  ESP32_BOARDS,
  ESP32_BOOTLOADER_OFFSET,
  ESP32_BOARD_BY_TARGET,
  LEGACY_BOARD_IDS,
  canonicalBoardId,
  esp32ChipFamilyOf,
  esp32FlashIdIsUsable,
  esp32FlashSizeIsSafe,
} from '../esp32-boards.js';
// The generator's checks are imported rather than re-implemented: the CLI's
// --check and this test must not become two implementations of one rule.
import {
  collectProblems,
  renderWorkflow,
  WORKFLOW_REL,
} from '../../../scripts/generate-esp32-board-matrix.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('ESP32 board SSOT', () => {
  it('agrees with platformio.ini, the spec sheet, cli.ts and docs/esp32.md', () => {
    const problems = collectProblems(ESP32_BOARDS, ESP32_BOOTLOADER_OFFSET);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('keeps the release matrix generated, not hand-maintained', () => {
    const onDisk = readFileSync(join(repoRoot, WORKFLOW_REL), 'utf8');
    expect(renderWorkflow(ESP32_BOARDS)).toBe(onDisk);
  });

  it('keeps the Swift Surface product allow-list on the board SSOT', () => {
    const swift = readFileSync(
      join(repoRoot, 'apple/AgentDeck/Daemon/Server/DaemonServer.swift'), 'utf8',
    );
    const block = swift.match(
      /BEGIN GENERATED-SSOT-MIRROR: shared\/src\/esp32-boards\.ts([\s\S]*?)END GENERATED-SSOT-MIRROR/,
    )?.[1] ?? '';
    const ids = [...block.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(ESP32_BOARDS.map((board) => board.id));
  });

  it('never claims a browser-flashable board without evidence', () => {
    // A flag nobody measured is indistinguishable from one a board produced.
    // The evidence string is what tells them apart, so it is required.
    for (const b of ESP32_BOARDS) {
      if (!b.webFlash) continue;
      expect(b.webFlashVerified.trim(), `${b.id} claims webFlash with no evidence`).not.toBe('');
      expect(['verified', 'verified-partial']).toContain(b.webFlashStatus);
    }
  });

  it('puts every board on esptool\'s bootloader-offset table', () => {
    // Three values, not two. ESP32-P4 at 0x2000 is the one a "0x0 or 0x1000"
    // assumption misses, and it survives review until a P4 is bricked.
    expect(ESP32_BOOTLOADER_OFFSET['ESP32-P4']).toBe(0x2000);
    expect(ESP32_BOOTLOADER_OFFSET.ESP32).toBe(0x1000);
    expect(ESP32_BOOTLOADER_OFFSET['ESP32-S3']).toBe(0x0);
    for (const b of ESP32_BOARDS) {
      expect(b.bootloaderOffset, b.id).toBe(ESP32_BOOTLOADER_OFFSET[b.chipFamily]);
    }
  });

  it('resolves every documented alias to exactly one board', () => {
    for (const b of ESP32_BOARDS) {
      for (const key of [b.id, b.env, ...b.aliases]) {
        expect(ESP32_BOARD_BY_TARGET[key]?.id, key).toBe(b.id);
      }
    }
    // Regression: documented in docs/esp32.md but missing from the CLI until
    // the cross-check found it, so a user following the docs got
    // "No online WiFi ESP32 target matches".
    expect(ESP32_BOARD_BY_TARGET['amoled_18']?.id).toBe('round_amoled');
  });

  it('keeps ids unique', () => {
    const ids = ESP32_BOARDS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('esp32ChipFamilyOf', () => {
  // VERBATIM strings esptool-js returned from the real fleet on 2026-08-22 —
  // not hand-written examples. A description invented from what the parser
  // expects cannot fail, which is how a parser bug survives a green suite.
  it.each([
    ['ESP32-S3 (QFN56) (revision v0.2)', 'ESP32-S3'],
    ['ESP32-D0WD (revision 1)', 'ESP32'],
    ['ESP32-D0WDQ6 (revision 1)', 'ESP32'],
  ])('classifies %s', (desc, family) => {
    expect(esp32ChipFamilyOf(desc)).toBe(family);
  });

  it('does not let the classic case swallow the variants', () => {
    // Every variant description also contains "ESP32", so the classic case has
    // to be the fallback. A first attempt used /ESP32(?!-)/ and called a real
    // ESP32-D0WD a mismatch for having a hyphen.
    expect(esp32ChipFamilyOf('ESP32-S3 (QFN56)')).not.toBe('ESP32');
    expect(esp32ChipFamilyOf('ESP32-P4')).toBe('ESP32-P4');
    expect(esp32ChipFamilyOf('ESP32-C3 (QFN32)')).toBe('other');
  });
});

describe('flash guards', () => {
  it('treats an all-ones or all-zeros flash id as no answer', () => {
    // Measured: a TTGO T-Display read through the ROM loader returns 0xffffff,
    // and esptool-js's detectFlashSize() turns that into the string "4MB".
    // Trusting it would have failed a good 16MB board.
    expect(esp32FlashIdIsUsable('ffffff')).toBe(false);
    expect(esp32FlashIdIsUsable('0')).toBe(false);
    expect(esp32FlashIdIsUsable('1840ef')).toBe(true); // same board, with the stub
    expect(esp32FlashIdIsUsable(undefined)).toBe(false);
  });

  it('is directional: under-declaring flash is safe, over-declaring is not', () => {
    // TRMNL 7.5" is the real case for the safe direction — a physically 16MB part
    // whose BSP requires an 8MB flash-size field.
    expect(esp32FlashSizeIsSafe('8MB', '16MB')).toBe(true);
    expect(esp32FlashSizeIsSafe('16MB', '16MB')).toBe(true);
    expect(esp32FlashSizeIsSafe('16MB', '4MB')).toBe(false);
  });

  it('resolves a legacy wire id a deployed board still reports', () => {
    // A flashed board keeps saying what it was BUILT as until it takes an OTA,
    // so a rename that moved only the canonical id would drop every deployed
    // unit off every surface that matches on the string — including the OTA
    // that would have renamed it. `inkdeck` is the 1.2.1 name of `trmnl_75`.
    expect(canonicalBoardId('inkdeck')).toBe('trmnl_75');
    expect(canonicalBoardId('trmnl_75')).toBe('trmnl_75');
    // An id nobody renamed passes through — this is a translation table, not a
    // filter, and an unknown board must stay itself rather than become null.
    expect(canonicalBoardId('xteink_x3')).toBe('xteink_x3');
    for (const [legacy, canonical] of Object.entries(LEGACY_BOARD_IDS)) {
      expect(ESP32_BOARD_BY_TARGET[canonical]?.id, canonical).toBe(canonical);
      // The CLI must accept the old spelling too, or `esp32-ota inkdeck` — the
      // command a user with that board already has in their shell history —
      // resolves to nothing.
      expect(ESP32_BOARD_BY_TARGET[legacy]?.id, legacy).toBe(canonical);
    }
  });

  it('returns unknown rather than a verdict when the size could not be read', () => {
    // "unknown" is its own answer. Folding it into either verdict either blocks
    // a good board or waves a fatal mismatch through.
    expect(esp32FlashSizeIsSafe('16MB', undefined)).toBeUndefined();
    expect(esp32FlashSizeIsSafe('16MB', 'keep')).toBeUndefined();
  });
});
