#!/usr/bin/env bash
set -uo pipefail

# Check the macOS grants an unattended build -> deploy -> E2E run needs BEFORE
# the run starts, so a TCC consent sheet or firewall prompt does not stall an
# agent halfway through. Development-only repository tool; it never runs inside
# the app and changes no setting.
#
# Every probe has three answers (AGENTS.md "A probe has three answers"):
#   granted  - the grant was observed
#   denied   - the grant was observed to be missing
#   unknown  - the probe could not look (timeout, unexpected error, missing tool)
# "unknown" is never reported as "granted".
#
# Probes are bounded with a perl alarm wrapper because stock macOS has no
# `timeout` (same pattern as run_limited in scripts/capture-apple-diagnostics.sh).
# The first Automation/Accessibility probe for a terminal can itself raise the
# consent sheet; answer it once and rerun. Nothing here clicks through a prompt.

usage() {
  cat <<'EOF'
Usage: bash scripts/macos-preflight.sh [checks] [--json]

Checks (at least one; they combine):
  --automation            Apple Events to System Events (osascript)
  --accessibility         System Events UI scripting (assistive access)
  --screen-recording      CGPreflightScreenCaptureAccess() for this terminal
  --firewall <app path>   Application Firewall state and whether <app> is blocked
  --devtools              DevToolsSecurity (debugger attach without a password)
  --all                   automation + accessibility + screen-recording + devtools
                          (add --firewall <app> to include the firewall)

Output:
  --json                  Print one JSON object instead of the text table.
  -h, --help              Show this help.

Exit: 0 all granted (or not macOS), 2 at least one denied,
      3 none denied but at least one unknown, 64 usage error.
EOF
}

WANT_AUTOMATION=0
WANT_ACCESSIBILITY=0
WANT_SCREEN=0
WANT_DEVTOOLS=0
FIREWALL_APP=""
JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --automation) WANT_AUTOMATION=1 ;;
    --accessibility) WANT_ACCESSIBILITY=1 ;;
    --screen-recording) WANT_SCREEN=1 ;;
    --devtools) WANT_DEVTOOLS=1 ;;
    --firewall)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--firewall needs an app path" >&2; exit 64; }
      FIREWALL_APP="$2"
      shift
      ;;
    --all) WANT_AUTOMATION=1; WANT_ACCESSIBILITY=1; WANT_SCREEN=1; WANT_DEVTOOLS=1 ;;
    --json) JSON=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

if [[ $((WANT_AUTOMATION + WANT_ACCESSIBILITY + WANT_SCREEN + WANT_DEVTOOLS)) -eq 0 && -z "$FIREWALL_APP" ]]; then
  echo "No check selected." >&2
  usage >&2
  exit 64
fi

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
if [[ "$OS_NAME" != "Darwin" ]]; then
  if [[ "$JSON" -eq 1 ]]; then
    printf '{"platform":"%s","skipped":true,"result":"skipped","checks":[]}\n' "$(json_escape "$OS_NAME")"
  else
    echo "macos-preflight: skipped on $OS_NAME (macOS-only checks)."
  fi
  exit 0
fi

# Same alarm pattern as run_limited in capture-apple-diagnostics.sh, but the
# probe runs in its own process group and the whole group is killed on expiry:
# a plain exec'd alarm leaves grandchildren holding the $(...) pipe open, so
# the caller would still wait for them. Exit 142 (128+SIGALRM) means timed out.
run_limited() {
  local seconds="$1"
  shift
  if command -v perl >/dev/null 2>&1; then
    perl -e '
      my $t = shift @ARGV;
      my $pid = fork;
      exit 125 unless defined $pid;
      if ($pid == 0) { setpgrp(0, 0); exec @ARGV or exit 127; }
      $SIG{ALRM} = sub { kill "KILL", -$pid; waitpid($pid, 0); exit 142 };
      alarm $t;
      waitpid($pid, 0);
      alarm 0;
      exit(($? & 127) ? 128 + ($? & 127) : $? >> 8);
    ' "$seconds" "$@"
  else
    "$@"
  fi
}

