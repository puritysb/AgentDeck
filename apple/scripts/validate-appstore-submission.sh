#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCREENSHOTS="$ROOT/apple/appstore-submission/screenshots"
PREVIEWS="$ROOT/apple/appstore-submission/previews"
METADATA="$ROOT/docs/appstore-metadata-draft.md"
MAC_211_MEDIA="$ROOT/apple/appstore-submission/2.1.1"

failures=0

fail() {
  echo "ERROR: $*" >&2
  failures=$((failures + 1))
}

dimension() {
  local file="$1"
  local width height
  width="$(sips -g pixelWidth "$file" 2>/dev/null | awk '/pixelWidth/{print $2}')"
  height="$(sips -g pixelHeight "$file" 2>/dev/null | awk '/pixelHeight/{print $2}')"
  echo "${width}x${height}"
}

validate_platform() {
  local platform="$1"
  local accepted="$2"
  local directory="$SCREENSHOTS/$platform"
  local label="${SCREENSHOTS##*/}/$platform"
  local files=()

  while IFS= read -r file; do files+=("$file"); done < <(find "$directory" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) | sort)

  if (( ${#files[@]} < 1 || ${#files[@]} > 10 )); then
    fail "$label requires 1–10 screenshots; found ${#files[@]}"
    return
  fi

  local seen_hashes=""
  for file in "${files[@]}"; do
    local size hash
    size="$(dimension "$file")"
    if [[ " $accepted " != *" $size "* ]]; then
      fail "$label/$(basename "$file") has unsupported dimensions $size"
    else
      echo "OK: $label/$(basename "$file") ($size)"
    fi
    if [[ "$(sips -g hasAlpha "$file" 2>/dev/null | awk '/hasAlpha/{print $2}')" != "no" ]]; then
      fail "$label/$(basename "$file") must be an opaque screenshot without alpha"
    fi
    hash="$(shasum -a 256 "$file" | awk '{print $1}')"
    if [[ " $seen_hashes " == *" $hash "* ]]; then
      fail "$label contains a duplicate screenshot: $(basename "$file")"
    fi
    seen_hashes+=" $hash"
  done
}

# Screenshots are localized (App Store Connect keeps one set per locale);
# App Previews below stay locale-common.
for locale in en ko ja; do
  SCREENSHOTS="$ROOT/apple/appstore-submission/screenshots/$locale"
  validate_platform "macOS" "1280x800 1440x900 2560x1600 2880x1800"
  validate_platform "iPhone" "1242x2688 2688x1242 1284x2778 2778x1284"
  validate_platform "iPad" "2064x2752 2752x2064 2048x2732 2732x2048"
  SCREENSHOTS="$MAC_211_MEDIA/screenshots/$locale"
  validate_platform "macOS" "2560x1600"
done

probe_stream() {
  local file="$1"
  local field="$2"
  ffprobe -v error -select_streams v:0 -show_entries "stream=$field" \
    -of default=noprint_wrappers=1:nokey=1 "$file" | head -n 1
}

probe_format() {
  local file="$1"
  local field="$2"
  ffprobe -v error -show_entries "format=$field" \
    -of default=noprint_wrappers=1:nokey=1 "$file" | head -n 1
}

validate_previews() {
  local platform="$1"
  local accepted="$2"
  local directory="$PREVIEWS/$platform"
  local files=()

  [[ -d "$directory" ]] || return 0
  if ! command -v ffprobe >/dev/null 2>&1; then
    fail "ffprobe is required to validate App Preview videos"
    return
  fi

  while IFS= read -r file; do files+=("$file"); done < <(find "$directory" -maxdepth 1 -type f \( -iname '*.mov' -o -iname '*.m4v' -o -iname '*.mp4' \) | sort)
  (( ${#files[@]} <= 3 )) || fail "$platform allows at most 3 App Previews; found ${#files[@]}"

  for file in "${files[@]}"; do
    local codec profile level width height pixels fps fps_num fps_den duration bytes bitrate field_order
    local audio_codec audio_rate audio_channels
    codec="$(probe_stream "$file" codec_name)"
    profile="$(probe_stream "$file" profile)"
    level="$(probe_stream "$file" level)"
    width="$(probe_stream "$file" width)"
    height="$(probe_stream "$file" height)"
    fps="$(probe_stream "$file" r_frame_rate)"
    field_order="$(probe_stream "$file" field_order)"
    duration="$(probe_format "$file" duration)"
    bitrate="$(probe_format "$file" bit_rate)"
    bytes="$(stat -f %z "$file")"
    pixels="${width}x${height}"
    audio_codec="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$file" | head -n 1)"
    audio_rate="$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of default=noprint_wrappers=1:nokey=1 "$file" | head -n 1)"

    audio_channels="$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of default=noprint_wrappers=1:nokey=1 "$file" | head -n 1)"

    # ASC rejects App Previews with no audio stream ("unsupported or
    # corrupted audio") — a silent AAC-LC track is required even for
    # genuinely silent captures. See scripts/record-appstore-previews.sh.
    [[ -n "$audio_codec" ]] || fail "$platform/$(basename "$file") has no audio stream — ASC requires a silent AAC track"
    [[ -z "$audio_codec" || "$audio_codec" == "aac" ]] || fail "$platform/$(basename "$file") audio must be AAC; found $audio_codec"
    [[ "$audio_rate" == "44100" || "$audio_rate" == "48000" ]] || fail "$platform/$(basename "$file") audio must use 44.1 or 48 kHz; found $audio_rate"
    [[ "$audio_channels" == "2" ]] || fail "$platform/$(basename "$file") audio must be stereo; found $audio_channels channel(s)"

    [[ "$codec" == "h264" ]] || fail "$platform/$(basename "$file") must use H.264; found $codec"
    [[ "$profile" == "High" || "$profile" == "Main" || "$profile" == "Baseline" ]] || fail "$platform/$(basename "$file") has unsupported H.264 profile $profile"
    [[ "$level" =~ ^[0-9]+$ ]] && (( level <= 40 )) || fail "$platform/$(basename "$file") exceeds H.264 level 4.0"
    [[ "$field_order" == "progressive" ]] || fail "$platform/$(basename "$file") must be progressive"
    [[ " $accepted " == *" $pixels "* ]] || fail "$platform/$(basename "$file") has unsupported App Preview dimensions $pixels"
    awk -v d="$duration" 'BEGIN { exit !(d >= 15 && d <= 30) }' || fail "$platform/$(basename "$file") must be 15–30 seconds; found ${duration}s"
    (( bytes <= 500000000 )) || fail "$platform/$(basename "$file") exceeds 500 MB"

    fps_num="${fps%/*}"
    fps_den="${fps#*/}"
    awk -v n="$fps_num" -v d="$fps_den" 'BEGIN { exit !(d > 0 && n / d <= 30) }' || fail "$platform/$(basename "$file") exceeds 30 fps ($fps)"
    awk -v b="$bitrate" 'BEGIN { exit !(b >= 10000000 && b <= 12000000) }' || fail "$platform/$(basename "$file") should target 10–12 Mbps; found $bitrate bps"

    echo "OK: $platform/$(basename "$file") ($pixels, ${duration}s, $codec $profile level $level, $fps, $bitrate bps, audio $audio_codec ${audio_rate}Hz)"
  done
}

validate_previews "macOS" "1920x1080"
validate_previews "iPhone" "886x1920 1920x886"
validate_previews "iPad" "1200x1600 1600x1200"
PREVIEWS="$MAC_211_MEDIA/previews"
validate_previews "macOS" "1920x1080"
if ! node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const module = await import(pathToFileURL(process.argv[1]));
  module.selectedMedia("2.1.1", "MAC_OS");
' "$ROOT/scripts/asc-release-media.mjs"; then
  fail "The macOS 2.1.1 media selection does not match the repository"
fi

metadata_errors=0
while IFS= read -r line; do
  case "$line" in
    ERROR:*) echo "$line" >&2; failures=$((failures + 1)); metadata_errors=$((metadata_errors + 1)) ;;
    *) echo "$line" ;;
  esac
done < <(python3 - "$METADATA" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
limits = {
    "App Name": 30,
    "Subtitle": 30,
    "Promotional Text": 170,
    "Description": 4000,
    "Keywords": 100,
    "What's New": 4000,
}

# Fields whose copy differs per platform are authored as `**macOS App**` /
# `**iOS App**` sub-blocks under one `###` heading, each with its own fence.
# Every fence under the heading is a real ASC field value, so all of them are
# length-checked. Shared fields (App Name, Subtitle, Keywords) carry a single
# fence and fall out of the same code path.
def blocks(section, field):
    heading = re.search(rf"^### {re.escape(field)}[^\n]*$", section, re.M)
    if not heading:
        return []
    rest = section[heading.end():]
    nxt = re.search(r"^#{2,3} ", rest, re.M)
    body = rest[: nxt.start()] if nxt else rest
    labelled = []
    for fence in re.finditer(r"```\n(.*?)\n```", body, re.S):
        before = body[: fence.start()]
        variant = re.findall(r"^\*\*(.+?)\*\*$", before, re.M)
        labelled.append((variant[-1] if variant else None, fence.group(1)))
    return labelled

for language, start, end in (
    ("ko", "## 🇰🇷 Korean", "## 🇯🇵 Japanese"),
    ("ja", "## 🇯🇵 Japanese", "## 🇺🇸 English"),
    ("en", "## 🇺🇸 English", "## Screenshot Guidance"),
):
    section = text.split(start, 1)[1].split(end, 1)[0]
    for field, limit in limits.items():
        found = blocks(section, field)
        if not found:
            print(f"ERROR: {language}: missing {field}")
            continue
        for variant, value in found:
            label = f"{field} [{variant}]" if variant else field
            length = len(value)
            if length > limit:
                print(f"ERROR: {language}: {label} is {length}/{limit} characters")
            else:
                print(f"OK: {language} {label} ({length}/{limit})")
    field_values = "\n".join(re.findall(r"```\n(.*?)\n```", section, re.S))
    forbidden = re.search(r"\b(?:ADB|PTY|Android|agentdeck CLI|Node(?:\.js)? daemon|external daemon)\b", field_values, re.I)
    if forbidden:
        print(f"ERROR: {language}: App Store metadata contains non-Swift-tier term {forbidden.group(0)!r}")
    if "16-display" in field_values or "16개 디스플레이" in field_values:
        print(f"ERROR: {language}: stale 16-display preview count")
PY
)

for plist in "$ROOT/apple/AgentDeck/Resources/Info.plist" "$ROOT/apple/AgentDeck/Resources/Info-macOS.plist"; do
  value="$(/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$plist" 2>/dev/null || true)"
  [[ "$value" == "false" ]] || fail "$(basename "$plist") must set ITSAppUsesNonExemptEncryption=false"
done

privacy="$ROOT/apple/AgentDeck/Resources/PrivacyInfo.xcprivacy"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSPrivacyTracking' "$privacy")" == "false" ]] || fail "Privacy manifest must disable tracking"
privacy_dump="$(/usr/libexec/PlistBuddy -c 'Print :NSPrivacyCollectedDataTypes' "$privacy")"
[[ "$privacy_dump" == *"NSPrivacyCollectedDataTypeOtherUserContent"* ]] || fail "Privacy manifest must declare Other User Content"
[[ "$privacy_dump" == *"NSPrivacyCollectedDataTypeProductInteraction"* ]] || fail "Privacy manifest must declare Product Interaction"
[[ "$(grep -c '<true/>' "$privacy")" -eq 2 ]] || fail "Only the two collected data types should be linked"

icon="$ROOT/apple/AgentDeck/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024x1024.png"
[[ "$(dimension "$icon")" == "1024x1024" ]] || fail "App Store icon must be 1024x1024"
[[ "$(sips -g hasAlpha "$icon" 2>/dev/null | awk '/hasAlpha/{print $2}')" == "no" ]] || fail "App Store icon must not contain alpha"

if [[ "${1:-}" == "--network" ]]; then
  for url in \
    "https://puritysb.github.io/AgentDeck/#privacy" \
    "https://github.com/puritysb/AgentDeck" \
    "https://github.com/puritysb/AgentDeck/issues"; do
    curl --fail --location --silent --show-error --max-time 15 --output /dev/null "$url" || fail "URL is not reachable: $url"
  done
fi

if (( failures > 0 )); then
  echo "App Store submission validation failed with $failures error(s)." >&2
  exit 1
fi

echo "App Store submission package passes validation."
