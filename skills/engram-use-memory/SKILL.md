---
name: engram-use-memory
description: Use engram as persistent memory for all work. Covers the per-turn write rule — every bash, edit, or write call must be followed by engram_context_create or engram_reasoning_create in the same turn. Load this skill whenever the engram-write-first warning appears or when starting any task that produces findings.
---

# Using Engram Memory

Engram is your persistent memory. Your LLM context window is transient — engram is not.

## The Per-Turn Write Rule

> **After every `bash`, `edit`, or `write` call: store a finding before the turn ends.**

This is enforced by the `engram-write-first` extension. It warns after 3 consecutive turns with substantive work but no engram write.

The rule in one line:
```
bash / edit / write  →  engram_context_create OR engram_reasoning_create  →  engram_relationship_create
```

### What to write

| You used | You found / did | Write as |
|---|---|---|
| `bash` (ran a command) | Output, error, measurement | `engram_context_create` |
| `read` (examined a file) | Key fact, structure, bug | `engram_context_create` |
| `edit` / `write` (changed code) | What you changed and why | `engram_reasoning_create` |
| Made a design choice | Options, trade-offs, decision | `engram_reasoning_create` |
| Made an architectural choice | Options, consequences | `engram_adr_create` |

### Minimum viable write

If you're unsure what to write, use this pattern:

```
engram_context_create
  title="<one line description of what you just did>"
  content="<what you ran/found/changed and why it matters>"
  relevance="medium"

engram_relationship_create
  source_id=<context UUID>  source_type="context"
  target_id=<task UUID>     target_type="task"
  relationship_type="relates_to"
  agent="<your agent name>"
```

### What NOT to do

- ❌ Run multiple bash/edit/write calls across 3+ turns without any engram write
- ❌ Save everything up for the end of the task then write it all at once
- ❌ Skip `engram_relationship_create` — unlinked records can't be found by graph traversal
- ❌ Write vague content like "did some work" — be specific, include actual output

---

## Search & Retrieval

```bash
engram_ask query="<what you need to know>"
engram_task_show id=<UUID>
engram_relationship_connected entity_id=<UUID> max_depth=2
```

Always search before acting. Never assume — query first.

## Saving Information

### Facts, observations, findings
```bash
engram_context_create
  title="<short descriptive title>"
  content="<specific detail — include error text, code snippets, output>"
  relevance="high"
  source="<file path or command>"
  tags="<comma,separated>"
```

### Decisions, reasoning, logic chains
```bash
engram_reasoning_create
  title="<what decision this captures>"
  task_id=<UUID>
  content="<full reasoning — options considered, why you chose this>"
  confidence=0.8
```

### Architectural decisions
```bash
engram_adr_create
  title="<decision title>"
  number=<N>
  context="<situation, options, decision, consequences>"
  agent="<your name>"
```

### Always link immediately after creating
```bash
engram_relationship_create
  source_id=<new entity UUID>  source_type="context|reasoning|adr"
  target_id=<task UUID>        target_type="task"
  relationship_type="relates_to"
  agent="<your name>"
```

## Task Lifecycle

```bash
# Start
engram_task_update id=<UUID> status="in_progress"

# Finish
engram_task_update id=<UUID> status="done" outcome="<one-line summary>"

# Blocked
engram_task_update id=<UUID> status="blocked" reason="<what is needed>"
```

## Quick reference: what triggers the write-first warning

The `engram-write-first` extension flags a turn as a violation when:
- `edit`, `write`, or `bash` was called **AND**
- `engram_context_create`, `engram_reasoning_create`, or `engram_adr_create` was **not** called

After **3 consecutive violation turns**, it shows the warning. Reset the counter by writing to engram.
