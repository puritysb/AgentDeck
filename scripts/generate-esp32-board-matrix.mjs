#!/usr/bin/env node
// Generate the ESP32 release matrix from the board SSOT, and cross-check every
// other place the same board set is written down.
//
//   pnpm generate-esp32-board-matrix           regenerate the matrix
//   pnpm generate-esp32-board-matrix --check   exit 1 on drift or disagreement
//
// SSOT: shared/src/esp32-boards.ts
//
// The release workflow's matrix is GENERATED here because a board missing from
// it ships no firmware and nothing fails — the workflow's own comment says so,
// and it still happened to three boards in 1.0.1. A comment is not a gate.
//
// Everything else stays hand-written and is CHECKED instead, because those
// files carry human content the generator has no business owning:
//   docs/hardware-compatibility.md  the spec sheet's prose columns
//   docs/esp32.md                   per-board Korean operating notes
//   bridge/src/cli.ts               the OTA alias resolution
//   esp32/platformio.ini            the actual build settings
// Checking rather than generating keeps two SSOTs over DISJOINT columns, which
// is the only arrangement that does not just add a fifth copy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const BEGIN = '# ESP32-BOARDS:BEGIN (generated from shared/src/esp32-boards.ts by scripts/generate-esp32-board-matrix.mjs — do not edit by hand)';
const END = '# ESP32-BOARDS:END';

const read = (rel) => fs.readFileSync(path.join(projectDir, rel), 'utf8');

/* ------------------------------------------------------------------ emitters */

export function emitMatrixRows(boards) {
  // Matches the workflow's existing row shape exactly, so the first generated
  // run is a no-op diff rather than a reformat nobody can review.
  return boards
    .map(
      (b) =>
        `          - { env: ${b.env}, board: ${b.id}, name: '${b.name}', display: '${b.display}', ota: '${b.ota ? 'yes' : 'no'}' }`,
    )
    .join('\n');
}

export function spliceRegion(text, body, { begin = BEGIN, end = END, indent = '          ' }) {
  const b = `${indent}${begin}`;
  const e = `${indent}${end}`;
  const i = text.indexOf(b);
  const j = text.indexOf(e);
  if (i < 0 || j < 0) return null;
  return text.slice(0, i + b.length) + '\n' + body + '\n' + text.slice(j);
}

/* -------------------------------------------------------------- cross-checks */

/** Parse `[env:xxx]` sections out of platformio.ini into flat key/value maps. */
function parsePlatformio(ini) {
  const out = {};
  let cur = null;
  for (const raw of ini.split('\n')) {
    const sec = /^\[(.+?)\]\s*$/.exec(raw);
    if (sec) {
      cur = sec[1].startsWith('env:') ? sec[1].slice(4) : sec[1] === 'env' ? '__base' : null;
      if (cur) out[cur] = {};
      continue;
    }
    if (!cur) continue;
    const kv = /^\s*([\w.]+)\s*=\s*(.*)$/.exec(raw);
    if (kv) {
      out[cur][kv[1]] = kv[2].split(';')[0].split('#')[0].trim();
      out[cur].__last = kv[1];
    } else if (/^\s+\S/.test(raw) && out[cur].__last) {
      // continuation line of a multi-line value (upload_flags, build_flags…)
      const v = raw.split(';')[0].split('#')[0].trim();
      if (v) out[cur][out[cur].__last] += ` ${v}`;
    }
  }
  return out;
}

