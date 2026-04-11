# Extensions Overview

A reference for each pi extension in this workspace.

## Extensions at a glance

| Extension | File(s) | Purpose |
|---|---|---|
| `model-failover` | `model-failover/index.ts` | Auto-switches models on rate limits; re-queues failed messages |
| `engram-agents` | `engram-agents/index.ts` | 171 specialist agent personas; dispatch as child pi processes |
| `engram-orchestrator` | `engram-orchestrator/index.ts` | Task orchestration; parallel dispatch; autonomous auto mode |
| `engram-tools` | `engram-tools/index.ts` | LLM-facing tools wrapping the engram CLI |
| `engram-workflow` | `engram-workflow/index.ts` | Engram workflow state machine tools |
| `engram-session` | `engram-session.ts` | Session lifecycle helpers |
| `engram-status` | `engram-status.ts` | Footer status bar for engram state |
| `engram-write-first` | `engram-write-first.ts` | Enforces write-to-engram-before-coding discipline |
| `engram-commit-gate` | `engram-commit-gate.ts` | Blocks commits without a valid engram task UUID |

## Extension interaction diagram

```
User / LLM
    │
    ├── engram-tools          ← engram_task_create, engram_context_create, etc.
    │
    ├── engram-agents         ← engram_agent_list / dispatch → child pi (persona injected)
    │       └─ model-routing  ← picks best available model per task type
    │
    ├── engram-orchestrator   ← /orchestrate, /engram-auto → child pi (subagent protocol)
    │       └─ model-routing  ← picks best available model per task type
    │
    └── model-failover        ← watches for rate-limit errors → switches model → re-queues
```

## Shared config files

| File | Purpose |
|---|---|
| `.pi/failover.json` | Priority-ordered model list with provider, model id, cooldowns |
| `.pi/model-routing.json` | Maps task tier (critical/standard/lightweight) to priority ranges |

Both `engram-agents` and `engram-orchestrator` read these files at dispatch time to pick the best available model for each spawned subagent.

## How subagent model selection works

1. Task title + agent persona title are matched against `model-routing.json` tier rules (keyword matching)
2. Matched tier (critical / standard / lightweight) → priority order from `tier_priorities`
3. For each priority in order: check `modelRegistry.hasConfiguredAuth()` — pick the first one that passes
4. Selected model is passed to the child `pi` process as `--model provider/model`
5. If no model is found (all unconfigured), no `--model` flag is passed — child uses its own default

## Adding a new extension

1. Create `<name>/index.ts` (or `<name>.ts` for single-file)
2. If using npm packages, add `package.json` and run `npm install` in the directory
3. Extension is auto-loaded by pi on next startup (or `/reload`)
4. Document it in this file

## Updating the model list

Run `/skill:setup-model-failover` to walk through the subscription check and config update interactively.
