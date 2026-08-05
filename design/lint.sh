#!/usr/bin/env bash
# AgentDeck — Design system lint
# Scans the project for violations of DESIGN.md rules.
# Usage:  bash design/lint.sh           # human-readable report
#         bash design/lint.sh --json    # machine-readable
#
# Exit code = total violation count (0 = clean).

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Files we lint (HTML/CSS/JS/JSX). Skip vendored/build/auto-generated stuff.
SCOPE_FILES=$(find . \
  \( -path './node_modules' -o -path '*/node_modules' \
     -o -path './.git' -o -path './.github' \
     -o -path './dist' -o -path '*/dist' \
     -o -path './coverage' \
     -o -path './generated' \
     -o -path './.zig-cache' -o -path './.zig-global-cache' \
     -o -path './apple/build' -o -path './android/app/build' \
     -o -path './apple/AgentDeck/Resources/agentdeck-runtime' \
     -o -path './docs/design-mockups' \
     -o -path './docs/design/tenin' \
     -o -path './docs/design/AgentDeck Tide Bento (D1).html' \
     -o -path './plugin/bound.serendipity.agentdeck.sdPlugin/bin' \
     -o -path './plugin/bound.serendipity.agentdeck.sdPlugin/ui/sdpi-components.js' \
     -o -path './plugin-ulanzi/*/libs/css/uspi.css' \
     -o -path './esp32/.pio' \
     -o -path './esp32/robot/results' \
     -o -path './tools/creature-simulator' \
  \) -prune -o \
  -type f \( -name '*.html' -o -name '*.css' -o -name '*.jsx' -o -name '*.js' \) -print \
  | grep -v -E '(^\./design/tokens\.css$|^\./design/lint\.sh$)')

# Token-defining files are allowed to declare hex; everything else must use vars.
# `creatures.jsx` carries inlined upstream brand SVGs (single #CFCECD belongs to
# the OpenCode mark) — DESIGN.md §6.1 forbids redrawing brand SVGs, so the
# embedded hex is canonical and stays in the allowlist.
# `apme-dashboard.html` ships as a single embedded HTML resource — its :root
# block manually mirrors design/tokens.css since WKWebView can't <link> the
# canonical file. Treat it as a token-defining file; sync drift would manifest
# as visible regression and is caught by manual review during dashboard work.
# `docs/hardware/index.html` is the published Devices catalog (GitHub Pages
# /hardware/). It must stay a single self-contained file (no external <link>) so
# the same file renders on Pages and from file://; its :root mirrors the warm
# token subset. Same token-defining treatment as apme-dashboard.html.
# `scripts/pages-index.html`, `docs/site/index.html`, `docs/gallery/index.html`
# are the other published GitHub Pages surfaces (overview / docs hub / legacy
# gallery redirect). Each is self-contained with the same :root warm-token mirror, so
# they get the same token-defining treatment as the hardware sheet.
TOKEN_FILES='design/tokens\.css|design/tokens\.js|design/icons\.jsx|design/components\.css|design/patterns\.css|docs/design/creatures\.jsx|apple/AgentDeck/Resources/apme-dashboard\.html|docs/hardware/index\.html|scripts/pages-index\.html|docs/site/index\.html|docs/gallery/index\.html|plugin/bound\.serendipity\.agentdeck\.sdPlugin/ui/design-tokens\.css'

JSON=0
[[ "${1:-}" == "--json" ]] && JSON=1

declare -i TOTAL=0
declare -A COUNTS
RECORDS=()

# emit RULE FILE LINE TEXT
emit() {
  local rule="$1" file="$2" line="$3" text="$4"
  COUNTS[$rule]=$(( ${COUNTS[$rule]:-0} + 1 ))
  TOTAL=$(( TOTAL + 1 ))
  RECORDS+=("$rule|$file|$line|$text")
}

scan() {
  local rule="$1" pattern="$2" exclude="${3:-__never__}"
  while IFS=: read -r file line text; do
    [[ -z "$file" ]] && continue
    [[ "$file" =~ $exclude ]] && continue
    text="${text#"${text%%[![:space:]]*}"}"   # ltrim
    emit "$rule" "$file" "$line" "${text:0:160}"
  done < <(grep -rnHE --include='*.html' --include='*.css' --include='*.jsx' --include='*.js' \
            --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.github \
            --exclude-dir=dist --exclude-dir=coverage --exclude-dir=generated \
            --exclude-dir=.zig-cache --exclude-dir=.zig-global-cache \
            --exclude-dir=build --exclude-dir=design-mockups --exclude-dir=agentdeck-runtime \
            --exclude-dir=bin --exclude-dir=.pio --exclude-dir=results \
            --exclude-dir=creature-simulator --exclude-dir=tenin \
            --exclude=sdpi-components.js --exclude=uspi.css --exclude='AgentDeck Tide Bento (D1).html' \
            -- "$pattern" . 2>/dev/null)
}

# ── Rule R1: pure white / black ────────────────────────────────────────
scan "R1_pure_white_black" \
  '#(fff|FFF|ffffff|FFFFFF|000|000000)([^0-9a-fA-F]|$)' \
  "$TOKEN_FILES"

# ── Rule R2: hardcoded hex outside token files ─────────────────────────
scan "R2_hardcoded_hex" \
  '#[0-9a-fA-F]{3,8}\b' \
  "$TOKEN_FILES|design/icons\.jsx"

# ── Rule R3: forbidden typefaces ───────────────────────────────────────
scan "R3_forbidden_font" \
  "(font-family:|fontFamily:).*('|\")?(Inter|Roboto|Arial|Helvetica Neue|Fraunces)('|\")?" \
  "$TOKEN_FILES"

