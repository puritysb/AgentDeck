#!/usr/bin/env bash
# Package the AgentDeck Ulanzi Studio plugin into a self-contained, installable
# `.ulanziPlugin` folder. Ulanzi Studio launches the Node main service from the
# INSTALLED plugin dir (no access to our workspace node_modules), so we:
#   1. esbuild-bundle our TS + @agentdeck/shared + gifenc + vendored SDK → app.js
#      (ESM; @resvg/resvg-js and ws left external — native / optional-native).
#   2. ship a clean npm-layout node_modules with @resvg/resvg-js, every native
#      binary needed by the manifest's macOS/Windows support matrix, and ws.
#   3. assemble manifest + en.json + resources (icons + fonts) + plugin/app.js.
#
# Output: plugin-ulanzi/dist/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/plugin-ulanzi"
NAME="com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin"
SRC_PLUGIN="$PKG/$NAME"
OUT="$PKG/dist/$NAME"
VERSION=$(node -p "require('$SRC_PLUGIN/manifest.json').Version")
# The Marketplace validator requires the ZIP basename to match the single
# top-level plugin folder exactly. Keep versioning in the release tag and
# manifest; changing this filename makes an otherwise valid package fail the
# portal's client-side root check.
ARCHIVE="$ROOT/dist/${NAME}.zip"

RESVG_VERSION="2.6.2"
WS_VERSION="^8.20.0"

echo "==> clean $OUT"
rm -rf "$PKG/dist"
mkdir -p "$OUT/plugin" "$OUT/resources"

echo "==> bundle main service (esbuild, ESM, external resvg+ws)"
npx --yes esbuild "$PKG/src/app.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --external:@resvg/resvg-js --external:ws \
  --outfile="$OUT/plugin/app.js" \
  --log-level=warning
# ESM marker so node treats app.js (and import.meta.url) as a module.
printf '{ "type": "module" }\n' > "$OUT/plugin/package.json"

