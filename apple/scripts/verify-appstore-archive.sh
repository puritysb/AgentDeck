#!/bin/bash
# verify-appstore-archive.sh — Fail-fast check that a built AgentDeck.app
# meets the App Store submission invariants set by the AGENTDECK_APP_STORE
# compile flag. Called from the CI apple-release workflow after `xcodebuild
# archive` completes, and runnable locally against any built .app.
#
# Auto-detects macOS vs iOS bundles: macOS apps have `Contents/`, iOS apps
# have Info.plist + executable at the bundle root. The macOS-only
# invariants (no Contents/Helpers, no LSRequiresIPhoneOS leak) only run on
# macOS bundles; the common ones (no home-relative-path entitlement, no
# stray executables, no subprocess path strings in the main Mach-O) run
# on both.
#
# Invariants (per Apple Guideline 2.5.2 and our own APP_REVIEW_NOTES.md):
#   COMMON:
#     1. No bundled Node.js, bridge CLI, adb binary, or D200H shell helper.
#     2. No embedded executable other than the main AgentDeck Mach-O.
#     3. Shipped entitlements must be readable, must not contain the
#        home-relative-path temporary exception, and macOS archives must carry
#        the app sandbox entitlement.
#     4. No embedded subprocess path string (`/usr/bin/env`, `/bin/sh`,
#        `/usr/bin/security`, `/usr/bin/sqlite3`) in the main binary.
#     5. No companion-install prompt strings (`npm i @agentdeck/...`,
#        `npx @agentdeck/...`, `brew install agentdeck`) in the main
#        binary — AGENTS.md invariant "App-Store-reachable UI ... must
#        not tell the user to install, register, or launch a companion
#        binary" applies to embedded log/alert strings too, since `strings`
#        on the Mach-O reveals them during review.
#   macOS ONLY:
#     5. `Contents/Info.plist` must not contain iOS-only launch/orientation
#        keys (`LSRequiresIPhoneOS`, `UILaunchScreen`,
#        `UISupportedInterfaceOrientations*`).
#
# Usage:
#   ./verify-appstore-archive.sh /path/to/AgentDeck.app
#
# Exits 0 on success, non-zero on the first failing invariant.

set -euo pipefail

APP="${1:-}"
if [ -z "$APP" ]; then
    echo "Usage: $0 <AgentDeck.app path>" >&2
    exit 2
fi
if [ ! -d "$APP" ]; then
    echo "error: $APP does not exist or is not a directory" >&2
    exit 2
fi

# Detect platform layout so we know where to look for Info.plist / main
# binary and which forbidden-path set to apply.
if [ -d "$APP/Contents" ]; then
    PLATFORM="macos"
    INFO="$APP/Contents/Info.plist"
    MAIN_EXEC="$APP/Contents/MacOS/AgentDeck"
    SCAN_ROOT="$APP/Contents"
    FORBIDDEN_PATHS=(
        "Contents/Helpers/adb"
        "Contents/Helpers/node"
        "Contents/Helpers/agentdeck-d200h-helper"
        "Contents/Resources/node"
        "Contents/Resources/agentdeck-runtime"
        "Contents/Resources/bridge/cli.js"
        "Contents/Resources/bridge/dist/cli.js"
    )
else
    PLATFORM="ios"
    INFO="$APP/Info.plist"
    MAIN_EXEC="$APP/AgentDeck"
    SCAN_ROOT="$APP"
    # iOS wouldn't ship these regardless, but assert just in case.
    FORBIDDEN_PATHS=(
        "Helpers"
        "node"
        "agentdeck-runtime"
        "bridge/cli.js"
    )
fi

FAIL=0
fail() {
    FAIL=1
    echo "FAIL: $*" >&2
}

# (1) Forbidden bundled asset paths.
for path in "${FORBIDDEN_PATHS[@]}"; do
    if [ -e "$APP/$path" ]; then
        fail "bundled asset present: $path"
    fi
done

# (2) No executable files outside the main AgentDeck Mach-O.
# `find -perm` flags differ between BSD (macOS) and GNU; use the BSD form.
EXEC_FILES=$(find "$SCAN_ROOT" -type f -perm +111 2>/dev/null || true)
while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ "$f" = "$MAIN_EXEC" ] && continue
    # Asset catalogs and plist files can be marked +x on some toolchains;
    # we only flag honest Mach-O / scripts.
    case "$f" in
        *.plist|*.strings|*.car|*.nib|*.icns|*.png|*.jpg|*.ttf|*.otf) continue ;;
    esac
    # Detect Mach-O or shebang scripts. LC_ALL=C silences the
    # "illegal byte sequence" complaint that BSD grep emits when scanning
    # raw Mach-O magic bytes on UTF-8 locales.
    head -c 4 "$f" 2>/dev/null | LC_ALL=C grep -qE $'^(#!|\xcf\xfa\xed\xfe|\xce\xfa\xed\xfe)' \
        && fail "extra executable embedded: ${f#$APP/}"