# The TCC grant belongs to the "responsible" app (the terminal or agent host
# that launched this shell), not to osascript. Name it so the fix path is exact.
responsible_app() {
  case "${TERM_PROGRAM:-}" in
    Apple_Terminal) echo "Terminal"; return ;;
    iTerm.app) echo "iTerm"; return ;;
    vscode) echo "Visual Studio Code (or the VS Code fork hosting this shell)"; return ;;
    WezTerm) echo "WezTerm"; return ;;
    ghostty) echo "Ghostty"; return ;;
    WarpTerminal) echo "Warp"; return ;;
    tmux) echo "the terminal app running tmux"; return ;;
  esac
  if [[ -n "${__CFBundleIdentifier:-}" ]]; then
    echo "the app with bundle id ${__CFBundleIdentifier}"
    return
  fi
  echo "the terminal/agent app that launched this shell"
}
APP_LABEL="$(responsible_app)"

# Last "(-NNNN)" AppleScript error number in the text, or empty.
ae_error_number() {
  printf '%s' "$1" | grep -oE '\(-?[0-9]+\)' | tail -n 1 | tr -d '()'
}

NAMES=()
STATUSES=()
DETAILS=()
FIXES=()

record() {
  NAMES+=("$1")
  STATUSES+=("$2")
  DETAILS+=("$3")
  FIXES+=("${4:-}")
}

one_line() {
  printf '%s' "$1" | tr '\n' ' ' | sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//' | cut -c1-200
}

AUTOMATION_STATUS=""

probe_automation() {
  local out rc code fix
  fix="System Settings › Privacy & Security › Automation › $APP_LABEL › System Events"
  if ! command -v osascript >/dev/null 2>&1; then
    record automation unknown "osascript not found" ""
    AUTOMATION_STATUS=unknown
    return
  fi
  out="$(run_limited 10 osascript \
    -e 'with timeout of 6 seconds' \
    -e 'tell application "System Events" to get name of first process' \
    -e 'end timeout' 2>&1)"
  rc=$?
  code="$(ae_error_number "$out")"
  if [[ $rc -eq 0 ]]; then
    record automation granted "System Events answered" ""
    AUTOMATION_STATUS=granted
  elif [[ "$code" == "-1743" ]]; then
    record automation denied "not authorized to send Apple events to System Events (-1743)" "$fix"
    AUTOMATION_STATUS=denied
  elif [[ "$code" == "-1712" || $rc -eq 142 ]]; then
    record automation unknown "Apple event timed out; a consent prompt is probably waiting on screen — answer it, then rerun" "$fix"
    AUTOMATION_STATUS=unknown
  else
    record automation unknown "osascript failed (rc=$rc${code:+, error $code}): $(one_line "$out")" ""
    AUTOMATION_STATUS=unknown
  fi
}

probe_accessibility() {
  local out rc code fix
  fix="System Settings › Privacy & Security › Accessibility › $APP_LABEL"
  if ! command -v osascript >/dev/null 2>&1; then
    record accessibility unknown "osascript not found" ""
    return
  fi
  # UI-element query: needs assistive access, answers 0 when nothing is open.
  out="$(run_limited 10 osascript \
    -e 'with timeout of 6 seconds' \
    -e 'tell application "System Events" to count windows of (first process whose frontmost is true)' \
    -e 'end timeout' 2>&1)"
  rc=$?
  code="$(ae_error_number "$out")"
  if [[ $rc -eq 0 ]]; then
    record accessibility granted "System Events UI query answered" ""
  elif [[ "$code" == "-25211" ]] || { [[ "$code" == "-1719" ]] && printf '%s' "$out" | grep -qiE 'assistive|not allowed|accessibility'; }; then
    record accessibility denied "System Events UI scripting refused (${code})" "$fix"
  elif [[ "$code" == "-1743" ]]; then
    record accessibility unknown "blocked by the Automation denial; fix Automation first" ""
  elif [[ "$code" == "-1712" || $rc -eq 142 ]]; then
    record accessibility unknown "UI query timed out; a consent prompt may be waiting on screen" "$fix"
  else
    record accessibility unknown "osascript failed (rc=$rc${code:+, error $code}): $(one_line "$out")" ""
  fi
}

