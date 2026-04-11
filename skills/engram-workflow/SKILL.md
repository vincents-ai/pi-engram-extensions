---
name: engram-workflow
description: "Use engram workflows (state machines) to track structured processes — feature development, bug fixes, incidents, releases, ADRs, research spikes, and custom flows."
---

# Engram Workflow Skill

> **Per-turn write rule:** After every `engram_workflow_transition` or `engram_workflow_execute_action`, store an outcome with `engram_context_create` or `engram_reasoning_create` + `engram_relationship_create`. Transitioning state without recording why is the workflow equivalent of a commit without a message.

## What Workflows Are

Engram workflows are **state machines** — a defined set of states and the transitions between them. A *workflow definition* is the template. A *workflow instance* is a running copy of that template attached to a specific entity (task, ADR, session, etc.).

Use workflows when a process has:
- Defined stages with clear entry/exit criteria
- Multiple agents or humans who need to hand off work
- A need to track what step you're at and what's next
- Actions to run at transitions (run a script, notify, update an entity)

## Built-in Templates

Use `engram_workflow_scaffold` with one of these names to create a ready-to-run workflow instantly:

| template | description |
|---|---|
| `feature-development` | plan → implement → review → done |
| `bug-fix` | triage → investigate → fix → verify → closed |
| `code-review` | submitted → in_review → needs_changes → approved → merged |
| `release` | planning → development → testing → staging → production |
| `incident` | detected → investigating → mitigating → monitoring → resolved → closed |
| `adr` | proposed → discussing → decided → implemented / superseded |
| `research-spike` | framing → researching → synthesising → concluded |

## When to Use Each Template

- **Starting new feature work** → `feature-development`
- **Bug report comes in** → `bug-fix`
- **PR/MR submitted** → `code-review`
- **Planning a release** → `release`
- **Production incident** → `incident`
- **Writing an ADR** → `adr`
- **Technical investigation** → `research-spike`

## Create a Workflow from a Template

```
engram_workflow_scaffold template_name="feature-development" agent="pi"
```

This creates the workflow, adds all states and transitions, sets the initial state, and activates it in one call.

## Start a Workflow Instance

Attach a workflow to a task (or ADR, session, etc.):

```
engram_workflow_start
  workflow_id="<workflow-uuid>"
  agent="pi"
  entity_id="<task-uuid>"
  entity_type="task"
```

## Check Instance Status

Shows current state and available next transitions:

```
engram_workflow_status instance_id="<instance-uuid>"
```

## Advance Through a Transition

```
engram_workflow_transition
  instance_id="<instance-uuid>"
  transition="submit_for_review"
  agent="pi"
```

Always check available transitions via `engram_workflow_status` before calling this.

## Run Actions at Transitions

Execute an external command as part of a workflow step:

```
engram_workflow_execute_action
  action_type="external_command"
  command="cargo"
  args="test,--all"
  working_directory="/home/shift/code/agentic-git"
  timeout_seconds=120
```

Send a notification:

```
engram_workflow_execute_action
  action_type="notification"
  message="Feature X is ready for review"
```

Update an entity:

```
engram_workflow_execute_action
  action_type="update_entity"
  entity_id="<task-uuid>"
  entity_type="task"
```

## Create a Custom Workflow

For workflows not covered by templates, use `engram_workflow_scaffold` with `spec_json`:

```
engram_workflow_scaffold spec_json='{
  "title": "My Custom Flow",
  "description": "...",
  "entity_types": "task",
  "states": [
    { "name": "start",  "type": "start",       "description": "Initial state" },
    { "name": "doing",  "type": "in_progress", "description": "Work in progress" },
    { "name": "done",   "type": "done",        "description": "Complete", "is_final": true }
  ],
  "transitions": [
    { "name": "begin",  "from": "start", "to": "doing", "type": "manual", "description": "Start work" },
    { "name": "finish", "from": "doing", "to": "done",  "type": "manual", "description": "Mark complete" }
  ]
}'
```

State types: `start` | `in_progress` | `review` | `done` | `blocked`
Transition types: `automatic` | `manual` | `conditional` | `scheduled`

## Full Orchestration Pattern

Attach a workflow to a task **and** use it to gate the auto loop:

```
# 1. Create task + scaffold workflow
engram_task_create --title "Implement rate limiting"
# TASK_UUID = abc-001

engram_workflow_scaffold template_name="feature-development" agent="pi"
# WORKFLOW_UUID = wf-001

engram_workflow_start workflow_id="wf-001" agent="pi" entity_id="abc-001" entity_type="task"
# INSTANCE_UUID = inst-001

# 2. Check current state
engram_workflow_status instance_id="inst-001"
# → current state: planning

# 3. Dispatch subagent for planning stage
engram_dispatch task_id="abc-001"

# 4. Advance the workflow
engram_workflow_transition instance_id="inst-001" transition="start_implementation" agent="pi"

# 5. Dispatch subagent for implementation
engram_dispatch task_id="abc-001"

# 6. Advance to review
engram_workflow_transition instance_id="inst-001" transition="submit_for_review" agent="pi"
```

## List Active Instances

```
engram_workflow_instances running_only=true
```

## List Workflow Definitions

```
engram_workflow_list
```

## Cancel an Instance

```
engram_workflow_cancel instance_id="<instance-uuid>"
```

## Protocol Rules

1. **Always check status before transitioning** — `engram_workflow_status` shows available transitions
2. **Link workflows to tasks** — use `entity_id` + `entity_type` when starting instances
3. **Store transition outcomes in engram** — after each transition, write a context entity with what was found
4. **Don't skip states** — execute every transition in sequence; skipping breaks audit trails
5. **On failure, use blocked state** — transition to `blocked` and store the reason as context
