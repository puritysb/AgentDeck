#!/bin/bash
# Verify the active toolchain and SDKs before Apple CI builds or imports signing assets.
set -euo pipefail

if [[ "${RUNNER_ENVIRONMENT:-}" == self-hosted && -z "${DEVELOPER_DIR:-}" ]]; then
  xcode=$(find /Applications -maxdepth 1 -type d -name 'Xcode*.app' | sort -V | tail -n 1)
  [[ -n "$xcode" ]] || { echo "::error::No Xcode installation found."; exit 1; }
  export DEVELOPER_DIR="$xcode/Contents/Developer"
fi

version=$(xcodebuild -version)
echo "$version"
if [[ ! "$version" =~ ^Xcode[[:space:]]+([0-9]+)([.]|[[:space:]]) ]] || (( BASH_REMATCH[1] < 27 )); then
  echo "::error::Xcode 27 or later is required."
  exit 1
fi

for sdk in "$@"; do
  sdk_version=$(xcrun --sdk "$sdk" --show-sdk-version)
  echo "$sdk SDK: $sdk_version"
  if [[ ! "$sdk_version" =~ ^([0-9]+)([.]|$) ]] || (( BASH_REMATCH[1] < 27 )); then
    echo "::error::$sdk SDK 27 or later is required."
    exit 1
  fi
done

if [[ -n "${DEVELOPER_DIR:-}" && -n "${GITHUB_ENV:-}" ]]; then
  printf 'DEVELOPER_DIR=%s\n' "$DEVELOPER_DIR" >> "$GITHUB_ENV"
fi
