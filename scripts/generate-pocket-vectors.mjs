#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as engine from '../bridge/dist/pocket-autonomy.js';
import * as modules from '../bridge/dist/card-modules.js';
import { runPocketVector } from './pocket-vector-reference.mjs';
const file = 'shared/pocket-autonomy-vectors.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const testcase of data.cases) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-vectors-'));
  try { testcase.expected = runPocketVector(testcase, root, { ...engine, ...modules }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
