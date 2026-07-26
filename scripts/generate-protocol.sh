#!/bin/bash
#
# Generate protocol types for Swift and Kotlin from shared/src/protocol.ts.
#
# Usage: bash scripts/generate-protocol.sh
#
# Output:
#   generated/protocol/protocol-schema.json  — JSON Schema (source of truth)
#   generated/protocol/Protocol.swift        — Swift Codable structs
#   generated/protocol/Protocol.kt           — Kotlin data classes
#
# Set AGENTDECK_PROTOCOL_OUT_DIR to emit somewhere else. The drift gate
# (shared/src/__tests__/protocol-generated-sync.test.ts) uses it to regenerate
# into a temp dir and byte-compare, so checking for drift never mutates the
# working tree.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="${AGENTDECK_PROTOCOL_OUT_DIR:-$PROJECT_DIR/generated/protocol}"

mkdir -p "$OUT_DIR"

echo "=== Step 1: Generate JSON Schema from TypeScript ==="
npx ts-json-schema-generator \
  --path "$PROJECT_DIR/shared/src/protocol.ts" \
  --type "BridgeEvent" \
  --tsconfig "$PROJECT_DIR/shared/tsconfig.json" \
  --no-type-check \
  > "$OUT_DIR/bridge-event-schema.json"

npx ts-json-schema-generator \
  --path "$PROJECT_DIR/shared/src/protocol.ts" \
  --type "PluginCommand" \
  --tsconfig "$PROJECT_DIR/shared/tsconfig.json" \
  --no-type-check \
  > "$OUT_DIR/plugin-command-schema.json"

npx ts-json-schema-generator \
  --path "$PROJECT_DIR/shared/src/gateway-protocol.ts" \
  --type "GatewayFrame" \
  --tsconfig "$PROJECT_DIR/shared/tsconfig.json" \
  --no-type-check \
  > "$OUT_DIR/gateway-frame-schema.json"

echo "   → bridge-event-schema.json"
echo "   → plugin-command-schema.json"
echo "   → gateway-frame-schema.json"

# quicktype 23.x derives the top-level type name from the --src path, and its
# path handling breaks on a Windows absolute path: every invocation dies with
# "Cannot infer name for schema ." before it emits anything. POSIX absolute
# paths are unaffected, which is why this only ever failed on Windows. Run
# quicktype from inside OUT_DIR and pass bare filenames — identical output on
# every platform, and the inferred names are unchanged.
#
# The binary is addressed by absolute path rather than through `npx`: the
# subshell's cwd is OUT_DIR, which the drift gate points at a temp dir outside
# the repo, and there `npx quicktype` resolves nothing locally and silently
# downloads the newest quicktype instead of the pinned 23.2.6. That version
# emits Kotlin for jackson rather than Klaxon, so the gate compared artifacts
# built by two different generators and reported false drift.
QUICKTYPE="$PROJECT_DIR/node_modules/.bin/quicktype"
qt() {
  ( cd "$OUT_DIR" && "$QUICKTYPE" "$@" )
}

echo "=== Step 2: Generate Swift types ==="
qt \
  --src "bridge-event-schema.json" \
  --src-lang schema \
  --lang swift \
  --density normal \
  --type-prefix AD \
  --protocol equatable \
  --struct-or-class struct \
  --mutable-properties \
  --acronym-style camel \
  --out "BridgeEvent.swift" \
  2>/dev/null || echo "   (Swift BridgeEvent generation had warnings)"

qt \
  --src "plugin-command-schema.json" \
  --src-lang schema \
  --lang swift \
  --density normal \
  --type-prefix AD \
  --protocol equatable \
  --struct-or-class struct \
  --mutable-properties \
  --acronym-style camel \
  --out "PluginCommand.swift" \
  2>/dev/null || echo "   (Swift PluginCommand generation had warnings)"

#
# GatewayFrame.swift intentionally omits `--protocol equatable`:
# ADGatewayError.details and ADChatToolInvocation.input/output are typed as
# `JSONAny?`, which cannot synthesize Equatable, and quicktype's default
# templates still mark surrounding types as Equatable — Swift 6 strict mode
# rejects the whole compilation. Dropping the protocol sidesteps the issue
# while keeping Codable, which is all the adapter needs.
qt \
  --src "gateway-frame-schema.json" \
  --src-lang schema \
  --lang swift \
  --density normal \
  --type-prefix AD \
  --struct-or-class struct \
  --mutable-properties \
  --acronym-style camel \
  --out "GatewayFrame.swift" \
  2>/dev/null || echo "   (Swift GatewayFrame generation had warnings)"

# Quicktype's Swift support types still use legacy declarations that warn or
# fail under Swift 6. Patch every generated Swift surface so regeneration does
# not reintroduce `JSONNull.hashValue` or non-final Sendable helper classes.
node "$SCRIPT_DIR/patch-quicktype-swift.mjs" \
  "$OUT_DIR/BridgeEvent.swift" \
  "$OUT_DIR/PluginCommand.swift" \
  "$OUT_DIR/GatewayFrame.swift"

echo "   → BridgeEvent.swift"
echo "   → PluginCommand.swift"
echo "   → GatewayFrame.swift"

echo "=== Step 3: Generate Kotlin types ==="
qt \
  --src "bridge-event-schema.json" \
  --src-lang schema \
  --lang kotlin \
  --package dev.agentdeck.generated \
  --out "BridgeEvent.kt" \
  2>&1 | grep -v "^Issue in line" || true

qt \
  --src "plugin-command-schema.json" \
  --src-lang schema \
  --lang kotlin \
  --package dev.agentdeck.generated \
  --out "PluginCommand.kt" \
  2>&1 | grep -v "^Issue in line" || true

qt \
  --src "gateway-frame-schema.json" \
  --src-lang schema \
  --lang kotlin \
  --package dev.agentdeck.generated \
  --out "GatewayFrame.kt" \
  2>&1 | grep -v "^Issue in line" || true

echo "   → BridgeEvent.kt"
echo "   → PluginCommand.kt"
echo "   → GatewayFrame.kt"

echo "=== Step 4: Generate typed command builders ==="
node "$PROJECT_DIR/scripts/generate-command-builders.mjs"

echo ""
echo "=== Done ==="
echo "Generated files in $OUT_DIR/"
echo ""
echo "Compare with existing implementations:"
echo "  diff $OUT_DIR/BridgeEvent.swift apple/AgentDeck/Model/Protocol.swift"
echo "  diff $OUT_DIR/BridgeEvent.kt android/app/src/main/kotlin/.../net/Protocol.kt"
