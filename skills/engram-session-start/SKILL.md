---
name: engram-session-start
description: "Universal session start protocol. Run at the beginning of every agent session — syncs from remote, opens a session, loads prior context, and surfaces the next action."
---

# Engram Session Start

Run this protocol at the beginning of every agent session. No exceptions.

> **Per-turn write rule:** Throughout the session, after every `bash`, `edit`, or `write` call, store a finding with `engram_context_create` or `engram_reasoning_create` + `engram_relationship_create`. Never let 3 consecutive turns with substantive work pass without an engram write — the `engram-write-first` extension will warn you.

## Protocol

### Step 0: Sync Pull (if remote configured)

```bash
# Check remotes
engram_sync_list_remotes
# → Use engram_sync_pull if remotes exist
```

### Step 1: Start a Named Session

```bash
engram_session_start name="<role>-<goal>"
# Save the returned SESSION_ID
```

Name format: `<role>-<goal>` (e.g. `orchestrator-auth-feature`, `implementer-batch-task`).

### Step 2: Search for Prior Context

```bash
engram_ask query="<your goal or task area>"
engram_session_list
```

Never start work without querying prior session summaries.

### Step 3: Get Next Priority Action

```bash
engram_next
```

## Key Rules

1. Always run session-start before any work
2. Pull before creating anything
3. Check prior session summaries before acting
4. Save the SESSION_ID for engram_session_end
5. If no remote configured, note it and continue
