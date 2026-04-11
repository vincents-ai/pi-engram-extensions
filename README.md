# pi-engram-extensions

Extensions and skills for the [pi coding agent](https://github.com/mariozechner/pi-coding-agent) that integrate [engram](https://github.com/vincents-ai/engram) — a distributed memory system for AI agents.

## Install

```bash
# Project-local (committed to .pi/settings.json — shared with the team):
pi install -l git:github.com/vincents-ai/pi-engram-extensions

# Or global:
pi install git:github.com/vincents-ai/pi-engram-extensions
```

## What's included

### Extensions

| Extension | Description |
|---|---|
| `engram-tools` | First-class typed pi tools for every common `engram` CLI subcommand |
| `engram-orchestrator` | `/orchestrate`, `/engram-dispatch`, `/engram-collect` — spawn and coordinate subagents |
| `engram-agents` | Browse, search, and dispatch the 171 built-in engram agent personas |
| `engram-workflow` | Full engram workflow subsystem — scaffold, start, transition, and monitor state machines |
| `model-failover` | Auto-switch to fallback models on rate limits, return to preferred when cool-down expires |
| `engram-session` | Automatic engram session lifecycle (sync pull/push, session open/close, handoff summaries) |
| `engram-status` | Live engram session + task status in the pi TUI footer |
| `engram-commit-gate` | Blocks `git commit` if the message lacks a valid engram task UUID; bans `--no-verify` |
| `engram-write-first` | Warns (and tells) the LLM when it completes substantive work without storing findings |

### Skills

| Skill | Description |
|---|---|
| `install-engram` | Install the engram CLI and bootstrap a project workspace |
| `engram-session-start` | Universal session start protocol — sync, open session, load prior context |
| `engram-session-end` | Universal session end protocol — close tasks, generate handoff, sync to remote |
| `engram-use-memory` | Per-turn write rule — every bash/edit/write must be followed by an engram write |
| `engram-orchestrator` | Orchestrator agent loop — search, plan, dispatch subagents, validate |
| `engram-subagent-register` | Subagent registration — claim task, pull context, store findings, report back |
| `engram-plan-feature` | Plan a feature as a queryable engram task hierarchy |
| `engram-adr` | Document architectural decisions as engram ADRs |
| `engram-commit-convention` | Commit message format with task UUID linkage |
| `engram-systematic-debugging` | Systematic debugging with engram evidence trails |
| `engram-tdd` | Test-driven development with engram validation checkpoints |
| `engram-workflow` | Use engram workflow state machines to track structured processes |
| `setup-model-failover` | Configure `.pi/failover.json` and `.pi/model-routing.json` for model-failover |
| `setup-pi-engram-extensions` | Full workspace bootstrap — check prerequisites and install extension deps |

## Requirements

- [pi coding agent](https://github.com/mariozechner/pi-coding-agent) 
- [engram](https://github.com/vincents-ai/engram) CLI in `PATH` — see the `install-engram` skill

## Post-install setup

After installing the package, run the setup skill to configure model failover for your subscriptions:

```
/skill:setup-pi-engram-extensions
```

## Config files

`model-failover` reads `.pi/failover.json` and `.pi/model-routing.json` from your project (or `~/.pi/agent/` globally). These are user-specific — run `/skill:setup-model-failover` to generate them interactively.

## License

AGPL-3.0-or-later — open source use free; commercial use requires a licence from Vincent Palmer.