echo "==> copy manifest + localization + resources"
cp "$SRC_PLUGIN/manifest.json" "$OUT/manifest.json"
# Every <language>.json, not just en: the SDK resolves the language file at the
# plugin root for BOTH the palette name/tooltip and the Property Inspector's
# `Localization` map, so shipping one language silently un-translates the setup
# tutorial for everyone else.
for lang in "$SRC_PLUGIN"/*.json; do
  case "$(basename "$lang")" in
    manifest.json) continue ;;
  esac
  cp "$lang" "$OUT/$(basename "$lang")"
done
cp -R "$SRC_PLUGIN/resources/." "$OUT/resources/"

# Property Inspector + the host stylesheet it borrows. The manifest names this
# path, so a package without it points Ulanzi Studio at a file that is not
# there — worse than shipping no inspector at all. The guard below refuses to
# build that package.
for extra in property-inspector libs; do
  if [ -d "$SRC_PLUGIN/$extra" ]; then
    mkdir -p "$OUT/$extra"
    cp -R "$SRC_PLUGIN/$extra/." "$OUT/$extra/"
  fi
done

PI_PATH="$(node -e "const m=require('$SRC_PLUGIN/manifest.json');const a=(m.Actions||[])[0]||{};process.stdout.write(a.PropertyInspectorPath||'')")"
if [ -n "$PI_PATH" ] && [ ! -f "$OUT/$PI_PATH" ]; then
  echo "ERROR: manifest declares PropertyInspectorPath '$PI_PATH' but it is not in the package" >&2
  exit 1
fi

# The inspector loads the SDK's Property-Inspector libraries, its shared skin,
# and the H5 tutorial page it opens through $UD.openView. Any one of them
# missing is a panel that renders but cannot localize, or a tutorial button
# that opens an empty window — both worse than the plain page 1.0.2 shipped.
for required in \
  libs/js/constants.js libs/js/eventEmitter.js libs/js/timers.js \
  libs/js/utils.js libs/js/ulanziApi.js libs/css/uspi.css \
  property-inspector/setup-common.js property-inspector/inspector.js \
  property-inspector/tutorial.html property-inspector/tutorial.js \
  property-inspector/tutorial.css en.json; do
  if [ ! -f "$OUT/$required" ]; then
    echo "ERROR: required Property Inspector file missing from the package: $required" >&2
    exit 1
  fi
done

echo "==> build runtime node_modules (resvg native + ws) via npm"
TMP="$(mktemp -d)"
cat > "$TMP/package.json" <<JSON
{ "name": "agentdeck-ulanzi-runtime", "private": true,
  "dependencies": {
    "@resvg/resvg-js": "$RESVG_VERSION",
    "@resvg/resvg-js-darwin-arm64": "$RESVG_VERSION",
    "@resvg/resvg-js-darwin-x64": "$RESVG_VERSION",
    "@resvg/resvg-js-win32-x64-msvc": "$RESVG_VERSION",
    "@resvg/resvg-js-win32-arm64-msvc": "$RESVG_VERSION",
    "@resvg/resvg-js-win32-ia32-msvc": "$RESVG_VERSION",
    "ws": "$WS_VERSION"
  } }
JSON
# npm normally skips optional packages for other OS/CPU pairs. These are
# direct dependencies because one Marketplace bundle must run on every OS
# declared in manifest.json; --force permits assembling that universal set.
( cd "$TMP" && npm install --force --omit=dev --no-audit --no-fund --silent )
mkdir -p "$OUT/node_modules"
cp -R "$TMP/node_modules/." "$OUT/node_modules/"
rm -rf "$TMP"

# npm also installs the *host* platform's optional binary on top of the five
# requested above, so a Linux CI runner silently adds resvg-js-linux-x64-gnu —
# 4.4 MB for a platform manifest.json does not declare. That made the released
# archive 11.5 MB while a local build was 9.1 MB: same version, different bytes,
# and the bigger one is the one users would have downloaded. Prune to the
# declared set so the artifact does not depend on where it was built.
KEEP="darwin-arm64 darwin-x64 win32-x64-msvc win32-arm64-msvc win32-ia32-msvc"
for dir in "$OUT"/node_modules/@resvg/resvg-js-*; do
  [ -d "$dir" ] || continue
  target="$(basename "$dir" | sed 's/^resvg-js-//')"
  case " $KEEP " in
    *" $target "*) ;;
    *) echo "    prune @resvg/resvg-js-$target (not a declared platform)"; rm -rf "$dir" ;;
  esac
done

echo "==> verify"
node -e "const fs=require('fs');const p='$OUT';
  for (const f of ['manifest.json','plugin/app.js','plugin/package.json']) if(!fs.existsSync(p+'/'+f)) throw new Error('missing '+f);
  const nm=p+'/node_modules';
  if(!fs.existsSync(nm+'/@resvg/resvg-js')) throw new Error('missing resvg');
  if(!fs.existsSync(nm+'/ws')) throw new Error('missing ws');
  const targets=['darwin-arm64','darwin-x64','win32-x64-msvc','win32-arm64-msvc','win32-ia32-msvc'];
  for (const target of targets) {
    const dir=nm+'/@resvg/resvg-js-'+target;
    if(!fs.existsSync(dir)) throw new Error('missing resvg target '+target);
    if(!require('child_process').execSync('find '+dir+' -name *.node').toString().trim()) throw new Error('missing native binary '+target);
  }
  // The prune above must leave EXACTLY the declared set: an extra host-platform
  // binary is what made a CI archive differ from a local one by 4.4 MB.
  const present=fs.readdirSync(nm+'/@resvg').filter(d=>d.startsWith('resvg-js-')).map(d=>d.slice('resvg-js-'.length)).sort();
  const extra=present.filter(t=>!targets.includes(t));
  if(extra.length) throw new Error('undeclared platform binary in package: '+extra.join(', '));
  console.log('OK — bundle '+(fs.statSync(p+'/plugin/app.js').size/1024|0)+'KB, resvg targets: '+targets.join(', '));
"
echo "==> packaged at: $OUT"

echo "==> create Marketplace upload archive"
mkdir -p "$ROOT/dist"
rm -f "$ARCHIVE"
( cd "$PKG/dist" && COPYFILE_DISABLE=1 zip -qry "$ARCHIVE" "$NAME" )
unzip -tq "$ARCHIVE"
echo "==> upload archive: $ARCHIVE"

# Optional: install into Ulanzi Studio (macOS). `--install` or INSTALL=1.
STUDIO_PLUGINS="$HOME/Library/Application Support/Ulanzi/UlanziDeck/Plugins"
if [ "${1:-}" = "--install" ] || [ "${INSTALL:-}" = "1" ]; then
  if [ -d "$STUDIO_PLUGINS" ]; then
    echo "==> installing into Ulanzi Studio: $STUDIO_PLUGINS"
    rm -rf "$STUDIO_PLUGINS/$NAME"
    cp -R "$OUT" "$STUDIO_PLUGINS/$NAME"
    echo "    Installed. Restart Ulanzi Studio to load the AgentDeck plugin."
  else
    echo "!! Ulanzi Studio plugins dir not found: $STUDIO_PLUGINS"
    echo "   Install Ulanzi Studio and launch it once, then re-run with --install."
  fi
else
  echo "    Install (after Ulanzi Studio is installed + launched once):"
  echo "      cp -R \"$OUT\" \"$STUDIO_PLUGINS/\"   # then restart Ulanzi Studio"
fi
