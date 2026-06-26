#!/usr/bin/env bash
set -euo pipefail

# Capture diagnostics from an AgentDeck app that was launched from Xcode.
# This is a development-only repository tool. It does not run inside the app,
# change app behavior, or affect App Store builds.

usage() {
  cat <<'EOF'
Usage: bash scripts/capture-apple-diagnostics.sh [options]

Options:
  --port <port>             Daemon HTTP port. Defaults to daemon.json discovery, then 9120-9139 scan.
  --tail <lines>            Log lines to request/copy. Default: 1000.
  --last <duration>         OSLog window for `log show`. Default: 15m.
  --out <directory>         Output directory. Default: diagnostics/apple-xcode/<timestamp>.
  --sample                  Capture a short `sample` for running AgentDeck processes. Default.
  --no-sample               Skip process sampling.
  --sample-duration <sec>   Seconds per process sample. Default: 5.
  -h, --help                Show this help.

The capture intentionally avoids auth-token, settings.json, and OpenClaw config files.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT=""
TAIL_LINES="1000"
OSLOG_LAST="15m"
OUT_DIR=""
DO_SAMPLE="1"
SAMPLE_DURATION="5"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --tail)
      TAIL_LINES="${2:-}"
      shift 2
      ;;
    --last)
      OSLOG_LAST="${2:-}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --sample)
      DO_SAMPLE="1"
      shift
      ;;
    --no-sample)
      DO_SAMPLE="0"
      shift
      ;;
    --sample-duration)
      SAMPLE_DURATION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$TAIL_LINES" in
  ''|*[!0-9]*) echo "--tail must be a positive integer" >&2; exit 2 ;;
esac
case "$SAMPLE_DURATION" in
  ''|*[!0-9]*) echo "--sample-duration must be a positive integer" >&2; exit 2 ;;
esac
if [[ -n "$PORT" ]]; then
  case "$PORT" in
    *[!0-9]*) echo "--port must be an integer" >&2; exit 2 ;;
  esac
fi

timestamp="$(date +"%Y%m%d-%H%M%S")"
if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$REPO_ROOT/diagnostics/apple-xcode/$timestamp"
elif [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$REPO_ROOT/$OUT_DIR"
fi

mkdir -p "$OUT_DIR"
mkdir -p "$OUT_DIR/log-files" "$OUT_DIR/state-files" "$OUT_DIR/process"

APPSTORE_DIR="$HOME/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck"
GROUP_DIR="$HOME/Library/Group Containers/group.bound.serendipity.agent.deck"
LEGACY_DIR="$HOME/.agentdeck"
PORT_DETECTION="not attempted"

run_limited() {
  local seconds="$1"
  shift
  if command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift @ARGV; exec @ARGV' "$seconds" "$@"
  else
    "$@"
  fi
}

read_port_from_daemon_json() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$file" | head -n 1
}

is_live_status_port() {
  local candidate="$1"
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:${candidate}/status" >/dev/null 2>&1
}

discover_port() {
  local detected=""
  local source=""
  local file
  local stale=""

  for file in "$APPSTORE_DIR/daemon.json" "$GROUP_DIR/daemon.json" "$LEGACY_DIR/daemon.json"; do
    detected="$(read_port_from_daemon_json "$file" || true)"
    if [[ -n "$detected" ]]; then
      if is_live_status_port "$detected"; then
        source="$file"
        PORT="$detected"
        PORT_DETECTION="daemon.json: $source"
        return 0
      fi
      stale="${stale}${file} -> ${detected}; "
    fi
  done

  if command -v curl >/dev/null 2>&1; then
    local candidate
    for candidate in $(seq 9120 9139); do
      if is_live_status_port "$candidate"; then
        PORT="$candidate"
        if [[ -n "$stale" ]]; then
          PORT_DETECTION="port scan: 127.0.0.1:$candidate; stale daemon.json entries: $stale"
        else
          PORT_DETECTION="port scan: 127.0.0.1:$candidate"
        fi
        return 0
      fi
    done
  fi

  if [[ -n "$stale" ]]; then
    PORT_DETECTION="stale daemon.json entries: $stale; no live 9120-9139 status endpoint"
  else
    PORT_DETECTION="no daemon.json port and no live 9120-9139 status endpoint"
  fi
  return 1
}

