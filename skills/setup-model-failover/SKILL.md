---
name: setup-model-failover
description: Configure or reconfigure .pi/failover.json and .pi/model-routing.json for the model-failover extension. Checks which AI providers are currently configured in pi (OAuth tokens and API key env vars), cross-references the existing failover list, asks the user to confirm which subscriptions are still active, then updates the configs to reflect available models with correct priority ordering. Use this when setting up a new machine, after a subscription change, or to audit the current failover configuration.
---

# Setup Model Failover

Configures `.pi/failover.json` (priority-ordered model list for the model-failover extension) and `.pi/model-routing.json` (task-tier → model-tier routing rules).

> **Per-turn write rule:** This skill runs scripts and edits config files. After each script run and after each config file write, store a finding with `engram_context_create` + `engram_relationship_create`. Minimally: one context after the provider check (Step 1) and one reasoning after writing the configs (Steps 4–5).

## Step 1 — Detect configured providers

Run the check script from the skill directory:

```bash
bash ./scripts/check-providers.sh
```

The script reports:
- Which OAuth providers are stored in `~/.pi/agent/auth.json`
- Which API key env vars are set
- Each provider in the current `failover.json` and whether it is actually configured

Read the [provider types reference](references/provider-types.md) to understand what each entry means (subscription, pay-per-use, free tier, OAuth, API key).

**After running the script, store the output as context:**
```
engram_context_create
  title="Provider check output: <date>"
  content="<paste key findings from check-providers.sh output>"
  relevance="high"
  source="./scripts/check-providers.sh"

engram_relationship_create  source_id=<context UUID>  source_type="context"
                            target_id=<task UUID>     target_type="task"
                            relationship_type="relates_to"  agent="<name>"
```

## Step 2 — Ask the user to confirm subscription status

Based on the script output, present a summary to the user. For **each provider currently listed in `failover.json`**, state:
- Whether it appears configured (✓ or ✗)
- Its auth type (OAuth subscription / API key subscription / free tier)

Then ask the user **explicitly**:

> "The check found:
> - ✓ [configured providers with type]
> - ✗ [missing providers — listed in failover.json but no key found]
>
> Questions:
> 1. Are all the ✓ subscriptions still active?
> 2. The ✗ providers are kept in the list as dormant placeholders — they are skipped at runtime
>    automatically. Should any be **removed** (e.g. a subscription you've cancelled), or do you
>    want to **activate** any by adding their API key now?
> 3. Do you have any new subscriptions or API keys not yet in the list?
> 4. For GitHub Copilot — which plan are you on? (Free / Pro $10 / Pro+ $39 / Business / Enterprise)
>    This affects which models are free vs premium and the monthly request allowance."

**Do not proceed to Step 3 until the user has answered.**

> **Note (ADR-026):** Unconfigured providers (✗) are kept in `failover.json` as dormant placeholders by default. The extensions skip them at runtime via `ctx.modelRegistry.hasConfiguredAuth()`. Only remove them if the user explicitly asks (e.g. a cancelled subscription). Never remove them just because a key is missing.

## Step 3 — Determine the correct model list

Once the user confirms their subscriptions, build the new model list following these rules:

### Ordering principles
1. **Pre-paid subscription models first** (z.ai, GitHub Copilot) — already paid for, prioritise usage
2. **GitHub Copilot 0× free models next** — unlimited within any paid Copilot plan; use before burning premium requests
3. **GitHub Copilot cheap models** (0.25–0.33× multiplier) — good value
4. **GitHub Copilot standard models** (1× multiplier) — use for quality-critical tasks
5. **GitHub Copilot expensive models** (3×) — reserve for critical tier only
6. **Free external models last** (Groq, Google free tier) — rate-limited fallbacks

### GitHub Copilot model tiers (Pro+ plan — adapt for other plans)
See [provider-types.md](references/provider-types.md) for the full multiplier table.

**Free (0×):** `gpt-4.1`, `gpt-4o`, `gpt-5-mini`
**Cheap (0.25–0.33×):** `grok-code-fast-1`, `claude-haiku-4.5`, `gemini-3-flash-preview`, `gpt-5.4-mini`
**Standard (1×):** `claude-sonnet-4.6`, `gpt-5.4`, `gemini-2.5-pro`, `gpt-5.2-codex`
**Expensive (3×):** `claude-opus-4.6`, `claude-opus-4.5`

> Note: On Copilot **Free** plan, all models cost 1 premium request each and the allowance is only 50/month — do not include premium models in the failover list for Free users.
> On Copilot **Pro** ($10/month, 300 req/month) — include cheap models but avoid 3× models.

### z.ai model lineup (subscription)
`glm-5.1` (flagship) → `glm-5` → `glm-5-turbo` (fast) → `glm-4.7` → `glm-4.7-flash`

### Free external models
- `groq`: `llama-3.3-70b-versatile`, `meta-llama/llama-4-maverick-17b-128e-instruct` — requires `GROQ_API_KEY`
- `google`: `gemini-2.5-flash` — requires `GEMINI_API_KEY` (free tier quota)
- Only include these if the user has the relevant API key configured

## Step 4 — Update failover.json

Write the updated `.pi/failover.json` based on the confirmed model list. Use priority numbers starting at 1 (lowest number = most preferred). Include a `_group` comment on the first entry of each group and a `label` on every entry.

**After writing the file, store reasoning:**
```
engram_reasoning_create
  title="failover.json updated: <date>"
  task_id=<task UUID>
  content="Providers included: <list>\nProviders excluded: <list>\nReason: <user confirmed subscriptions>"

engram_relationship_create  source_id=<reasoning UUID>  source_type="reasoning"
                            target_id=<task UUID>        target_type="task"
                            relationship_type="explains"  agent="<name>"
```

Standard structure:
```json
{
  "_comment": "...",
  "models": [
    { "_group": "z.ai subscription", "provider": "zai", "model": "glm-5.1", "priority": 1, "label": "z.ai GLM-5.1", "cooldownMinutes": 15 },
    ...
  ],
  "defaultCooldownMinutes": 30,
  "autoRequeue": true,
  "autoReturnToPreferred": true,
  "maxRequeueAttempts": 3
}
```

## Step 5 — Update model-routing.json

Update `.pi/model-routing.json` so the `tier_priorities` reference the new priority numbers from failover.json.

Standard tier strategy:
- **critical**: prefer z.ai flagship + Copilot Claude Sonnet; include Opus as last prefer entry
- **standard**: prefer z.ai + Copilot free (0×) models; fallback through cheap models
- **lightweight**: prefer Copilot free (0×) + free external first; never route to 1× or 3× models

After writing both files, verify:
```bash
python3 -c "
import json
f = json.load(open('.pi/failover.json'))
r = json.load(open('.pi/model-routing.json'))
valid = {m['priority'] for m in f['models'] if 'priority' in m}
for tier, cfg in r['tier_priorities'].items():
    refs = set(cfg['prefer'] + cfg['fallback'])
    missing = refs - valid
    print(f'{tier}: {\"OK\" if not missing else \"MISSING \" + str(missing)}')
print('All priorities valid' if all(
    not (set(c[\"prefer\"]+c[\"fallback\"]) - valid)
    for c in r['tier_priorities'].values()
) else 'ERRORS FOUND')
"
```

## Step 6 — Summary

Report to the user:
- How many models are now in the failover list and from which providers
- Which providers were removed (if any) because they were unconfigured
- The priority range for each tier in model-routing.json
- Any providers they mentioned wanting to add that still need an API key set up
