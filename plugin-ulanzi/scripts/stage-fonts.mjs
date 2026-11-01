import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const koreanFonts = ['IBMPlexSansKR-Regular.ttf', 'IBMPlexSansKR-Bold.ttf', 'OFL-IBMPlexSansKR.txt'];
export function stageFonts() {
  const target = new URL('../com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/resources/fonts/', import.meta.url);
  mkdirSync(target, { recursive: true });
  for (const name of koreanFonts) copyFileSync(new URL('../../design/fonts/' + name, import.meta.url), new URL(name, target));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) stageFonts();
