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
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$PROJECT_DIR/generated/protocol"

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

echo "=== Step 2: Generate Swift types ==="
npx quicktype \
  --src "$OUT_DIR/bridge-event-schema.json" \
  --src-lang schema \
  --lang swift \
  --density normal \
  --type-prefix AD \
  --protocol equatable \
  --struct-or-class struct \
  --mutable-properties \
  --acronym-style camel \
  --out "$OUT_DIR/BridgeEvent.swift" \
  2>/dev/null || echo "   (Swift BridgeEvent generation had warnings)"

npx quicktype \
  --src "$OUT_DIR/plugin-command-schema.json" \
  --src-lang schema \
  --lang swift \
  --density normal \
  --type-prefix AD \
  --protocol equatable \
  --struct-or-class struct \
  --mutable-properties \
  --acronym-style camel \
  --out "$OUT_DIR/PluginCommand.swift" \
  2>/dev/null || echo "   (Swift PluginCommand generation had warnings)"

#
# GatewayFrame.swift intentionally omits `--protocol equatable`:
# ADGatewayError.details and ADChatToolInvocation.input/output are typed as
# `JSONAny?`, which cannot synthesize Equatable, and quicktype's default
# templates still mark surrounding types as Equatable — Swift 6 strict mode
# rejects the whole compilation. Dropping the protocol sidesteps the issue
# while keeping Codable, which is all the adapter needs.
npx quicktype \
  --src "$OUT_DIR/gateway-frame-schema.json" \
  --src-lang schema \
  --lang swift \
  --density normal \
  --type-prefix AD \
  --struct-or-class struct \
  --mutable-properties \
  --acronym-style camel \
  --out "$OUT_DIR/GatewayFrame.swift" \
  2>/dev/null || echo "   (Swift GatewayFrame generation had warnings)"

# Swift 6 strict concurrency rejects non-final Sendable classes. Quicktype's
# boilerplate JSON helpers don't mark `JSONCodingKey` as final; patch it so
# the generated file compiles under `-swift-version 6`. Use the temp-file
# rewrite pattern instead of `sed -i` so this works on both BSD sed (macOS)
# and GNU sed (Linux/CI) — `sed -i ''` is BSD-specific and fails on GNU sed.
sed -e 's/^class JSONCodingKey:/final class JSONCodingKey:/' \
  "$OUT_DIR/GatewayFrame.swift" > "$OUT_DIR/GatewayFrame.swift.tmp"
mv "$OUT_DIR/GatewayFrame.swift.tmp" "$OUT_DIR/GatewayFrame.swift"

echo "   → BridgeEvent.swift"
echo "   → PluginCommand.swift"
echo "   → GatewayFrame.swift"

echo "=== Step 3: Generate Kotlin types ==="
npx quicktype \
  --src "$OUT_DIR/bridge-event-schema.json" \
  --src-lang schema \
  --lang kotlin \
  --package dev.agentdeck.generated \
  --out "$OUT_DIR/BridgeEvent.kt" \
  2>&1 | grep -v "^Issue in line" || true

npx quicktype \
  --src "$OUT_DIR/plugin-command-schema.json" \
  --src-lang schema \
  --lang kotlin \
  --package dev.agentdeck.generated \
  --out "$OUT_DIR/PluginCommand.kt" \
  2>&1 | grep -v "^Issue in line" || true

npx quicktype \
  --src "$OUT_DIR/gateway-frame-schema.json" \
  --src-lang schema \
  --lang kotlin \
  --package dev.agentdeck.generated \
  --out "$OUT_DIR/GatewayFrame.kt" \
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