# ── Rule R4: animating non-amber signal colors ─────────────────────────
scan "R4_animated_kelp_or_coral" \
  '(kelp|coral)[^;]*animation' \
  "$TOKEN_FILES"

# ── Rule R5: non-warm shadows (pure black rgba) ────────────────────────
scan "R5_non_warm_shadow" \
  'box-shadow:[^;]*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,' \
  "$TOKEN_FILES"

# ── Rule R6: emoji in product UI (covers most ranges used in slop) ─────
# Hits BMP emoji & symbols ranges; opt-out via data-allow-emoji=""
scan "R6_emoji_in_ui" \
  $'[\xE2\x98-\xE2\x9F\xE2\xAD\xF0\x9F][\x80-\xBF][\x80-\xBF]' \
  "$TOKEN_FILES"

# ── Rule R7: non-token border-radius ───────────────────────────────────
# Allowed numeric values: 0, 4, 8, 10, 12, 14, 16, 18, 999, 50%
scan "R7_arbitrary_radius" \
  'border-radius:\s*([0-9]+)(px)?' \
  "$TOKEN_FILES"
# Filter R7 to only entries where the number is NOT in our set
NEW_RECORDS=()
for r in "${RECORDS[@]}"; do
  IFS='|' read -r rule file line text <<<"$r"
  if [[ "$rule" == "R7_arbitrary_radius" ]]; then
    n=$(echo "$text" | grep -oE 'border-radius:\s*[0-9]+' | grep -oE '[0-9]+' | head -1)
    case "$n" in
      0|4|8|10|12|14|16|18|999) COUNTS[R7_arbitrary_radius]=$((COUNTS[R7_arbitrary_radius]-1)); TOTAL=$((TOTAL-1));;
      *) NEW_RECORDS+=("$r");;
    esac
  else
    NEW_RECORDS+=("$r")
  fi
done
RECORDS=("${NEW_RECORDS[@]}")

# ── Rule R8: marketing surface using product UI palette ────────────────
# Marketing files are option-*-site.jsx, *.html landing pages. They should NOT use --ui-* tokens.
while IFS=: read -r file line text; do
  [[ -z "$file" ]] && continue
  if [[ "$file" =~ option-.*-site|landing|index\.html ]]; then
    text="${text#"${text%%[![:space:]]*}"}"
    emit "R8_marketing_uses_ui_token" "$file" "$line" "${text:0:160}"
  fi
done < <(grep -rnHE -- '--ui-[a-z-]+' . 2>/dev/null \
          | grep -v -E '(design/tokens\.css|design/components\.css|Design System\.html|Design Audit\.html)')

# ── Output ─────────────────────────────────────────────────────────────
if [[ $JSON -eq 1 ]]; then
  printf '{ "total": %d, "rules": {' "$TOTAL"
  first=1
  for k in "${!COUNTS[@]}"; do
    [[ $first -eq 0 ]] && printf ','
    printf ' "%s": %d' "$k" "${COUNTS[$k]}"
    first=0
  done
  printf ' }, "records": ['
  first=1
  for r in "${RECORDS[@]}"; do
    IFS='|' read -r rule file line text <<<"$r"
    text=${text//\\/\\\\}; text=${text//\"/\\\"}
    [[ $first -eq 0 ]] && printf ','
    printf '\n  { "rule": "%s", "file": "%s", "line": %s, "text": "%s" }' \
      "$rule" "$file" "$line" "$text"
    first=0
  done
  printf '\n] }\n'
  exit $TOTAL
fi

# Human report
RULE_TITLES=(
  "R1_pure_white_black:Pure #fff or #000 — use --tide-50 / --ink-900"
  "R2_hardcoded_hex:Hardcoded hex outside token files"
  "R3_forbidden_font:Forbidden typeface (Inter/Roboto/Arial/Fraunces)"
  "R4_animated_kelp_or_coral:Animating kelp/coral — only amber pulses"
  "R5_non_warm_shadow:Non-warm shadow (rgba(0,0,0,…)) — use --sh-* tokens"
  "R6_emoji_in_ui:Emoji in UI code — use icon set or creature marks"
  "R7_arbitrary_radius:border-radius outside the {0,4,8,10,12,14,16,18,999} scale"
  "R8_marketing_uses_ui_token:Marketing surface using product UI tokens (--ui-*)"
)

printf '\n\033[1mAgentDeck — Design Lint\033[0m\n'
printf '%s\n' '────────────────────────────────────────────────────────────'
if [[ $TOTAL -eq 0 ]]; then
  printf '\033[32m✓ Clean.\033[0m All %d files pass.\n\n' "$(echo "$SCOPE_FILES" | wc -l | tr -d ' ')"
  exit 0
fi

for entry in "${RULE_TITLES[@]}"; do
  IFS=':' read -r rule title <<<"$entry"
  count=${COUNTS[$rule]:-0}
  [[ $count -eq 0 ]] && continue
  printf '\n\033[33m▸ %s\033[0m  \033[2m(%d)\033[0m\n  %s\n' "$rule" "$count" "$title"
  for r in "${RECORDS[@]}"; do
    IFS='|' read -r rrule rfile rline rtext <<<"$r"
    [[ "$rrule" != "$rule" ]] && continue
    printf '    \033[2m%s:%s\033[0m  %s\n' "$rfile" "$rline" "$rtext"
  done
done

printf '\n────────────────────────────────────────────────────────────\n'
printf '\033[31m%d violation(s) across %d rule(s).\033[0m\n\n' \
  "$TOTAL" "${#COUNTS[@]}"
exit $TOTAL
