---
name: engram-session-end
description: "Universal session end protocol. Run at the end of every agent session — closes open tasks, generates a handoff summary, syncs to remote, and validates state."
---

# Engram Session End

Run this protocol at the end of every agent session. Always.

> **Before ending:** Check that all substantive work this session has been stored in engram. If you see the `engram-write-first` warning, write outstanding findings now with `engram_context_create` or `engram_reasoning_create` before proceeding.

## Protocol

### Step 1: Close Remaining Open Tasks

```bash
engram_task_list status="in_progress"
# Mark done: engram_task_update id=<UUID> status="done" outcome="<summary>"
# Or block: engram_task_update id=<UUID> status="blocked" reason="<why>"
```

Do not leave dangling in-progress tasks.

### Step 2: End Session with Summary

```bash
engram_session_end id=<SESSION_ID> generate_summary=true
```

Always use `generate_summary=true`. The summary is the handoff artifact.

### Step 3: Sync Push

```bash
engram_sync_list_remotes
# If remotes exist: engram_sync_push remote="origin"
```

Push AFTER generating the summary so the remote has the full handoff.

### Step 4: Validate

```bash
engram_validate
```

Must pass before exiting.

## Key Rules

1. Always end sessions — unclosed sessions break `engram_next`
2. Generate the summary — without it, the next agent has no context
3. Push is the last step — summary must exist first
4. Close or block all in-progress tasks
5. Validate before exiting
