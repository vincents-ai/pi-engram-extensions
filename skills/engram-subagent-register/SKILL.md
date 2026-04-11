---
name: engram-subagent-register
description: "Subagent registration protocol. Use when assigned a task UUID by an orchestrator — claim the task, pull context from engram, store all findings, and report results back."
---

# Subagent Registration

You are a subagent. You received a task UUID. Your input comes from engram. Your output goes to engram.

> **Per-turn write rule:** After every `bash`, `read`, `edit`, or `write` call, store the finding immediately with `engram_context_create` or `engram_reasoning_create` + `engram_relationship_create`. Do not batch. Do not wait until the end. Every turn with substantive work must have an engram write.

## The Pattern

### 1. Claim the Task

```bash
engram_task_show id=<TASK_UUID>
engram_task_update id=<TASK_UUID> status="in_progress"
```

### 2. Pull All Context

```bash
engram_relationship_connected entity_id=<TASK_UUID> max_depth=2
engram_ask query="<keywords from task title>"
```

Never start work based only on the title. Always check linked context.

### 3. Store Every Finding Immediately — No Batching

For each finding as you discover it:

```bash
engram_context_create title="<finding title>" content="<what you found>" source="<file/command>"
engram_relationship_create source_id=<TASK_UUID> source_type=task target_id=<CTX_UUID> target_type=context relationship_type=relates_to agent="<name>"
```

For reasoning:

```bash
engram_reasoning_create title="<reasoning title>" task_id=<TASK_UUID> content="<interpretation>"
engram_relationship_create source_id=<TASK_UUID> source_type=task target_id=<RSN_UUID> target_type=reasoning relationship_type=explains agent="<name>"
```

### 4. Write Completion Report

```bash
engram_reasoning_create title="Completion report: <task title>" task_id=<TASK_UUID> content="## Result\n<outcome>\n\n## What I did\n- ...\n\n## Findings\n- ...\n\n## Status\nCOMPLETED|BLOCKED"
engram_relationship_create source_id=<TASK_UUID> source_type=task target_id=<REPORT_UUID> target_type=reasoning relationship_type=explains agent="<name>"
```

### 5. Mark Done

```bash
engram_task_update id=<TASK_UUID> status="done" outcome="<one-line summary>"
```

## Handling Blockers

```bash
engram_task_update id=<TASK_UUID> status="blocked" reason="<why blocked, what next agent needs>"
```

## Rules

1. Claim first — mark in_progress before any work
2. Pull context before acting
3. Write each finding immediately — do NOT batch
4. Link every record
5. Report via engram — not conversation
