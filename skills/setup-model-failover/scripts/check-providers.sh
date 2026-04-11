#!/usr/bin/env bash
# check-providers.sh
#
# Detects which AI providers are currently configured in pi.
# Reports: provider name, auth method, whether it is present, and classification
# (subscription / api-key / oauth / free-tier).
#
# Output is plain text designed to be read by the agent.

set -euo pipefail

AUTH_FILE="${HOME}/.pi/agent/auth.json"
FAILOVER_FILE=""

# Allow overriding failover.json location via first argument
if [[ -n "${1:-}" ]]; then
  FAILOVER_FILE="$1"
elif [[ -f ".pi/failover.json" ]]; then
  FAILOVER_FILE=".pi/failover.json"
elif [[ -f "${HOME}/.pi/agent/failover.json" ]]; then
  FAILOVER_FILE="${HOME}/.pi/agent/failover.json"
fi

echo "=========================================="
echo "  Pi Provider Configuration Report"
echo "=========================================="
echo ""

# ── OAuth / token-based providers (stored in auth.json) ──────────────────────
echo "── OAuth / Token providers (auth.json) ──"
if [[ -f "$AUTH_FILE" ]]; then
  # Extract top-level keys (providers) from auth.json using python
  OAUTH_PROVIDERS=$(python3 -c "
import json, sys
try:
    d = json.load(open('$AUTH_FILE'))
    for k, v in d.items():
        if isinstance(v, dict) and ('access' in v or 'refresh' in v or 'token' in v or 'type' in v):
            has_access = bool(v.get('access') or v.get('token'))
            exp = v.get('expires', '')
            print(f'{k}  access={has_access}  expires={exp}')
        else:
            print(f'{k}  (present)')
except Exception as e:
    print(f'error reading auth.json: {e}')
" 2>/dev/null)
  if [[ -n "$OAUTH_PROVIDERS" ]]; then
    echo "$OAUTH_PROVIDERS"
    echo ""
    echo "  Classification:"
    echo "    github-copilot → OAuth subscription (Pro / Pro+ / Business / Enterprise)"
    echo "    google-gemini-cli → OAuth (Google account free tier)"
  else
    echo "  No OAuth providers found in auth.json"
  fi
else
  echo "  auth.json not found at $AUTH_FILE"
fi
echo ""

# ── Environment variable providers ────────────────────────────────────────────
echo "── Environment variable providers ──"

check_env() {
  local provider="$1"
  local envvar="$2"
  local classification="$3"
  local value="${!envvar:-}"
  if [[ -n "$value" ]]; then
    echo "  ✓ ${provider}  (${envvar})  → ${classification}"
  else
    echo "  ✗ ${provider}  (${envvar} not set)"
  fi
}

check_env "zai"                  "ZAI_API_KEY"              "pre-paid subscription (z.ai)"
check_env "openai"               "OPENAI_API_KEY"           "api-key pay-per-use"
check_env "anthropic"            "ANTHROPIC_API_KEY"        "api-key pay-per-use"
check_env "google"               "GEMINI_API_KEY"           "api-key (free tier available)"
check_env "groq"                 "GROQ_API_KEY"             "api-key (free tier available)"
check_env "mistral"              "MISTRAL_API_KEY"          "api-key pay-per-use"
check_env "xai"                  "XAI_API_KEY"              "api-key pay-per-use"
check_env "openrouter"           "OPENROUTER_API_KEY"       "api-key (many free models)"
check_env "huggingface"          "HF_TOKEN"                 "api-key (free tier available)"
check_env "cerebras"             "CEREBRAS_API_KEY"         "api-key pay-per-use"
check_env "minimax"              "MINIMAX_API_KEY"          "api-key pay-per-use"
check_env "kimi-coding"          "KIMI_API_KEY"             "api-key pay-per-use"
check_env "vercel-ai-gateway"    "AI_GATEWAY_API_KEY"       "api-key gateway"
check_env "opencode"             "OPENCODE_API_KEY"         "api-key (opencode)"

# Anthropic OAuth variant
if [[ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]]; then
  echo "  ✓ anthropic  (ANTHROPIC_OAUTH_TOKEN)  → OAuth subscription (Claude Pro/Max)"
fi

# GitHub token env fallbacks
if [[ -z "${1:-}" ]] && [[ -n "${GH_TOKEN:-}" || -n "${GITHUB_TOKEN:-}" || -n "${COPILOT_GITHUB_TOKEN:-}" ]]; then
  echo "  ✓ github-copilot  (env token)  → OAuth subscription (via env var)"
fi

echo ""

# ── Cross-reference with failover.json ────────────────────────────────────────
if [[ -n "$FAILOVER_FILE" && -f "$FAILOVER_FILE" ]]; then
  echo "── Failover config cross-reference ($FAILOVER_FILE) ──"
  python3 - "$FAILOVER_FILE" "$AUTH_FILE" <<'PYEOF'
import json, sys, os

failover_file = sys.argv[1]
auth_file = sys.argv[2] if len(sys.argv) > 2 else ""

with open(failover_file) as f:
    cfg = json.load(f)

models = [m for m in cfg.get("models", []) if "provider" in m]
providers_in_failover = {}
for m in models:
    p = m["provider"]
    if p not in providers_in_failover:
        providers_in_failover[p] = []
    providers_in_failover[p].append(m["model"])

# Check auth.json for OAuth providers
oauth_providers = set()
if auth_file and os.path.exists(auth_file):
    try:
        with open(auth_file) as f:
            auth = json.load(f)
        oauth_providers = set(auth.keys())
    except Exception:
        pass

# Env var map
env_map = {
    "zai": "ZAI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "xai": "XAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "huggingface": "HF_TOKEN",
    "cerebras": "CEREBRAS_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
}

print(f"\n  {len(models)} models across {len(providers_in_failover)} providers listed in failover.json:\n")

for provider, model_list in sorted(providers_in_failover.items()):
    # Determine if configured
    configured = False
    auth_method = "unknown"
    if provider in oauth_providers:
        configured = True
        auth_method = "OAuth (auth.json)"
    elif provider in env_map:
        env_key = env_map[provider]
        if os.environ.get(env_key):
            configured = True
            auth_method = f"API key ({env_key})"
        else:
            auth_method = f"API key ({env_key} — NOT SET)"
    elif provider == "github-copilot":
        gh_set = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or os.environ.get("COPILOT_GITHUB_TOKEN")
        if gh_set or "github-copilot" in oauth_providers:
            configured = True
            auth_method = "OAuth (auth.json or env)"
        else:
            auth_method = "OAuth (NOT configured)"

    status = "✓" if configured else "✗"
    print(f"  {status} {provider:22} — {auth_method}")
    for model in model_list[:3]:
        print(f"      └ {model}")
    if len(model_list) > 3:
        print(f"      └ ... and {len(model_list)-3} more")
    print()

# Summary
unconfigured = []
for provider in providers_in_failover:
    configured = False
    if provider in oauth_providers:
        configured = True
    elif provider in env_map and os.environ.get(env_map[provider]):
        configured = True
    elif provider == "github-copilot" and (
        os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or
        os.environ.get("COPILOT_GITHUB_TOKEN") or "github-copilot" in oauth_providers
    ):
        configured = True
    if not configured:
        unconfigured.append(provider)

if unconfigured:
    print(f"  ⚠ NOT configured (models will be skipped): {', '.join(unconfigured)}")
else:
    print("  ✓ All providers in failover.json are configured.")

# Bonus: providers that ARE configured but NOT in failover.json
all_env_map = {
    "zai": "ZAI_API_KEY", "openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY",
    "google": "GEMINI_API_KEY", "groq": "GROQ_API_KEY", "mistral": "MISTRAL_API_KEY",
    "xai": "XAI_API_KEY", "openrouter": "OPENROUTER_API_KEY", "huggingface": "HF_TOKEN",
    "cerebras": "CEREBRAS_API_KEY", "minimax": "MINIMAX_API_KEY", "kimi-coding": "KIMI_API_KEY",
}
configured_but_unused = []
for provider, envvar in all_env_map.items():
    if provider not in providers_in_failover and os.environ.get(envvar):
        configured_but_unused.append(f"{provider}  ({envvar})")
for p in oauth_providers:
    if p not in providers_in_failover:
        configured_but_unused.append(f"{p}  (OAuth)")
if configured_but_unused:
    print(f"\n  💡 Configured but NOT in failover.json (consider adding):")
    for p in configured_but_unused:
        print(f"     {p}")
PYEOF
else
  echo "── No failover.json found — skipping cross-reference ──"
fi

echo ""
echo "=========================================="
echo "  End of report"
echo "=========================================="
