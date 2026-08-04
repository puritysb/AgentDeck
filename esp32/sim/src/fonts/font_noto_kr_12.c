// Unity-include wrapper for the Noto Sans KR 12px LVGL font (한글 syllable
// range) so sim renders exercise the same Korean fallback path as the device —
// without it, CJK text drew as .notdef boxes and font-related regressions
// (broken glyphs vs tofu) were indistinguishable in sim PNGs.
#include "../../../src/ui/fonts/font_noto_kr_12.c"
