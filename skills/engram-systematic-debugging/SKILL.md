---
name: engram-systematic-debugging
description: "Systematic debugging with engram evidence trails. Store investigation as reasoning chains — queryable and reviewable by future agents."
---

# Systematic Debugging

> **Per-turn write rule:** After every `bash` (command run), `read` (file examined), `edit`, or `write` call, store what you found with `engram_context_create` or `engram_reasoning_create` + `engram_relationship_create` before ending the turn. Each phase below has an explicit write step — do not skip them.

## Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

## The Four Phases

### Phase 0: Search First

```bash
engram_ask query="<error message or bug description>"
engram_ask query="<affected file> bug"
```

Don't duplicate prior investigations.

### Phase 1: Root Cause Investigation

```bash
engram_task_create title="Debug: <issue description>" priority="high"
# TASK_UUID
engram_task_update id=<TASK_UUID> status="in_progress"
```

**Step 1:** Reproduce the error. Store raw output:

```bash
engram_context_create title="Error: <brief>" content="Error: <full message>\nStack: <trace>\nReproducible: YES/NO" source="<file:line>"
engram_relationship_create source_id=<TASK_UUID> source_type=task target_id=<CTX_UUID> target_type=context relationship_type=relates_to agent="<name>"
```

**Step 2:** Check recent changes:

```bash
engram_context_create title="Recent changes: <area>" content="Recent commits touching affected files:\n- ..." source="git-log"
engram_relationship_create ...
```

**Step 3:** Examine the code. Store observations.

### Phase 2: Pattern Analysis

```bash
engram_ask query="<error type> pattern similar bugs"
engram_context_create title="Pattern analysis: <error type>" content="Similar issues: ...\nRecurring pattern: <yes/no>" source="pattern-analysis"
engram_relationship_create ...
```

### Phase 3: Hypothesis Testing

One hypothesis at a time:

```bash
engram_reasoning_create title="Hypothesis: <root cause>" task_id=<TASK_UUID> content="Hypothesis: ...\nEvidence: ...\nTest: <command>\nExpected: ..."
engram_relationship_create ...
```

Run the test. Store result:

```bash
engram_reasoning_create title="Hypothesis result: <statement>" task_id=<TASK_UUID> content="Conclusion: VERIFIED / REFUTED\nNext: ..."
engram_relationship_create ...
```

If refuted, form next hypothesis. If stuck: `engram_next`

### Phase 4: Implementation (only after root cause confirmed)

```bash
engram_reasoning_create title="Fix: <root cause>" task_id=<TASK_UUID> content="Fix applied: ...\nFiles: ...\nRegression test: ..."
engram_relationship_create ...
```

### Phase 5: Validate and Close

```bash
engram_validate
engram_task_update id=<TASK_UUID> status="done"
```