function checkPlatformio(boards, problems) {
  const envs = parsePlatformio(read('esp32/platformio.ini'));
  const chipOfBoard = {
    esp32dev: 'ESP32',
    'esp32-s3-devkitc-1': 'ESP32-S3',
    seeed_xiao_esp32s3: 'ESP32-S3',
    'lilygo-t-display-s3': 'ESP32-S3',
    'T5-ePaper-S3': 'ESP32-S3',
    'esp32-c6-devkitc-1': 'ESP32-C6',
    'esp32-p4': 'ESP32-P4',
  };
  for (const b of boards) {
    const e = envs[b.env];
    if (!e) {
      problems.push(`platformio.ini has no [env:${b.env}] for board ${b.id}`);
      continue;
    }
    const chip = chipOfBoard[e.board];
    if (chip && chip !== b.chipFamily) {
      problems.push(`${b.id}: chipFamily ${b.chipFamily} but platformio board=${e.board} implies ${chip}`);
    }
    const size = e['board_upload.flash_size'] || e['board_build.flash_size'] || envs.__base?.['board_build.flash_size'];
    if (size && size !== b.flashSize) {
      problems.push(`${b.id}: flashSize ${b.flashSize} but platformio says ${size}`);
    }
    // upload_speed defaults to PlatformIO's 460800 when the env does not pin one.
    const baud = Number(e.upload_speed ?? 460800);
    if (baud !== b.uploadBaud) {
      problems.push(`${b.id}: uploadBaud ${b.uploadBaud} but platformio upload_speed is ${baud}`);
    }
    const iniFlags = (e.upload_flags ?? '').split(/\s+/).filter(Boolean).join(' ');
    const ssotFlags = b.esptoolFlags.join(' ').replace(/--before (\w+)/, '--before=$1').replace(/--after (\w+)/, '--after=$1');
    const norm = (s) => s.replace(/--before[= ](\w+)/g, '--before=$1').replace(/--after[= ](\w+)/g, '--after=$1');
    if (norm(iniFlags) !== norm(ssotFlags)) {
      problems.push(`${b.id}: esptoolFlags "${ssotFlags}" but platformio upload_flags "${iniFlags}"`);
    }
  }
}