done <<< "$EXEC_FILES"

# (3) macOS-only: Info.plist must not declare iOS-only launch/orientation
# keys. iOS Info.plist legitimately carries these keys, so skip on iOS
# bundles.
if [ "$PLATFORM" = "macos" ] && [ -f "$INFO" ]; then
    IOS_ONLY_PLIST_KEYS=(
        "LSRequiresIPhoneOS"
        "UILaunchScreen"
        "UISupportedInterfaceOrientations"
        "UISupportedInterfaceOrientations~ipad"
    )
    for key in "${IOS_ONLY_PLIST_KEYS[@]}"; do
        if /usr/libexec/PlistBuddy -c "Print :$key" "$INFO" >/dev/null 2>&1; then
            fail "Info.plist contains $key (iOS-only key leaked to macOS archive)"
        fi
    done
fi

# (4) Shipped entitlements must not have home-relative-path exception. The
# signed entitlements live in the code signature, not as a file in the
# bundle — extract via `codesign -d --entitlements -`.
if command -v codesign >/dev/null 2>&1; then
    ENT=$(codesign -d --entitlements - "$APP" 2>&1 || true)
    SIGNING_INFO=$(codesign -dv --verbose=4 "$APP" 2>&1 || true)
    if echo "$ENT" | grep -qi "invalid entitlements"; then
        fail "signed entitlements blob is invalid"
    fi
    if echo "$SIGNING_INFO" | grep -qi "Apple Development\\|iPhone Developer"; then
        fail "archive is signed with a development certificate"
    fi
    if echo "$ENT" | grep -q "home-relative-path"; then
        fail "signed entitlements still contain home-relative-path exception"
    fi
    if echo "$ENT" | awk '
        /\[Key\] get-task-allow/ { in_key = 1; next }
        in_key && /\[Key\]/ { in_key = 0 }
        in_key && /\[Bool\] true/ { found = 1 }
        END { exit(found ? 0 : 1) }
    '; then
        fail "signed entitlements have get-task-allow=true (development signing)"
    fi
    if [ "$PLATFORM" = "macos" ] && ! echo "$ENT" | grep -q "com.apple.security.app-sandbox"; then
        fail "macOS archive is missing com.apple.security.app-sandbox entitlement"
    fi
fi

# (5) Binary string scan — compile-out guards should have removed all
# references to system interpreters in the AgentDeck Mach-O. We tolerate
# system framework references (which contain these paths internally) by
# filtering to lines that start with the path.
if [ -f "$MAIN_EXEC" ]; then
    LEAK=$(strings "$MAIN_EXEC" 2>/dev/null | grep -E '^/usr/bin/env$|^/bin/sh$|^/usr/bin/security$|^/usr/bin/sqlite3$' || true)
    if [ -n "$LEAK" ]; then
        fail "main binary references subprocess paths: $LEAK"
    fi
fi

# (6) Companion-install prompt scan — the App Store UI invariant
# prohibits copy telling the user to install a separate Node.js / npm /
# Homebrew binary. Log strings embedded in the Mach-O are reachable via
# `strings` during review, so they count. This regex is deliberately
# narrow: it targets our actual package namespace and concrete install
# commands, not generic words like "install" which appear legitimately
# (e.g. the hook-installer UI that writes to ~/.claude/settings.json).
if [ -f "$MAIN_EXEC" ]; then
    PROMPT_LEAK=$(strings "$MAIN_EXEC" 2>/dev/null \
        | grep -iE 'npm[[:space:]]+(i|install)[[:space:]]+(-g[[:space:]]+)?@agentdeck|npx[[:space:]]+@agentdeck|brew[[:space:]]+install[[:space:]]+agentdeck' \
        || true)
    if [ -n "$PROMPT_LEAK" ]; then
        fail "main binary embeds companion-install prompt string(s): $PROMPT_LEAK"
    fi
fi

if [ "$FAIL" -ne 0 ]; then
    echo ""
    echo "✗ App Store archive verification FAILED. See errors above." >&2
    exit 1
fi

echo "✓ $APP ($PLATFORM) passes App Store archive verification"
