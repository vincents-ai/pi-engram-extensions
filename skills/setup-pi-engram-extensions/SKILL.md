---
name: setup-pi-engram-extensions
description: Full workspace bootstrap for the pi-engram-extensions package. Checks prerequisites (pi, node, engram CLI), verifies the package is installed and extensions are loading, then runs the model-failover setup to configure failover.json and model-routing.json. Use this when installing on a new machine, after a subscription change, or when handing off to a new agent or developer.
---

# Setup Pi Engram Extensions

Bootstraps the full `@vincents-ai/pi-engram-extensions` package. Covers:

- Prerequisite checks (pi, node, engram CLI)
- Package install verification
- Model failover configuration
- Engram workspace initialisation

Read [extensions-overview.md](references/extensions-overview.md) for a description of each extension.

---

## Step 0 — Install the package (if not already done)

```bash
# Project-local (shared with the team via .pi/settings.json):
pi install -l git:github.com/vincents-ai/pi-engram-extensions

# Or global:
pi install git:github.com/vincents-ai/pi-engram-extensions
```

Then restart pi or run `/reload`.

---

## Step 1 — Check prerequisites

Run the check script:

```bash
bash ./scripts/check-prerequisites.sh
```

This checks:
- `pi`, `node`, `engram` are in PATH
- `.pi/failover.json` and `.pi/model-routing.json` exist and are valid JSON
- Engram workspace is initialised (`.engram/` present)
- `~/.pi/agent/auth.json` OAuth providers and key env vars

**If there are failures (✗):** fix them before continuing. Warnings (⚠) are non-blocking.

Common fixes:

| Failure | Fix |
|---|---|
| `engram not found` | `/skill:install-engram` |
| `failover.json not found` | Continue to Step 3 — it will be created |
| `.engram/ not found` | `engram setup workspace` in the project root |
| `pi not found` | Install pi from https://github.com/mariozechner/pi-coding-agent |

**After running, store the result:**
```
engram_context_create
  title="Prerequisites check: <pass/fail count>"
  content="<paste summary line from script output>"
  relevance="medium"

engram_relationship_create  source_id=<context UUID>  source_type="context"
                            target_id=<task UUID>     target_type="task"
                            relationship_type="relates_to"  agent="<name>"
```

---

## Step 2 — Bootstrap the engram workspace (if not done)

If `.engram/` was missing, initialise it now:

```bash
engram setup workspace
engram setup agent --name "Claude" --agent-type implementation
engram skills setup
engram validate hook install
```

See `/skill:install-engram` for the full bootstrap reference.

---

## Step 3 — Configure model failover

Load the `setup-model-failover` skill and follow its full protocol:

```
/skill:setup-model-failover
```

That skill will:
1. Detect which AI providers are configured (OAuth tokens + API key env vars)
2. Ask you to confirm which subscriptions are active
3. Write `.pi/failover.json` and `.pi/model-routing.json`

**Do not skip this step** — the `engram-agents` and `engram-orchestrator` extensions use these configs to pick the right model for every dispatched subagent.

---

## Step 4 — Verify extensions are loading

Run `/reload` in pi (or restart), then test each extension:

| Check | Command | Expected |
|---|---|---|
| engram-tools | `engram_ask query="test"` | Returns results or "no results" |
| engram-agents | `/agent-list` | Lists 171 agent personas |
| model-failover | `/failover-status` | Shows current model + priority list |
| engram-orchestrator | `/orchestrate help` | Shows orchestration usage |

---

## Step 5 — Summary and handoff

Report to the user:
- Which extensions loaded successfully
- Current active model and failover model count
- Engram workspace status (`engram next`, `engram validate check`)
- Any remaining warnings or next steps

If handing off to a new agent or developer, also include:
- Skill to re-run if subscriptions change: `/skill:setup-model-failover`
- Skill to re-run for full setup on a new machine: `/skill:setup-pi-engram-extensions`
- Where configs live: `.pi/failover.json`, `.pi/model-routing.json`
- Prior decisions in engram: `engram ask query "model routing failover extensions"`
