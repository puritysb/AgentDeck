#!/bin/bash
# AgentDeck ESP32 flash helper
# Safe flashing: identify running boards via device_info_request.
# Never infer Native USB display boards from /dev/cu.usbmodem* numbering.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEFAULT_BAUD=115200

usage() {
    cat <<EOF
Usage:
  $0 auto
  $0 <environment> [port]

Environments:
  ips_35 | round_amoled | box_86 | ulanzi_tc001 | ttgo_t_display

Rules:
  - auto mode only selects boards that answer device_info_request
  - Native USB recovery mode (BOOT/RST) must be flashed with explicit env + port
  - Never trust /dev/cu.usbmodem* numbering for IPS/Round mapping
EOF
}

probe_running_boards() {
python3 - <<'PY'
import glob
import json
import platform
import re
import serial
import sys
import time

patterns = [
    '/dev/cu.usbserial-*',
    '/dev/cu.wchusbserial*',
    '/dev/cu.usbmodem*',
] if platform.system() == 'Darwin' else ['/dev/ttyUSB*', '/dev/ttyACM*']
exclude = re.compile(r'Bluetooth|WLAN|debug', re.IGNORECASE)
found = []
for pattern in patterns:
    for port in sorted(glob.glob(pattern)):
        if exclude.search(port):
            continue
        try:
            ser = serial.Serial(port, baudrate=115200, timeout=0.4)
            ser.reset_input_buffer()
            ser.write(b'{"type":"device_info_request"}\n')
            ser.flush()
            deadline = time.time() + 1.5
            while time.time() < deadline:
                raw = ser.readline()
                if not raw:
                    continue
                line = raw.decode('utf-8', errors='replace').strip()
                if not line.startswith('{'):
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get('type') == 'device_info' and obj.get('board'):
                    print(f"{obj['board']} {port}")
                    found.append(port)
                    break
            ser.close()
        except Exception:
            continue
PY
}

map_env_to_pio() {
    case "$1" in
        ips_35|ips35) echo "ips35" ;;
        round_amoled|amoled) echo "amoled" ;;
        box_86|86box) echo "box_86" ;;
        ulanzi_tc001|led8x32) echo "led8x32" ;;
        ttgo_t_display|ttgo) echo "ttgo" ;;
        ips_10|ips10) echo "ips10" ;;
        *) echo "$1" ;;
    esac
}

validate_env() {
    case "$1" in
        ips_35|ips35|round_amoled|amoled|box_86|86box|ulanzi_tc001|led8x32|ttgo_t_display|ttgo|ips_10|ips10) ;;
        *)
            echo "Unknown environment: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
}

warn_recovery_mode() {
    cat <<EOF
No running firmware responded on $1.

If this is an IPS/Round Native USB board in recovery mode:
  1. Hold BOOT
  2. Connect USB or tap RST
  3. Release BOOT after the usbmodem port stays up
  4. Re-run with explicit env and port:
     $0 ips_35 $1
     $0 round_amoled $1

Do not guess IPS vs Round from the usbmodem number alone.
EOF
}

pick_auto_board() {
    local matches
    matches="$(probe_running_boards)"
    if [ -z "$matches" ]; then
        echo "No running ESP32 board answered device_info_request." >&2
        echo "auto mode refuses to guess." >&2
        usage >&2
        exit 1
    fi
    if [ "$(printf '%s\n' "$matches" | wc -l | tr -d ' ')" -ne 1 ]; then
        echo "Multiple ESP32 boards responded:" >&2
        printf '%s\n' "$matches" >&2
        echo "Specify env and port explicitly." >&2
        exit 1
    fi
    printf '%s\n' "$matches"
}

ENV="${1:-auto}"
PORT="${2:-}"

if [ "$ENV" = "auto" ]; then
    AUTO_MATCH="$(pick_auto_board)"
    read -r ENV PORT <<< "$AUTO_MATCH"
    echo "Detected running board via device_info_request: env=$ENV port=$PORT"
else
    validate_env "$ENV"
fi

PIO_ENV="$(map_env_to_pio "$ENV")"

if [ -n "$PORT" ]; then
    # Safety check: if the target answers device_info_request, it must match the env.
    MATCH="$(probe_running_boards | awk -v p="$PORT" '$2 == p { print $1 }')"
    if [ -n "$MATCH" ] && [ "$(map_env_to_pio "$MATCH")" != "$PIO_ENV" ]; then
        echo "Refusing flash: port $PORT reports board=$MATCH but env=$ENV" >&2
        exit 1
    fi
fi

if [ -z "$PORT" ]; then
    echo "No port specified. PlatformIO/default config will be used." >&2
    echo "For Native USB recovery, pass the port explicitly." >&2
fi

if [ -n "$PORT" ] && [[ "$PORT" == *usbmodem* ]]; then
    MATCH="$(probe_running_boards | awk -v p="$PORT" '$2 == p { print $1 }')"
    if [ -z "$MATCH" ]; then
        warn_recovery_mode "$PORT"
    fi
fi

echo "Building and flashing: env=$ENV (PlatformIO env=$PIO_ENV) port=${PORT:-<default>}"
cd "$PROJECT_DIR"

# Build
pio run -e "$PIO_ENV"

# Upload
if [ -n "$PORT" ]; then
    pio run -e "$PIO_ENV" -t upload --upload-port "$PORT"
else
    pio run -e "$PIO_ENV" -t upload
fi

# Monitor
echo ""
echo "Flash complete! Starting monitor (Ctrl+C to exit)..."
if [ -n "$PORT" ]; then
    pio device monitor --port "$PORT" --baud "$DEFAULT_BAUD"
else
    pio device monitor -e "$PIO_ENV"
fi
