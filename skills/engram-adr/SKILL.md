---
name: engram-adr
description: "Document architectural decisions as engraph ADRs. Store context, options considered, rationale, and consequences for queryable decision history."
---

# Architecture Decision Records

Use ADRs for significant technical choices with lasting impact. Store in engram so future agents can query why decisions were made.

> **Per-turn write rule:** `engram_adr_create` counts as an engram write and resets the `engram-write-first` counter. Always follow with `engram_relationship_create` to link the ADR to its task. If you do research (bash/read) before writing the ADR, store interim findings as `engram_context_create` — don't let the research turns accumulate without writes.

## When to ADR

- Technology choices (database, framework, language)
- Architectural patterns (microservices, event-driven)
- Security approaches, deployment strategies
- Trade-offs with long-term implications

## Protocol

### Create an ADR

```bash
engram_adr_create title="<Short Decision Title>" number=<N> context="<Situation, options considered, what was decided and why>" agent="<name>"
# ADR_UUID
```

The `context` field should include:
- **Problem statement** — what challenge are we facing
- **Options considered** — what alternatives were evaluated
- **Decision** — what was chosen
- **Rationale** — why this option over others
- **Consequences** — expected positive and negative outcomes

### Link to Task

```bash
engram_relationship_create source_id=<TASK_UUID> source_type=task target_id=<ADR_UUID> target_type=adr relationship_type=relates_to agent="<name>"
```

### Link to Related ADRs

```bash
# This ADR supersedes a previous one
engram_relationship_create source_id=<NEW_ADR_UUID> source_type=adr target_id=<OLD_ADR_UUID> target_type=adr relationship_type=explains agent="<name>"
```

## Rules

- Number sequentially, never reuse numbers
- Write during decision-making, not after the fact
- Document alternatives considered, not just the chosen option
- Set revisit criteria for decisions that may need updating
- Link every ADR to its parent task
