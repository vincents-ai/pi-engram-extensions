---
name: engram-tdd
description: "Test-driven development with engram validation checkpoints. Write test first, watch it fail, write minimal code, store evidence at each phase."
---

# Engram TDD

> **Per-turn write rule:** After every `bash` (test run), `edit`, or `write` (code change), store evidence with `engram_context_create` or `engram_reasoning_create` + `engram_relationship_create` before ending the turn. Each phase below has an explicit write step — do not skip them.

## Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

## Protocol

### 0. Search First

```bash
engram_ask query="<feature or function name> test"
```

### 1. Anchor Work

```bash
engram_task_create title="TDD: <feature description>" priority="high"
# TASK_UUID
engram_task_update id=<TASK_UUID> status="in_progress"
```

### Phase 1: RED — Write the Failing Test

Write one minimal test. Store evidence:

```bash
engram_context_create title="RED: <test_name>" content="Test: <test_name>\nLocation: <path>\nExpected: <behaviour>" source="<test-file>"
engram_relationship_create source_id=<TASK_UUID> source_type=task target_id=<CTX_UUID> target_type=context relationship_type=relates_to agent="<name>"
```

### Phase 2: Verify RED — Watch It Fail

Run the test. Store output:

```bash
engram_reasoning_create title="RED verification: <test_name>" task_id=<TASK_UUID> content="Command: <cmd>\nOutput: <failure output>\nStatus: READY FOR GREEN"
engram_relationship_create source_id=<TASK_UUID> source_type=task target_id=<RSN_UUID> target_type=reasoning relationship_type=explains agent="<name>"
engram_validate
```

### Phase 3: GREEN — Minimal Code

Write simplest code that passes. Store implementation:

```bash
engram_context_create title="GREEN: <test_name>" content="Implementation: <code>\nFiles: <list>" source="<file>"
engram_reasoning_create title="GREEN verification: <test_name>" task_id=<TASK_UUID> content="Tests: <N>/<N> pass\nStatus: READY FOR REFACTOR"
engram_validate
```

### Phase 4: REFACTOR — Clean Up

Only after green. No new behaviour. Store changes:

```bash
engram_reasoning_create title="REFACTOR: <test_name>" task_id=<TASK_UUID> content="Changes: ...\nTests still pass: YES\nNew behaviour: NO"
engram_validate
```

### Phase 5: Close

```bash
engram_task_update id=<TASK_UUID> status="done"
engram_next
```

## Rules

- Test passes before writing code? Fix the test.
- Test errors? Fix the error, re-run until it fails correctly.
- Other tests fail? Fix before proceeding.
- YAGNI — no extra features in green phase.
