---
name: engram-plan-feature
description: "Plan feature implementation by creating an engram task hierarchy. Not a markdown plan — a queryable task tree any agent can retrieve."
---

# Planning Feature Implementation

Create structured plans as engram task hierarchies — not markdown files. Any agent retrieves them via `engram_task_show <UUID>`.

> **Per-turn write rule:** Every bash, edit, or write call must be followed by `engram_context_create` or `engram_reasoning_create` + `engram_relationship_create` in the same turn. The planning work below produces context entities at each step — store them immediately, not at the end.

## Protocol

### 0. Search First

```bash
engram_ask query="<feature name> plan"
```

### 1. Create Parent Task

```bash
engram_task_create title="<Feature Name>" priority="high"
# PARENT_UUID
engram_task_update id=<PARENT_UUID> status="in_progress"
```

### 2. Create Subtasks (one per unit of delegable work)

For each stage or component:

```bash
engram_task_create title="<Feature> Stage N: <Stage Name>" parent=<PARENT_UUID> priority="medium"
# STAGE_UUID
engram_relationship_create source_id=<PARENT_UUID> source_type=task target_id=<STAGE_UUID> target_type=task relationship_type=depends_on agent="<name>"
```

Store detailed stage instructions as linked context:

```bash
engram_context_create title="Stage N detail: <name>" content="<detailed instructions>" source="<reference>"
engram_relationship_create source_id=<STAGE_UUID> source_type=task target_id=<DETAIL_UUID> target_type=context relationship_type=relates_to agent="<name>"
```

### 3. Verify Hierarchy

```bash
engram_relationship_connected entity_id=<PARENT_UUID> max_depth=2
```

### 4. Validate

```bash
engram_validate
engram_next
```

## Rules

- Plans live in engram, not in markdown files
- Each subtask should be independently delegable to a single agent
- Link detailed instructions as context entities
- Subagents retrieve stage details via `engram_task_show` + `engram_relationship_connected`
