#!/bin/bash
# Developer-only build. Does not install or restart AgentDeck, hooks or the daemon.
set -euo pipefail
native_dir="$(cd "$(dirname "$0")" && pwd)"
repo_dir="$(cd "$native_dir/../../.." && pwd)"
bundle="$native_dir/build/AttentionObservation.app"
cd "$repo_dir"

# Read only the local user's registry and verify that exact incumbent's identity.
# Never scan ports, copy pairing tokens or start a missing daemon.
daemon_port="$(node --input-type=module -e '
import {readFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
const registry=JSON.parse(readFileSync(join(homedir(),".agentdeck","daemon.json"),"utf8"));
if(!Number.isInteger(registry.port)||registry.port<1024||registry.port>65535||!Number.isInteger(registry.pid)) throw Error("Invalid daemon registry");
process.kill(registry.pid,0);
const response=await fetch(`http://127.0.0.1:${registry.port}/health`,{signal:AbortSignal.timeout(3000),redirect:"error"});
const health=await response.json();
if(!response.ok||health.pid!==registry.pid||health.status!=="ok") throw Error("Daemon registry/health mismatch");
console.log(registry.port);
')"

mkdir -p "$bundle/Contents/MacOS"
xcrun swiftc -swift-version 6 \
  apple/AgentDeck/UI/MenuBar/AttentionContextModel.swift \
  "$native_dir/check-model.swift" -o "$native_dir/build/check-model"
"$native_dir/build/check-model"
xcrun swiftc -swift-version 6 -parse-as-library \
  apple/AgentDeck/UI/MenuBar/AttentionContextModel.swift \
  apple/AgentDeck/UI/MenuBar/AttentionContextPanel.swift \
  apple/AgentDeck/UI/Common/DesignTokens.swift \
  "$native_dir/ObservationApp.swift" -o "$bundle/Contents/MacOS/AttentionObservation"
cp "$native_dir/Info.plist" "$bundle/Contents/Info.plist"
plutil -insert AttentionDaemonPort -string "$daemon_port" "$bundle/Contents/Info.plist"
plutil -insert AttentionRepoPath -string "$repo_dir" "$bundle/Contents/Info.plist"
codesign --force --sign - "$bundle"
printf 'Built local observation app: %s\n' "$bundle"
printf 'Open this app to observe the existing daemon on port %s. No product was replaced.\n' "$daemon_port"
