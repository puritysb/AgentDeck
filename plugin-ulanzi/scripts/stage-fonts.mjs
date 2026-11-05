import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const koreanFonts = ['IBMPlexSansKR-Regular.ttf', 'IBMPlexSansKR-Bold.ttf', 'OFL-IBMPlexSansKR.txt'];
// Kana and most kanji are absent from the KR face; without these a Japanese
// session or cmux title rendered as tofu on the deck (D200X receipt, #544).
export const japaneseFonts = ['IBMPlexSansJP-Regular.ttf', 'IBMPlexSansJP-Bold.ttf', 'OFL-IBMPlexSansJP.txt'];
export function stageFonts() {
  const target = new URL('../com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/resources/fonts/', import.meta.url);
  mkdirSync(target, { recursive: true });
  for (const name of [...koreanFonts, ...japaneseFonts]) copyFileSync(new URL('../../design/fonts/' + name, import.meta.url), new URL(name, target));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) stageFonts();