capture_command() {
  local file="$1"
  shift
  {
    printf '$'
    printf ' %q' "$@"
    printf '\n'
    "$@"
  } >"$OUT_DIR/$file" 2>&1 || {
    local status=$?
    echo "[exit status: $status]" >>"$OUT_DIR/$file"
  }
}

fetch_endpoint() {
  local endpoint="$1"
  local file="$2"
  local url=""

  if [[ -z "$PORT" ]]; then
    cat >"$OUT_DIR/$file" <<'EOF'
{
  "status": "unavailable",
  "error": "No AgentDeck daemon port was discovered"
}
EOF
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    cat >"$OUT_DIR/$file" <<'EOF'
{
  "status": "unavailable",
  "error": "curl is not available"
}
EOF
    return 0
  fi

  url="http://127.0.0.1:${PORT}${endpoint}"
  if ! curl -sS --connect-timeout 2 --max-time 8 "$url" >"$OUT_DIR/$file" 2>"$OUT_DIR/$file.stderr"; then
    local status=$?
    cat >"$OUT_DIR/$file" <<EOF
{
  "status": "unavailable",
  "url": "$url",
  "curlExitStatus": $status
}
EOF
  fi
}

tail_if_exists() {
  local source="$1"
  local target="$2"
  local timeout_seconds="8"

  if [[ ! -f "$source" ]]; then
    echo "missing: $source" >"$OUT_DIR/log-files/$target"
    return 0
  fi

  if ! run_limited "$timeout_seconds" tail -n "$TAIL_LINES" "$source" >"$OUT_DIR/log-files/$target" 2>"$OUT_DIR/log-files/$target.stderr"; then
    local status=$?
    echo "tail failed or timed out for: $source" >"$OUT_DIR/log-files/$target"
    echo "exit status: $status" >>"$OUT_DIR/log-files/$target"
  fi
}

copy_if_exists() {
  local source="$1"
  local target="$2"
  if [[ -f "$source" ]]; then
    cp "$source" "$OUT_DIR/state-files/$target" 2>"$OUT_DIR/state-files/$target.stderr" || true
  else
    echo "missing: $source" >"$OUT_DIR/state-files/$target.missing"
  fi
}

if [[ -z "$PORT" ]]; then
  discover_port || true
else
  PORT_DETECTION="explicit --port"
fi

cat >"$OUT_DIR/capture-meta.txt" <<EOF
capturedAtUTC: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
repoRoot: $REPO_ROOT
port: ${PORT:-unresolved}
portDetection: $PORT_DETECTION
tailLines: $TAIL_LINES
oslogWindow: $OSLOG_LAST
sampleEnabled: $DO_SAMPLE
sampleDurationSeconds: $SAMPLE_DURATION
groupContainer: $GROUP_DIR
legacyDataDir: $LEGACY_DIR
EOF

fetch_endpoint "/status" "status.json"
fetch_endpoint "/diag?tail=$TAIL_LINES" "diag.json"
fetch_endpoint "/devices" "devices.json"
fetch_endpoint "/usage" "usage.json"
fetch_endpoint "/health" "health.json"

tail_if_exists "$APPSTORE_DIR/swift-daemon.log" "appstore-swift-daemon.log"
tail_if_exists "$GROUP_DIR/swift-daemon.log" "legacy-group-swift-daemon.log"
tail_if_exists "$LEGACY_DIR/swift-daemon.log" "legacy-swift-daemon.log"
tail_if_exists "$LEGACY_DIR/bridge.log" "legacy-bridge.log"

