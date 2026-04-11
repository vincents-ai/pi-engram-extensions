#!/usr/bin/env bash
# check-install.sh — verify engram is installed and in PATH
set -euo pipefail

ok()   { printf "\033[1;32m[ok]\033[0m    %s\n" "$*"; }
fail() { printf "\033[1;31m[fail]\033[0m  %s\n" "$*"; }
info() { printf "\033[1;34m[info]\033[0m  %s\n" "$*"; }

found=0

# 1. Check PATH
if command -v engram >/dev/null 2>&1; then
  version="$(engram --version 2>/dev/null || echo "unknown")"
  location="$(command -v engram)"
  ok "engram found in PATH: ${location} (${version})"
  found=1
else
  fail "engram not found in PATH"
fi

# 2. Check common install locations
for loc in \
  /usr/local/bin/engram \
  "$HOME/.local/bin/engram" \
  "$HOME/.cargo/bin/engram" \
  "$HOME/.nix-profile/bin/engram" \
  /nix/var/nix/profiles/default/bin/engram
do
  if [ -f "$loc" ]; then
    info "Found binary at: ${loc}"
    if [ "$found" -eq 0 ]; then
      fail "Binary exists at ${loc} but is not in PATH"
      info "Fix: export PATH=\"$(dirname "$loc"):\$PATH\""
    fi
  fi
done

# 3. Check workspace
if [ -d ".engram" ]; then
  ok "Engram workspace initialised (.engram/ present)"
else
  info "No .engram/ found in current directory — run: engram setup workspace"
fi

# 4. Check git repo (required for engram)
if git rev-parse --git-dir >/dev/null 2>&1; then
  ok "Git repository detected"
else
  fail "Not a git repository — engram requires git: run 'git init' first"
fi

# 5. Check commit hook
hook=".git/hooks/commit-msg"
if [ -f "$hook" ] && grep -q "engram" "$hook" 2>/dev/null; then
  ok "Engram commit-msg hook installed"
else
  info "No engram commit-msg hook — run: engram validate hook install"
fi

if [ "$found" -eq 1 ]; then
  printf "\n"
  ok "engram is ready to use. Run 'engram --help' to get started."
  exit 0
else
  printf "\n"
  fail "engram is not available. Install it with:"
  printf "  curl -fsSL https://github.com/vincents-ai/engram/releases/latest/download/install.sh | bash\n"
  exit 1
fi
