#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const legacyHashValue = /    public var hashValue: Int \{\n\s+return 0\n    \}/g;
const modernHashImplementation = `    public func hash(into hasher: inout Hasher) {
            hasher.combine(0)
    }`;
const legacyHashValueWithModernMethod = /    public var hashValue: Int \{\n\s+return 0\n    \}\n(?=\n    public func hash\(into hasher: inout Hasher\))/g;

for (const file of process.argv.slice(2)) {
  const original = await readFile(file, 'utf8');
  const patched = original
    .replace(/^class JSONCodingKey:/gm, 'final class JSONCodingKey:')
    .replace(legacyHashValueWithModernMethod, '')
    .replace(legacyHashValue, modernHashImplementation);

  if (patched.includes('public var hashValue: Int')) {
    throw new Error(`Unsupported quicktype hashValue declaration remains in ${file}`);
  }

  if (patched !== original) {
    await writeFile(file, patched);
  }
}
