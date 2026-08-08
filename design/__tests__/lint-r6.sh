#!/bin/bash
#
# Boundary cases for design lint rule R6 (emoji in product UI).
#
# R6 shipped broken and stayed broken because nothing exercised it: the rule
# contributed 0 findings, which is indistinguishable from "the codebase is
# clean". This asserts the pattern matches emoji and, just as importantly,
# leaves typography alone.
#
# Usage: bash design/__tests__/lint-r6.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINT_SH="$(dirname "$SCRIPT_DIR")/lint.sh"

# Keep this in lockstep with the R6 pattern in design/lint.sh.
PATTERN=$(grep -A1 '^scan "R6_emoji_in_ui"' "$LINT_SH" | tail -1 | sed "s/^ *//; s/ *\\\\$//")
eval "R6=$PATTERN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

# check <expect: hit|miss> <label> <utf8-bytes…>
check() {
  local expect="$1" label="$2"; shift 2
  printf "$*\n" > "$TMP/probe"
  local got=miss
  LC_ALL=C grep -qE "$R6" "$TMP/probe" && got=hit
  if [[ "$got" == "$expect" ]]; then
    pass=$(( pass + 1 ))
    printf '  \033[32m✓\033[0m %-34s %s\n' "$label" "$expect"
  else
    fail=$(( fail + 1 ))
    printf '  \033[31m✗\033[0m %-34s expected %s, got %s\n' "$label" "$expect" "$got"
  fi
}

printf '\n\033[1mR6 — emoji in product UI\033[0m\n'

printf '\n  must flag (emoji)\n'
check hit  'U+1F525 fire'                '\xf0\x9f\x94\xa5'
check hit  'U+2600 first of misc'        '\xe2\x98\x80'
check hit  'U+27BF last of dingbats'     '\xe2\x9e\xbf'
check hit  'U+2B00 first of stars'       '\xe2\xac\x80'
check hit  'U+2B7F last of stars'        '\xe2\xad\xbf'
check hit  'U+1F300 first pictograph'    '\xf0\x9f\x8c\x80'
check hit  'U+1FAFF last supplement'     '\xf0\x9f\xab\xbf'
check hit  'emoji mid-line'              'color: red; /* \xf0\x9f\x94\xa5 */'

printf '\n  must ignore (typography and scripts)\n'
check miss 'U+2014 em dash'              '\xe2\x80\x94'
check miss 'U+201C curly quote'          '\xe2\x80\x9c'
check miss 'U+2026 ellipsis'             '\xe2\x80\xa6'
check miss 'U+2022 bullet'               '\xe2\x80\xa2'
check miss 'U+25FF just below range'     '\xe2\x97\xbf'
check miss 'U+27C0 just above range'     '\xe2\x9f\x80'
check miss 'Hangul'                      '\xed\x95\x9c\xea\xb8\x80'
check miss 'Kanji'                       '\xe6\x97\xa5\xe6\x9c\xac'
check miss 'plain ASCII'                 'border-radius: 8px;'

printf '\n────────────────────────────────────────────────────────────\n'
if [[ $fail -eq 0 ]]; then
  printf '\033[32m✓ %d/%d passed.\033[0m\n\n' "$pass" "$(( pass + fail ))"
  exit 0
fi
printf '\033[31m✗ %d of %d failed.\033[0m\n\n' "$fail" "$(( pass + fail ))"
exit 1
