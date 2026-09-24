#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Git topology detects linked worktrees regardless of their directory names.
if [ "$(git -C "$PROJECT_DIR" rev-parse --absolute-git-dir)" != "$(cd "$PROJECT_DIR" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" ]; then
  fail "Run the installer from the persistent main checkout, not a linked worktree."
  exit 1
fi

echo ""
echo "========================================="
echo "  AgentDeck Installer"
echo "========================================="
echo ""

# --- Check required dependencies ---
MISSING_REQUIRED=0

# Maintained, prebuild-verified Node.js lines. Node 20 is EOL, and accepting
# every odd release would promise native-module support after those short-lived
# lines leave maintenance.
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  case "$NODE_VER" in
    22|24|26) ok "Node.js $(node -v)" ;;
    *)
      fail "Node.js $(node -v) — supported versions are 22, 24, and 26 (Node 20 reached EOL in April 2026)"
      MISSING_REQUIRED=1
      ;;
  esac
else
  fail "Node.js not found"
  MISSING_REQUIRED=1
fi

# pnpm
if command -v pnpm &>/dev/null; then
  ok "pnpm $(pnpm -v)"
else
  fail "pnpm not found — install with: npm install -g pnpm"
  MISSING_REQUIRED=1
fi

# Supported coding-agent CLIs
HAS_CLAUDE=0
HAS_CODEX=0
if command -v claude &>/dev/null; then
  ok "Claude Code CLI found"
  HAS_CLAUDE=1
else
  warn "Claude Code CLI not found — Claude sessions will be unavailable"
  echo "     Install with: npm install -g @anthropic-ai/claude-code"
fi

if command -v codex &>/dev/null; then
  ok "Codex CLI found"
  HAS_CODEX=1
else
  warn "Codex CLI not found — Codex sessions will be unavailable"
fi

if [ "$HAS_CLAUDE" -eq 0 ] && [ "$HAS_CODEX" -eq 0 ]; then
  fail "No supported coding-agent CLI found — install Claude Code or Codex before running AgentDeck."
  MISSING_REQUIRED=1
fi

# Stream Deck app
if [ -d "/Applications/Elgato Stream Deck.app" ] || [ -d "/Applications/Stream Deck.app" ]; then
  ok "Stream Deck app installed"
else
  fail "Stream Deck app not found — download from https://www.elgato.com/downloads"
  MISSING_REQUIRED=1
fi

if [ "$MISSING_REQUIRED" -ne 0 ]; then
  echo ""
  fail "Required dependencies missing. Please install them and re-run."
  exit 1
fi

echo ""

# --- Install @elgato/cli if missing ---
if ! command -v streamdeck &>/dev/null; then
  info "Installing Stream Deck CLI (@elgato/cli)..."
  npm install -g @elgato/cli
  ok "Stream Deck CLI installed"
else
  ok "Stream Deck CLI found"
fi

echo ""

# --- Build project ---
info "Installing dependencies..."
cd "$PROJECT_DIR"
pnpm install

info "Building project..."
pnpm build
ok "Build complete"

# Fix node-pty spawn-helper permissions (prebuild may lose +x)
SPAWN_HELPER="$PROJECT_DIR/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
if [ -f "$SPAWN_HELPER" ] && [ ! -x "$SPAWN_HELPER" ]; then
  chmod +x "$SPAWN_HELPER"
  ok "Fixed node-pty spawn-helper permissions"
fi

echo ""

# --- Generate icons if script exists ---
if [ -f "$PROJECT_DIR/scripts/generate-icons.mjs" ]; then
  info "Generating icon assets..."
  node "$PROJECT_DIR/scripts/generate-icons.mjs"
  ok "Icons generated"
fi

echo ""

# --- Install hooks ---
if [ "$HAS_CLAUDE" -eq 1 ]; then
  info "Installing Claude Code hooks..."
  node "$PROJECT_DIR/hooks/dist/install.js"
  ok "Claude Code hooks installed"
else
  warn "Skipping Claude Code hooks because claude is not installed"
fi

if [ "$HAS_CODEX" -eq 1 ]; then
  info "Installing Codex observation hooks..."
  node -e "import('$PROJECT_DIR/hooks/dist/install.js').then(m => { const r = m.installCodexHooksIfNeeded(); if (r.installed) console.log('Codex lifecycle hooks installed in ~/.codex/config.toml'); else console.log('Codex hooks skipped: ' + (r.reason || 'unknown reason')); })"
else
  warn "Skipping Codex hooks because codex is not installed"
fi

echo ""

# --- Link plugin ---
info "Deploying and verifying the Stream Deck plugin..."
cd "$PROJECT_DIR"
pnpm plugin:deploy
ok "Plugin runtime verified"

echo ""

# --- Link CLI ---
info "Linking agentdeck CLI globally..."
cd "$PROJECT_DIR/bridge"
# The link is reported by its OUTCOME, never announced. This used to swallow
# stderr, warn, and then print "agentdeck CLI linked" unconditionally — so on a
# pnpm that rejects the command the installer reported a link it had not made,
# and the next `agentdeck …` either failed or silently resolved to an unrelated
# global install. `pnpm link --global` is undocumented on pnpm 11 (`pnpm link
# --help` documents only `pnpm link <dir>`) and reported as an outright
# "unexpected argument" by at least one user's pnpm, so the failure is real and
# version-dependent.
if link_out=$(pnpm link --global 2>&1); then
  ok "agentdeck CLI linked"
else
  warn "pnpm link failed — the agentdeck CLI is NOT on your PATH:"
  printf '%s\n' "$link_out" | sed 's/^/    /'
  warn "Every command in this README still works as: node $PROJECT_DIR/bridge/dist/cli.js <args>"
  warn "For a normal install without linking a checkout, use: npx @agentdeck/setup"
fi

if node "$PROJECT_DIR/bridge/dist/cli.js" diag native >/dev/null; then
  ok "APME native database ready for $(node -v)"
else
  warn "APME native database is unavailable; run 'agentdeck diag native' for the exact runtime and recovery."
fi

echo ""

# --- Check optional dependencies ---
echo "----- Optional Dependencies -----"

if command -v sox &>/dev/null || command -v rec &>/dev/null; then
  ok "sox installed (voice recording)"
else
  warn "sox not found — voice input won't work"
  echo "     Install with: brew install sox"
fi

if command -v whisper-cli &>/dev/null || command -v whisper &>/dev/null; then
  ok "whisper.cpp installed (voice transcription)"
else
  warn "whisper.cpp not found — voice transcription won't work"
  echo "     Install with: brew install whisper-cpp"
  echo "     Then download model: whisper-cli --download-model large-v3-turbo"
fi

echo ""
echo "========================================="
echo "  Installation Complete!"
echo "========================================="
echo ""
echo "  Next steps:"
echo "  1. Restart Stream Deck app"
echo "  2. Add AgentDeck actions to your Stream Deck profile"
echo "  3. Run 'agentdeck daemon install', then start claude, codex, or opencode normally"
echo ""
echo "  Usage:"
echo "    agentdeck daemon install   Install hooks and start monitoring on login"
echo "    agentdeck dashboard        Open the terminal dashboard"
echo "    agentdeck status   Check status"
echo "    agentdeck stop     Stop bridge"
echo ""
