#!/bin/bash
# Undo install-ci-signing-assets.sh and the upload step, touching only what the
# job created. Safe on a self-hosted maintainer Mac: it restores the user's
# keychain search list, removes only profiles the job added, and never deletes
# anything under $HOME/private_keys.
set -uo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

if [[ -s "$RUNNER_TEMP/original-keychains.txt" ]]; then
    ORIGINAL_KEYCHAINS=()
    while IFS= read -r keychain; do
        [[ -n "$keychain" ]] && ORIGINAL_KEYCHAINS+=("$keychain")
    done < "$RUNNER_TEMP/original-keychains.txt"
    security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" || true
fi
security delete-keychain "$RUNNER_TEMP/app-signing.keychain-db" 2>/dev/null || true

if [[ -f "$RUNNER_TEMP/installed-profiles.txt" ]]; then
    while IFS= read -r profile; do
        [[ -n "$profile" ]] && rm -f "$profile"
    done < "$RUNNER_TEMP/installed-profiles.txt"
fi

rm -f "$RUNNER_TEMP/apple-distribution.p12" "$RUNNER_TEMP/apple-installer.p12"
rm -rf "$RUNNER_TEMP/private_keys"
echo "Signing assets removed; keychain search list: $(security list-keychains -d user | tr -s ' \n' ' ')"