copy_if_exists "$APPSTORE_DIR/daemon.json" "appstore-daemon.json"
copy_if_exists "$APPSTORE_DIR/sessions.json" "appstore-sessions.json"
copy_if_exists "$GROUP_DIR/daemon.json" "legacy-group-daemon.json"
copy_if_exists "$GROUP_DIR/sessions.json" "legacy-group-sessions.json"
copy_if_exists "$LEGACY_DIR/daemon.json" "legacy-daemon.json"
copy_if_exists "$LEGACY_DIR/sessions.json" "legacy-sessions.json"

capture_command "process/pgrep-agentdeck.txt" pgrep -fl "AgentDeck|agentdeck"
{
  echo '$ ps -axo pid,ppid,stat,etime,command | awk agentdeck-filter'
  ps -axo pid,ppid,stat,etime,command | awk 'NR == 1 || /[Aa]gent[Dd]eck|[Aa]gentdeck/'
} >"$OUT_DIR/process/ps-agentdeck.txt" 2>&1 || {
  status=$?
  echo "[exit status: $status]" >>"$OUT_DIR/process/ps-agentdeck.txt"
}

if command -v log >/dev/null 2>&1; then
  if ! run_limited 25 log show --style compact --last "$OSLOG_LAST" --info --debug \
    --predicate 'subsystem == "dev.agentdeck.daemon" OR process == "AgentDeck" OR process == "AgentDeck Dashboard"' \
    >"$OUT_DIR/oslog-AgentDeck.log" 2>"$OUT_DIR/oslog-AgentDeck.log.stderr"; then
    echo "log show failed or timed out; see oslog-AgentDeck.log.stderr" >"$OUT_DIR/oslog-AgentDeck.log"
  fi
else
  echo "log command not available" >"$OUT_DIR/oslog-AgentDeck.log"
fi

if [[ "$DO_SAMPLE" == "1" ]] && command -v sample >/dev/null 2>&1 && command -v pgrep >/dev/null 2>&1; then
  pids="$(pgrep -f "AgentDeck" || true)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      run_limited "$((SAMPLE_DURATION + 5))" sample "$pid" "$SAMPLE_DURATION" -file "$OUT_DIR/process/sample-$pid.txt" \
        >"$OUT_DIR/process/sample-$pid.stdout" 2>"$OUT_DIR/process/sample-$pid.stderr" || true
    done <<<"$pids"
  else
    echo "No AgentDeck process found for sample." >"$OUT_DIR/process/sample-skipped.txt"
  fi
elif [[ "$DO_SAMPLE" != "1" ]]; then
  echo "Sampling disabled by --no-sample." >"$OUT_DIR/process/sample-skipped.txt"
else
  echo "sample or pgrep command not available." >"$OUT_DIR/process/sample-skipped.txt"
fi

cat >"$OUT_DIR/README.md" <<EOF
# AgentDeck Apple Xcode Diagnostics

Captured: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

Start analysis with:

- \`capture-meta.txt\` for capture parameters and daemon port discovery.
- \`diag.json\` for daemon state, module health, and recent in-process daemon log lines.
- \`status.json\` for dashboard-facing state.
- \`log-files/group-swift-daemon.log\` or \`log-files/legacy-swift-daemon.log\` for file log tails.
- \`oslog-AgentDeck.log\` for unified logging from the Xcode-launched process.
- \`process/\` for process list and optional short samples.

This folder is a local development artifact. It intentionally excludes auth-token,
settings.json, OpenClaw configuration, and other credential-bearing files.
EOF

latest_link="$REPO_ROOT/diagnostics/apple-xcode/latest"
if mkdir -p "$(dirname "$latest_link")"; then
  rm -f "$latest_link"
  ln -s "$(basename "$OUT_DIR")" "$latest_link" 2>/dev/null || true
fi

echo "Apple diagnostics captured: $OUT_DIR"
if [[ -e "$latest_link" ]]; then
  echo "Latest symlink: $latest_link"
fi