probe_screen_recording() {
  local out rc fix tmp
  fix="System Settings › Privacy & Security › Screen & System Audio Recording (macOS 14 and earlier: Screen Recording) › $APP_LABEL, then relaunch that app"
  # CGPreflightScreenCaptureAccess never prompts; it only reports.
  if command -v osascript >/dev/null 2>&1; then
    out="$(run_limited 10 osascript -l JavaScript \
      -e 'ObjC.import("CoreGraphics"); $.CGPreflightScreenCaptureAccess() ? "granted" : "denied"' 2>&1)"
    rc=$?
    if [[ $rc -eq 0 && "$out" == "granted" ]]; then
      record screen-recording granted "CGPreflightScreenCaptureAccess() = true (JXA)" ""
      return
    elif [[ $rc -eq 0 && "$out" == "denied" ]]; then
      record screen-recording denied "CGPreflightScreenCaptureAccess() = false (JXA)" "$fix"
      return
    fi
  fi
  # Fallback: swift. Only when a developer directory exists — the /usr/bin/swift
  # shim otherwise raises the "install command line tools" dialog.
  if ! command -v swift >/dev/null 2>&1 || ! run_limited 5 xcode-select -p >/dev/null 2>&1; then
    record screen-recording unknown "JXA probe failed and swift is unavailable" ""
    return
  fi
  tmp="$(mktemp -t agentdeck-preflight 2>/dev/null)" || { record screen-recording unknown "mktemp failed" ""; return; }
  mv "$tmp" "$tmp.swift" 2>/dev/null && tmp="$tmp.swift"
  printf '%s\n' 'import CoreGraphics' 'print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")' >"$tmp"
  out="$(run_limited 60 swift "$tmp" 2>&1)"
  rc=$?
  rm -f "$tmp"
  out="$(printf '%s' "$out" | tail -n 1)"
  if [[ $rc -eq 0 && "$out" == "granted" ]]; then
    record screen-recording granted "CGPreflightScreenCaptureAccess() = true (swift)" ""
  elif [[ $rc -eq 0 && "$out" == "denied" ]]; then
    record screen-recording denied "CGPreflightScreenCaptureAccess() = false (swift)" "$fix"
  else
    record screen-recording unknown "swift probe failed (rc=$rc): $(one_line "$out")" ""
  fi
}

probe_firewall() {
  local app="$1" fw out rc state fix
  fw=/usr/libexec/ApplicationFirewall/socketfilterfw
  fix="System Settings › Network › Firewall › Options… › $app › Allow incoming connections (or: sudo $fw --add \"$app\" --unblockapp \"$app\")"
  if [[ ! -x "$fw" ]]; then
    record firewall unknown "$fw not found" ""
    return
  fi
  out="$(run_limited 10 "$fw" --getglobalstate 2>&1)"
  rc=$?
  state="$(printf '%s' "$out" | grep -oE 'State = [0-9]+' | grep -oE '[0-9]+' | head -n 1)"
  if [[ $rc -ne 0 || -z "$state" ]]; then
    if printf '%s' "$out" | grep -qi 'disabled'; then
      state=0
    elif printf '%s' "$out" | grep -qi 'enabled'; then
      state=1
    else
      record firewall unknown "could not read firewall state (rc=$rc): $(one_line "$out")" ""
      return
    fi
  fi
  if [[ "$state" == "0" ]]; then
    record firewall granted "Application Firewall is off" ""
    return
  fi
  if [[ "$state" == "2" ]]; then
    record firewall denied "firewall blocks all incoming connections (State = 2)" "System Settings › Network › Firewall › Options… › turn off \"Block all incoming connections\""
    return
  fi
  if [[ ! -e "$app" ]]; then
    record firewall unknown "firewall is on and $app does not exist yet (build first, then rerun)" ""
    return
  fi
  out="$(run_limited 10 "$fw" --getappblocked "$app" 2>&1)"
  rc=$?
  if printf '%s' "$out" | grep -qiE 'is permitted|is allowed|not blocked'; then
    record firewall granted "firewall on; $app is permitted" ""
  elif printf '%s' "$out" | grep -qiE 'is blocked'; then
    record firewall denied "firewall on; $app is blocked" "$fix"
  elif printf '%s' "$out" | grep -qiE 'not part of|not in|no such|does not exist'; then
    record firewall denied "firewall on; $app is not listed, so macOS will prompt on its first incoming connection" "$fix"
  else
    record firewall unknown "could not read app rule (rc=$rc): $(one_line "$out")" ""
  fi
}

