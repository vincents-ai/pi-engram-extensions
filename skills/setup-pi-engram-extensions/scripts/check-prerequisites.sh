#!/usr/bin/env bash
# check-prerequisites.sh
#
# Verifies all prerequisites for the pi-engram-extensions package.
# Exits 0 if everything passes, 1 if anything critical is missing.

set -euo pipefail

PASS=0
WARN=0
FAIL=0

ok()   { echo "  ✓ $*"; ((PASS++)) || true; }
warn() { echo "  ⚠ $*"; ((WARN++)) || true; }
fail() { echo "  ✗ $*"; ((FAIL++)) || true; }

echo "=========================================="
echo "  Pi Engram Extensions — Prerequisites"
echo "=========================================="
echo ""

# ── Core tools ────────────────────────────────────────────────────────────────
echo "── Core tools ──"

if command -v pi &>/dev/null; then
  ok "pi  ($(pi --version 2>/dev/null | head -1 || echo 'version unknown'))"
else
  fail "pi not found in PATH — install from https://github.com/mariozechner/pi-coding-agent"
fi

if command -v node &>/dev/null; then
  ok "node  ($(node --version))"
else
  fail "node not found — required to run pi extensions"
fi

if command -v engram &>/dev/null; then
  ok "engram  ($(engram --version 2>/dev/null | head -1 || echo 'version unknown'))"
else
  fail "engram CLI not found in PATH — run: /skill:install-engram"
fi

if command -v python3 &>/dev/null; then
  ok "python3  ($(python3 --version 2>&1))"
else
  warn "python3 not found — used by setup scripts, not required at runtime"
fi

echo ""

# ── Package install ───────────────────────────────────────────────────────────
echo "── Package install ──"

# Check global settings
GLOBAL_SETTINGS="${HOME}/.pi/agent/settings.json"
PROJECT_SETTINGS=".pi/settings.json"
PACKAGE_FOUND=0

for settings_file in "$PROJECT_SETTINGS" "$GLOBAL_SETTINGS"; do
  if [[ -f "$settings_file" ]]; then
    if python3 -c "
import json, sys
try:
    d = json.load(open('$settings_file'))
    pkgs = d.get('packages', [])
    found = any('pi-engram-extensions' in (p if isinstance(p, str) else p.get('source', '')) for p in pkgs)
    sys.exit(0 if found else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
      ok "pi-engram-extensions found in $settings_file"
      PACKAGE_FOUND=1
      break
    fi
  fi
done

if [[ "$PACKAGE_FOUND" -eq 0 ]]; then
  warn "pi-engram-extensions not found in pi settings — install with:"
  warn "  pi install -l git:github.com/vincents-ai/pi-engram-extensions"
fi

echo ""

# ── Config files ──────────────────────────────────────────────────────────────
echo "── Config files (.pi/) ──"

for cfg in ".pi/failover.json" ".pi/model-routing.json"; do
  if [[ -f "$cfg" ]]; then
    if python3 -c "import json; json.load(open('$cfg'))" 2>/dev/null; then
      ok "$cfg  (valid JSON)"
    else
      fail "$cfg  (INVALID JSON — needs fixing)"
    fi
  else
    warn "$cfg  not found — run /skill:setup-model-failover to create it"
  fi
done

echo ""

# ── Engram workspace ──────────────────────────────────────────────────────────
echo "── Engram workspace ──"

if git rev-parse --git-dir &>/dev/null 2>&1; then
  ok "git repository detected"
else
  fail "not a git repository — engram requires git: run 'git init' first"
fi

if [[ -d ".engram" ]]; then
  ok ".engram/  workspace initialised"
  if engram validate check &>/dev/null 2>&1; then
    ok "engram validate check passed"
  else
    warn "engram validate check had warnings — run 'engram validate check' for details"
  fi
else
  warn ".engram/ not found — run 'engram setup workspace' to initialise"
fi

echo ""

# ── Provider auth (quick check) ───────────────────────────────────────────────
echo "── Provider auth (quick check) ──"

AUTH_FILE="${HOME}/.pi/agent/auth.json"
if [[ -f "$AUTH_FILE" ]]; then
  PROVIDERS=$(python3 -c "import json; d=json.load(open('$AUTH_FILE')); print(', '.join(d.keys()))" 2>/dev/null || echo "unreadable")
  ok "auth.json — OAuth providers: ${PROVIDERS}"
else
  warn "No auth.json — no OAuth providers configured (github-copilot, etc.) — run /login in pi"
fi

[[ -n "${ZAI_API_KEY:-}" ]]    && ok  "ZAI_API_KEY set (z.ai)"    || warn "ZAI_API_KEY not set"
[[ -n "${GROQ_API_KEY:-}" ]]   && ok  "GROQ_API_KEY set (groq)"   || warn "GROQ_API_KEY not set (optional)"
[[ -n "${GEMINI_API_KEY:-}" ]] && ok  "GEMINI_API_KEY set (google)" || warn "GEMINI_API_KEY not set (optional)"

echo ""
echo "=========================================="
echo "  Summary: ${PASS} OK   ${WARN} warnings   ${FAIL} failures"
echo "=========================================="

[[ "$FAIL" -eq 0 ]]
