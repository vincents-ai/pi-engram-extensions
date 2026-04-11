---
name: engram-commit-convention
description: "Every commit must reference a valid engram task UUID. Covers format, validation, and why --no-verify is prohibited."
---

# Engram Commit Convention

Every git commit must reference a valid engram task UUID. This is a hard gate enforced by the pre-commit hook.

> **Why this matters with engram-write-first:** The pre-commit hook requires linked context and reasoning on the task. If you see the write-first warning before committing, that's your signal that those links are missing. Write them now — not just to satisfy the hook, but because untraced work is lost work.

## Format

```
<type>: <title> [<ENGRAM_TASK_UUID>]
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`

## Before Committing

The task must exist in engram with at least one context and one reasoning relationship. Store these as you work, not as a last step.

```bash
engram_validate_commit message="feat: my change [<UUID>]"
```

## When the Hook Rejects

1. Create missing context: `engram_context_create` + `engram_relationship_create`
2. Create missing reasoning: `engram_reasoning_create` + `engram_relationship_create`
3. Retry the commit

## Rules

- **Never** use `--no-verify` — it bypasses traceability (violates ADR-018)
- Create task + context + reasoning **before** committing, not as a last step
- Even a stub context and reasoning is better than nothing