probe_devtools() {
  local out rc
  if ! command -v DevToolsSecurity >/dev/null 2>&1; then
    record devtools unknown "DevToolsSecurity not found" ""
    return
  fi
  out="$(run_limited 10 DevToolsSecurity -status 2>&1)"
  rc=$?
  if printf '%s' "$out" | grep -qi 'enabled'; then
    record devtools granted "developer mode enabled" ""
  elif printf '%s' "$out" | grep -qi 'disabled'; then
    record devtools denied "developer mode disabled; debugger attach will ask for an admin password" "Terminal: sudo DevToolsSecurity -enable (no System Settings pane controls this)"
  else
    record devtools unknown "could not read status (rc=$rc): $(one_line "$out")" ""
  fi
}

[[ $WANT_AUTOMATION -eq 1 ]] && probe_automation
if [[ $WANT_ACCESSIBILITY -eq 1 ]]; then
  if [[ "$AUTOMATION_STATUS" == "denied" ]]; then
    record accessibility unknown "not probed: Automation to System Events is denied" ""
  else
    probe_accessibility
  fi
fi
[[ $WANT_SCREEN -eq 1 ]] && probe_screen_recording
[[ -n "$FIREWALL_APP" ]] && probe_firewall "$FIREWALL_APP"
[[ $WANT_DEVTOOLS -eq 1 ]] && probe_devtools

any_denied=0
any_unknown=0
for s in "${STATUSES[@]}"; do
  [[ "$s" == "denied" ]] && any_denied=1
  [[ "$s" == "unknown" ]] && any_unknown=1
done
if [[ $any_denied -eq 1 ]]; then
  RESULT=denied; EXIT_CODE=2
elif [[ $any_unknown -eq 1 ]]; then
  RESULT=unknown; EXIT_CODE=3
else
  RESULT=granted; EXIT_CODE=0
fi

if [[ "$JSON" -eq 1 ]]; then
  printf '{"platform":"Darwin","responsibleApp":"%s","result":"%s","exitCode":%d,"checks":[' \
    "$(json_escape "$APP_LABEL")" "$RESULT" "$EXIT_CODE"
  for i in "${!NAMES[@]}"; do
    [[ $i -gt 0 ]] && printf ','
    printf '{"name":"%s","status":"%s","detail":"%s","fix":"%s"}' \
      "$(json_escape "${NAMES[$i]}")" "${STATUSES[$i]}" \
      "$(json_escape "${DETAILS[$i]}")" "$(json_escape "${FIXES[$i]}")"
  done
  printf ']}\n'
else
  echo "macOS preflight (grants belong to: $APP_LABEL)"
  for i in "${!NAMES[@]}"; do
    printf '  %-17s %-8s %s\n' "${NAMES[$i]}" "${STATUSES[$i]}" "${DETAILS[$i]}"
    if [[ -n "${FIXES[$i]}" && "${STATUSES[$i]}" != "granted" ]]; then
      printf '  %-17s %-8s fix: %s\n' "" "" "${FIXES[$i]}"
    fi
  done
  case "$RESULT" in
    granted) echo "result: all required grants present" ;;
    denied) echo "result: denied — grant the items above, then rerun (exit 2)" ;;
    unknown) echo "result: could not confirm every grant — nothing denied, but do not assume granted (exit 3)" ;;
  esac
fi

exit "$EXIT_CODE"
