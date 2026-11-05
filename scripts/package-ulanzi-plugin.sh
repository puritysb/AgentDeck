#!/usr/bin/env bash
# Package the AgentDeck Ulanzi Studio plugin into a self-contained, installable
# `.ulanziPlugin` folder. Ulanzi Studio launches the Node main service from the
# INSTALLED plugin dir (no access to our workspace node_modules), so we:
#   1. esbuild-bundle our TS + @agentdeck/shared + gifenc + resvg-wasm's JS glue
#      + vendored SDK → app.js (ESM; only `ws` is left external).
#   2. ship a clean npm-layout node_modules holding `ws` and nothing else. The
#      package contains NO native binary on any platform — see resources/resvg.wasm.
#   3. assemble manifest + en.json + resources (icons + fonts + resvg.wasm)
#      + plugin/app.js.
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

# Keep in lockstep with plugin-ulanzi/package.json: the WASM and native builds of
# resvg render identically ONLY at the same version, and that identity is the
# whole argument for having dropped the native one.
RESVG_WASM_VERSION="2.6.2"
WS_VERSION="^8.20.0"

echo "==> clean $OUT"
rm -rf "$PKG/dist"
mkdir -p "$OUT/plugin" "$OUT/resources"

# The bundler is PINNED and fetched with `pnpm dlx`, not `npx`. esbuild is not a
# declared dependency of anything here — it is reachable only as a transitive of
# vite — and inside a pnpm workspace `npx` resolves that transitive copy, decides
# esbuild is "already installed", skips installing it, and then cannot find a bin
# because pnpm links no bins for transitive packages. It falls through to
# `sh -c esbuild`: "esbuild: command not found". A dev machine hides this, since
# something has usually left a hoisted `node_modules/.bin/esbuild` behind; a
# clean checkout has not, which is why this surfaced at tag time on the one step
# that produces the release artifact (ulanzi-v1.0.4, 2026-08-24) and why adding a
# version spec did not help — npx's "already installed?" check matches either
# way. Reproduce before changing this line: clone to a fresh directory,
# `pnpm install --frozen-lockfile`, then run this script. Keep the pin in step
# with the esbuild version the workspace resolves.
ESBUILD_VERSION="0.28.2"
echo "==> bundle main service (esbuild@$ESBUILD_VERSION, ESM, external ws)"
# resvg-wasm's glue is plain JS and bundles; only its .wasm is a separate file,
# shipped under resources/ and read at runtime by raster.ts. `ws` stays external
# because it is the one dependency npm must lay out itself.
pnpm dlx "esbuild@$ESBUILD_VERSION" "$PKG/src/app.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --external:ws \
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

echo "==> stage resvg.wasm + runtime node_modules (ws) via npm"
TMP="$(mktemp -d)"
cat > "$TMP/package.json" <<JSON
{ "name": "agentdeck-ulanzi-runtime", "private": true,
  "dependencies": {
    "@resvg/resvg-wasm": "$RESVG_WASM_VERSION",
    "ws": "$WS_VERSION"
  } }
JSON
( cd "$TMP" && npm install --omit=dev --no-audit --no-fund --silent )

# The WASM module is the ONE renderer artifact, identical on every OS and CPU.
# Until 1.0.4 this step assembled five per-platform `.node` binaries instead —
# 18.5 MB of a 20 MB plugin — and macOS raised "Apple could not verify" on the
# arm64 one, because a loose native module inside a folder Ulanzi Studio
# downloads and unpacks has nobody who can sign it. It lives beside the fonts
# rather than in node_modules so raster.ts resolves it the same way (and so the
# esbuild bundle stays the only JS).
cp "$TMP/node_modules/@resvg/resvg-wasm/index_bg.wasm" "$OUT/resources/resvg.wasm"

# `ws` is now the only runtime dependency npm lays out. It is pure JS; its two
# native accelerators (bufferutil, utf-8-validate) are optional and are NOT
# installed, which the no-native check below enforces rather than assumes.
mkdir -p "$OUT/node_modules"
cp -R "$TMP/node_modules/ws" "$OUT/node_modules/ws"
rm -rf "$TMP"

echo "==> verify"
node -e "const fs=require('fs');const path=require('path');const p='$OUT';
  for (const f of ['manifest.json','plugin/app.js','plugin/package.json']) if(!fs.existsSync(p+'/'+f)) throw new Error('missing '+f);
  if(!fs.existsSync(p+'/node_modules/ws')) throw new Error('missing ws');

  // The renderer: one WASM file, no per-platform anything.
  const wasm=p+'/resources/resvg.wasm';
  if(!fs.existsSync(wasm)) throw new Error('missing resources/resvg.wasm');
  if(fs.readFileSync(wasm).subarray(0,4).toString('hex')!=='0061736d') throw new Error('resources/resvg.wasm is not a WebAssembly module');

  // Fonts are load-bearing now: the WASM build has no filesystem and therefore no
  // system-font fallback, so a package missing them renders every tile textless
  // rather than merely differently.
  for (const f of ['IBMPlexSans-Regular.ttf','IBMPlexSans-Bold.ttf','JetBrainsMono-Regular.ttf','JetBrainsMono-Bold.ttf','IBMPlexSansKR-Regular.ttf','IBMPlexSansKR-Bold.ttf','OFL-IBMPlexSansKR.txt','IBMPlexSansJP-Regular.ttf','IBMPlexSansJP-Bold.ttf','OFL-IBMPlexSansJP.txt'])
    if(!fs.existsSync(p+'/resources/fonts/'+f)) throw new Error('missing bundled font '+f);

  // The point of the whole change: nothing in the shipped bundle may be a native
  // binary. Walked over the tree rather than checked against a list of package
  // names, so a dependency that grows an optional native accelerator later cannot
  // slip one in unnoticed.
  const all=fs.readdirSync(p,{recursive:true,withFileTypes:true});
  const native=all.filter(e=>e.isFile()&&/[.](node|dylib|so|dll)\$/.test(e.name)).map(e=>path.join(e.parentPath||e.path,e.name));
  if(native.length) throw new Error('native binary in package: '+native.join(', '));

  // And app.js must not still import the native package.
  if(fs.readFileSync(p+'/plugin/app.js','utf8').includes('@resvg/resvg-js')) throw new Error('app.js still references @resvg/resvg-js');

  let bytes=0; for (const e of all) if(e.isFile()) bytes+=fs.statSync(path.join(e.parentPath||e.path,e.name)).size;
  console.log('OK — bundle '+(fs.statSync(p+'/plugin/app.js').size/1024|0)+'KB, resvg.wasm '+(fs.statSync(wasm).size/1024|0)+'KB, no native binaries, plugin '+(bytes/1048576).toFixed(1)+'MB');
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