function checkSpecSheet(boards, problems) {
  const md = read('docs/hardware-compatibility.md');
  const start = md.indexOf('## ESP32 board specification sheet');
  const end = md.indexOf('\n## ', start + 1);
  const table = md.slice(start, end < 0 ? undefined : end);
  const shipping = [];
  for (const line of table.split('\n')) {
    if (!line.startsWith('|') || !/\|\s*Shipping\s*\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cell 2 is "`device_info.board` · env"; take the first backticked token
    const m = /`([^`]+)`/.exec(cells[2] ?? '');
    if (m) shipping.push(m[1]);
  }
  const ssotIds = new Set(boards.map((b) => b.id));
  for (const id of new Set(shipping)) {
    if (!ssotIds.has(id)) {
      problems.push(`hardware-compatibility.md marks "${id}" Shipping but the SSOT has no such board — it would ship no firmware`);
    }
  }
  for (const b of boards) {
    if (!shipping.includes(b.id)) {
      problems.push(`SSOT board "${b.id}" has no Shipping row in hardware-compatibility.md`);
    }
  }
}

function checkCliAliases(boards, problems) {
  // cli.ts is a CONSUMER now, not a second list. The check is therefore that it
  // has not grown its own copy again — a regenerated literal would drift
  // silently, which is the whole failure this SSOT exists to end.
  const cli = read('bridge/src/cli.ts');
  if (/const ESP32_OTA_BOARDS[^=]*=\s*\[/.test(cli)) {
    problems.push(
      'bridge/src/cli.ts declares its own ESP32_OTA_BOARDS array again — it must derive from ESP32_BOARDS in @agentdeck/shared',
    );
  }
  if (!/ESP32_BOARDS/.test(cli)) {
    problems.push('bridge/src/cli.ts no longer imports ESP32_BOARDS from @agentdeck/shared');
  }
  // Boards with no OTA slot must not reach the OTA target map at all.
  for (const b of boards.filter((x) => !x.ota)) {
    if (new RegExp(`'${b.id}'`).test(cli)) {
      problems.push(`${b.id} has ota:false but is named literally in cli.ts`);
    }
  }
}

function checkDocsAliasTable(boards, problems) {
  const md = read('docs/esp32.md');
  // Scope to the alias table by its header. The file has several pipe tables
  // (a port-mapping snapshot among them), and a filter that only looks for
  // backticked cells happily parses the wrong one and reports a device node as
  // a PlatformIO env.
  const head = md.indexOf('| Target aliases | PlatformIO env |');
  if (head < 0) {
    problems.push('docs/esp32.md has no "| Target aliases | PlatformIO env |" table');
    return;
  }
  const tail = md.indexOf('\n\n', head);
  const rows = md
    .slice(head, tail < 0 ? undefined : tail)
    .split('\n')
    .filter((l) => /^\|\s*\*?\*?`/.test(l));
  const documented = new Map();
  for (const line of rows) {
    const cells = line.split('|').map((c) => c.trim());
    const names = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const env = /`([^`]+)`/.exec(cells[2] ?? '')?.[1];
    if (names.length && env) documented.set(names[0], { names, env });
  }
  for (const b of boards.filter((x) => x.ota)) {
    const d = documented.get(b.id);
    if (!d) {
      problems.push(`docs/esp32.md alias table has no row for ${b.id}`);
      continue;
    }
    if (d.env !== b.env) problems.push(`${b.id}: docs/esp32.md says env ${d.env}, SSOT says ${b.env}`);
    const extra = d.names.slice(1).filter((n) => !b.aliases.includes(n));
    if (extra.length) {
      problems.push(
        `docs/esp32.md documents alias(es) [${extra}] for ${b.id} that the CLI does not accept — a user typing one gets "No online WiFi ESP32 target matches"`,
      );
    }
    const missing = b.aliases.filter((a) => !d.names.includes(a));
    if (missing.length) problems.push(`docs/esp32.md omits alias(es) [${missing}] for ${b.id}`);
  }
}

function checkInternal(boards, offsets, problems) {
  for (const b of boards) {
    if (b.bootloaderOffset !== offsets[b.chipFamily]) {
      problems.push(
        `${b.id}: bootloaderOffset 0x${b.bootloaderOffset.toString(16)} but ${b.chipFamily} is 0x${offsets[b.chipFamily].toString(16)}`,
      );
    }
    if (b.webFlash && !b.webFlashVerified.trim()) {
      problems.push(`${b.id}: webFlash is true with no evidence recorded`);
    }
  }
  const ids = boards.map((b) => b.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) problems.push(`duplicate board ids: ${[...new Set(dupes)]}`);
}

/* ---------------------------------------------------------------------- main */

/**
 * Run every cross-check and return the problems. Exported so the vitest gate
 * runs the same code CI runs, without spawning the CLI — the generator's own
 * `--check` and the test must not be two implementations of one rule.
 */
export function collectProblems(boards, offsets) {
  const problems = [];
  checkInternal(boards, offsets, problems);
  checkPlatformio(boards, problems);
  checkSpecSheet(boards, problems);
  checkCliAliases(boards, problems);
  checkDocsAliasTable(boards, problems);
  return problems;
}

export const WORKFLOW_REL = '.github/workflows/esp32-release.yml';

/** The workflow with its matrix region regenerated, or null if the markers are gone. */
export function renderWorkflow(boards) {
  return spliceRegion(read(WORKFLOW_REL), emitMatrixRows(boards), {});
}

export const SERIAL_SWIFT_REL = 'apple/AgentDeck/Daemon/Modules/ESP32Serial.swift';

/** Regenerate the serial vendor gate from the same board SSOT as Node. */
export function renderSwiftSerialVendors(vendors) {
  return spliceRegion(read(SERIAL_SWIFT_REL),
    `    static let esp32USBVendorIDs: Set<Int> = [${[...vendors].map(id => `0x${id.toString(16)}`).join(', ')}]`, {
      begin: '// ESP32-USB-VENDORS:BEGIN (generated from shared/src/esp32-boards.ts)',
      end: '// ESP32-USB-VENDORS:END', indent: '    ',
    });
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const mod = await import('../shared/dist/esp32-boards.js');
  const boards = mod.ESP32_BOARDS;
  const offsets = mod.ESP32_BOOTLOADER_OFFSET;

  const problems = collectProblems(boards, offsets);
  const wf = read(WORKFLOW_REL);
  const next = renderWorkflow(boards);

  if (next === null) {
    problems.push(
      `${WORKFLOW_REL} has no ESP32-BOARDS:BEGIN/END markers — add them around the matrix rows so the matrix can be generated`,
    );
  } else if (check) {
    if (next !== wf) problems.push(`${WORKFLOW_REL} matrix drifted — run: node scripts/generate-esp32-board-matrix.mjs`);
  } else if (next !== wf) {
    fs.writeFileSync(path.join(projectDir, WORKFLOW_REL), next);
    console.log(`updated ${WORKFLOW_REL}`);
  }

  const serial = renderSwiftSerialVendors(mod.ESP32_USB_VENDOR_IDS);
  if (serial === null) {
    problems.push(`${SERIAL_SWIFT_REL} has no ESP32-USB-VENDORS:BEGIN/END markers`);
  } else if (check) {
    if (serial !== read(SERIAL_SWIFT_REL)) problems.push(`${SERIAL_SWIFT_REL} vendor gate drifted — run: node scripts/generate-esp32-board-matrix.mjs`);
  } else if (serial !== read(SERIAL_SWIFT_REL)) {
    fs.writeFileSync(path.join(projectDir, SERIAL_SWIFT_REL), serial);
    console.log(`updated ${SERIAL_SWIFT_REL}`);
  }

  if (problems.length) {
    console.error(`\nESP32 board table: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`ESP32 board table: ${boards.length} boards, all cross-checks agree.`);
}
