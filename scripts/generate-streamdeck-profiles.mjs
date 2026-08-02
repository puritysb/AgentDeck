#!/usr/bin/env node
/**
 * Generate the bundled Stream Deck `.streamDeckProfile` files (SSOT).
 *
 * The Stream Deck desktop app imports a bundled profile only when it is a ZIP
 * archive in the specific wrapper layout below — a bare directory or a flat v3
 * `manifest.json` is rejected with `Importer: failed to unzip profiles`, which
 * is why AgentDeck's directory-form profiles never AutoInstalled (verified on
 * Windows, 2026-08-02). Reference: the app's own exported profiles
 * (`Volume Controller + XL (Auto).streamDeckProfile`, `WinToolsPlusXL...`).
 *
 * Layout of each `<name>.streamDeckProfile` zip:
 *   package.json                                   { DeviceModel, FormatVersion:1, RequiredPlugins:[uuid], ... }
 *   Profiles/<OUTER>.sdProfile/manifest.json       { Device{Model,UUID}, Name, Pages{Current,Default,Pages[]}, Version:"3.0" }
 *   Profiles/<OUTER>.sdProfile/Profiles/<BLANK>/manifest.json      blank Default page (Actions:null controllers)
 *   Profiles/<OUTER>.sdProfile/Profiles/<POPULATED>/manifest.json  the populated page (session-slot keypad + dial roles)
 *
 * Output is deterministic (uuidv5-derived ids, fixed zip timestamps, stored
 * entries) so the drift gate can byte-compare. Run `--check` to verify the
 * committed zips match this generator; run with no args to (re)write them.
 *
 * SSOT for: profile name, display name, DeviceType, model SKU, grid, dials.
 * The plugin manifest `Profiles[]` DeviceType numbers are cross-checked by
 * `scripts/verify-version-sync.mjs`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PLUGIN_DIR = resolve(root, 'plugin/bound.serendipity.agentdeck.sdPlugin');
const PLUGIN_UUID = 'bound.serendipity.agentdeck';

// Plugin (embedded action) version mirrors plugin/package.json, e.g. 1.0.3 -> 1.0.3.0
const pluginVersion = `${JSON.parse(readFileSync(resolve(root, 'plugin/package.json'), 'utf8')).version}.0`;

// --- SSOT: every bundled profile -------------------------------------------
// Keypad is entirely `session-slot`; decks with dials get the four fixed roles
// E1 Volume / E2 Claude Usage / E3 Codex Usage / E4 Launcher (E5/E6 unassigned).
const PROFILES = [
  { name: 'agentdeck-sd',       display: 'AgentDeck SD',     deviceType: 0,  model: '20GAA9902', columns: 5, rows: 3, dials: false },
  { name: 'agentdeck-sdmini',   display: 'AgentDeck SD Mini', deviceType: 1, model: '20GAI9901', columns: 3, rows: 2, dials: false },
  { name: 'agentdeck-sdplus',   display: 'AgentDeck SD+',    deviceType: 7,  model: '20GBD9901', columns: 4, rows: 2, dials: true },
  { name: 'agentdeck-sdxl',     display: 'AgentDeck SD XL',  deviceType: 2,  model: '20GAT9901', columns: 8, rows: 4, dials: false },
  { name: 'agentdeck-sdplusxl', display: 'AgentDeck SD+ XL', deviceType: 13, model: '20GBX9901', columns: 9, rows: 4, dials: true },
];

const ENCODER_ROLES = [
  { name: 'Volume',       uuid: `${PLUGIN_UUID}.utility-dial` },
  { name: 'Claude Usage', uuid: `${PLUGIN_UUID}.option-dial` },
  { name: 'Codex Usage',  uuid: `${PLUGIN_UUID}.iterm-dial` },
  { name: 'Launcher',     uuid: `${PLUGIN_UUID}.launcher` },
];

// --- deterministic uuid v5 --------------------------------------------------
const NS = Buffer.from('a1c4d2e0b8f34c1a9d7e6f5a4b3c2d1e', 'hex'); // fixed AgentDeck namespace
function uuidv5(name) {
  const h = createHash('sha1').update(NS).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const id = (profile, purpose) => uuidv5(`${profile}:${purpose}`);

// --- profile JSON -----------------------------------------------------------
const KEY_STATE = {
  FontFamily: '', FontSize: 12, FontStyle: '', FontUnderline: false,
  OutlineThickness: 2, ShowTitle: false, TitleAlignment: 'middle', TitleColor: '#ffffff',
};
const plugin = () => ({ Name: 'AgentDeck', UUID: PLUGIN_UUID, Version: pluginVersion });

function keypadController(p) {
  const Actions = {};
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.columns; c++) {
      Actions[`${c},${r}`] = {
        ActionID: id(p.name, `kp:${c},${r}`), LinkedTitle: true, Name: 'Session Slot',
        Plugin: plugin(), Resources: null, Settings: {}, State: 0,
        States: [{ ...KEY_STATE }], UUID: `${PLUGIN_UUID}.session-slot`,
      };
    }
  }
  return { Actions, Type: 'Keypad' };
}
function encoderController(p) {
  const Actions = {};
  ENCODER_ROLES.forEach((role, i) => {
    Actions[`${i},0`] = {
      ActionID: id(p.name, `enc:${i}`), LinkedTitle: true, Name: role.name,
      Plugin: plugin(), Resources: null, Settings: {}, State: 0, States: [{}], UUID: role.uuid,
    };
  });
  return { Actions, Type: 'Encoder' };
}
function populatedPage(p) {
  const controllers = [keypadController(p)];
  if (p.dials) controllers.push(encoderController(p));
  return { Controllers: controllers, Icon: '', Name: '' };
}
function blankPage(p) {
  const controllers = [{ Actions: null, Type: 'Keypad' }];
  if (p.dials) controllers.push({ Actions: null, Type: 'Encoder' });
  return { Controllers: controllers, Icon: '', Name: '' };
}

function buildEntries(p) {
  const outer = id(p.name, 'outer').toUpperCase();
  const blank = id(p.name, 'page-blank').toUpperCase();
  const pop = id(p.name, 'page-populated').toUpperCase();
  const pkg = {
    AppVersion: '7.4.0.22712', DeviceModel: p.model, DeviceSettings: null,
    FormatVersion: 1, OSType: 'Windows', OSVersion: '10.0.26200',
    RequiredPlugins: [PLUGIN_UUID],
  };
  const outerManifest = {
    Device: { Model: p.model, UUID: id(p.name, 'device') },
    Name: p.display,
    Pages: { Current: '00000000-0000-0000-0000-000000000000', Default: blank.toLowerCase(), Pages: [pop.toLowerCase()] },
    Version: '3.0',
  };
  const base = `Profiles/${outer}.sdProfile`;
  // Directory entries mirror the app's own export (harmless but faithful).
  const dirs = [
    'Profiles/', `${base}/`, `${base}/Images/`, `${base}/Profiles/`,
    `${base}/Profiles/${blank}/`, `${base}/Profiles/${blank}/Images/`,
    `${base}/Profiles/${pop}/`, `${base}/Profiles/${pop}/Images/`,
  ];
  const files = [
    ['package.json', JSON.stringify(pkg)],
    [`${base}/manifest.json`, JSON.stringify(outerManifest)],
    [`${base}/Profiles/${blank}/manifest.json`, JSON.stringify(blankPage(p))],
    [`${base}/Profiles/${pop}/manifest.json`, JSON.stringify(populatedPage(p))],
  ];
  return { dirs, files };
}

// --- deterministic ZIP writer (stored, fixed timestamps) --------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(dirs, files) {
  // Entry order: dirs first (as the app writes them), then files.
  const entries = [
    ...dirs.map((name) => ({ name, data: Buffer.alloc(0) })),
    ...files.map(([name, content]) => ({ name, data: Buffer.from(content, 'utf8') })),
  ];
  const DOS_TIME = 0, DOS_DATE = 0x0021; // 1980-01-01, fixed for determinism
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);       // version needed
    lh.writeUInt16LE(0, 6);        // flags
    lh.writeUInt16LE(0, 8);        // method: stored
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);       // version made by
    ch.writeUInt16LE(20, 6);       // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);       // extra len
    ch.writeUInt16LE(0, 32);       // comment len
    ch.writeUInt16LE(0, 34);       // disk
    ch.writeUInt16LE(0, 36);       // internal attrs
    ch.writeUInt32LE(e.name.endsWith('/') ? 0x10 : 0, 38); // external attrs: dir flag
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + e.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function profileBytes(p) {
  const { dirs, files } = buildEntries(p);
  return zip(dirs, files);
}

export { PROFILES, profileBytes, PLUGIN_DIR };

// --- main (only when invoked directly, not when imported by the drift gate) --
function main() {
  const check = process.argv.includes('--check');
  let drift = 0;
  for (const p of PROFILES) {
    const out = resolve(PLUGIN_DIR, `${p.name}.streamDeckProfile`);
    const bytes = profileBytes(p);
    if (check) {
      let existing = null;
      try { existing = readFileSync(out); } catch { /* missing */ }
      if (!existing || !existing.equals(bytes)) {
        console.error(`DRIFT: ${p.name}.streamDeckProfile is out of date — run \`pnpm generate-streamdeck-profiles\``);
        drift++;
      }
    } else {
      writeFileSync(out, bytes);
      console.log(`wrote ${p.name}.streamDeckProfile (${bytes.length} bytes, DeviceType ${p.deviceType}, ${p.columns}x${p.rows}${p.dials ? ' +dials' : ''})`);
    }
  }
  if (check) {
    if (drift) { console.error(`${drift} profile(s) drifted.`); process.exit(1); }
    console.log('Stream Deck profiles are in sync.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
