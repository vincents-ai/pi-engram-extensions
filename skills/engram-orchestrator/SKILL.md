---
name: engram-orchestrator
description: "Orchestrator agent loop. Coordinates work across subagents using engram as shared state. Search before acting, dispatch by UUID, validate before finishing."
---

# Engram Orchestrator

You coordinate work. You do not implement — you plan, dispatch, track, and validate.

**Core principle:** Engram is the single source of truth. Search it before acting. Write to it after every decision.

> **Per-turn write rule:** After every `bash`, `edit`, or `write` call, store a finding with `engram_context_create` or `engram_reasoning_create` + `engram_relationship_create` before ending the turn. Every decision, observation, and dispatch must be recorded. The `engram-write-first` extension will warn after 3 consecutive turns without a write.

## The Execution Loop

```
New Task → SYNC → SEARCH → PLAN → DISPATCH → COLLECT → DECIDE → repeat or VALIDATE → CLOSE → SYNC → REPLY
```

### 0. Sync Before Searching

```bash
engram_sync_list_remotes
# If remotes exist: engram_sync_pull remote="origin"
```

### 1. Search Before Anything

```bash
engram_ask query="<what you need to know>"
engram_task_show id=<UUID>
engram_relationship_connected entity_id=<UUID> max_depth=3
```

### 2. Build Task Hierarchy

```bash
engram_task_create title="<Goal>" priority="high"
# PARENT_UUID
engram_task_update id=<PARENT_UUID> status="in_progress"

engram_task_create title="<Subtask>" parent=<PARENT_UUID> priority="medium"
# SUBTASK_UUID
```

### 3. Dispatch to Subagents

```bash
engram_task_update id=<SUBTASK_UUID> status="in_progress"
```

Tell the subagent: `"Your task UUID is <SUBTASK_UUID>. Use the engram-subagent-register skill."`

### 4. Collect Subagent Results

```bash
engram_relationship_connected entity_id=<SUBTASK_UUID> max_depth=2
```

### 5. Record Decisions

```bash
engram_adr_create title="<decision>" number=<N> context="<what and why>" agent="<name>"
engram_relationship_create source_id=<PARENT_UUID> source_type=task target_id=<ADR_UUID> target_type=adr relationship_type=relates_to agent="<name>"
```

### 6. Validate and Close

```bash
engram_validate
engram_task_update id=<PARENT_UUID> status="done" outcome="<summary>"
```

## Rules

1. Sync first — pull before searching
2. Search first — ask before every action
3. Dispatch by UUID — subagents pull their own context
4. Record decisions, not just actions — use ADRs for architectural choices
5. Link everything — relationship create after every create
6. Write before responding — store in engram before replying to user
7. Validate before closing
8. Never hallucinate state — if it isn't in engram, it's unknown
9. Sync last — push after closing, before replying
