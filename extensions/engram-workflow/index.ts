/**
 * Engram Workflow Extension
 *
 * Exposes the full engram workflow subsystem as pi tools + commands.
 *
 * Tools (usable by the LLM agent):
 *   engram_workflow_scaffold       — Create a complete workflow (states + transitions) in one call
 *   engram_workflow_create         — Create a bare workflow definition
 *   engram_workflow_add_state      — Add a state to a workflow
 *   engram_workflow_add_transition — Add a transition between states
 *   engram_workflow_activate       — Activate a workflow (make it runnable)
 *   engram_workflow_get            — Get full workflow definition
 *   engram_workflow_list           — List workflow definitions
 *   engram_workflow_update         — Update workflow metadata / initial state
 *   engram_workflow_start          — Start a workflow instance against an entity
 *   engram_workflow_transition     — Advance an instance through a named transition
 *   engram_workflow_status         — Get current state of a running instance
 *   engram_workflow_instances      — List active/all instances
 *   engram_workflow_cancel         — Cancel a running instance
 *   engram_workflow_execute_action — Run an action (command, notification, entity update)
 *   engram_workflow_query_actions  — List available actions/guards/checks for a state
 *
 * Commands:
 *   /workflow-list                 — Show all workflow definitions
 *   /workflow-instances            — Show active instances
 *   /workflow-status <instance-id> — Show instance state + available transitions
 *   /workflow-scaffold <template>  — Create a workflow from a built-in template
 *   /workflow-templates            — List available built-in templates
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { runEngram, parseUuid } from "../common/runEngram.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type StateType = "start" | "in_progress" | "review" | "done" | "blocked";
type TransitionType = "automatic" | "manual" | "conditional" | "scheduled";
type ActionType = "external_command" | "notification" | "update_entity";

interface WorkflowStateSpec {
	name: string;
	type: StateType;
	description: string;
	is_final?: boolean;
}

interface WorkflowTransitionSpec {
	name: string;
	from: string;
	to: string;
	type: TransitionType;
	description: string;
}

interface WorkflowSpec {
	title: string;
	description: string;
	entity_types?: string;
	agent?: string;
	states: WorkflowStateSpec[];
	transitions: WorkflowTransitionSpec[];
}

// Built-in workflow templates ──────────────────────────────────────────────────

const WORKFLOW_TEMPLATES: Record<string, WorkflowSpec> = {
	"feature-development": {
		title: "Feature Development",
		description: "Standard feature development lifecycle: plan → implement → review → done",
		entity_types: "task",
		states: [
			{ name: "planning",      type: "start",       description: "Defining requirements, architecture, and task breakdown" },
			{ name: "implementing",  type: "in_progress",  description: "Writing code, tests, and documentation" },
			{ name: "reviewing",     type: "review",       description: "Code review, QA, and acceptance testing" },
			{ name: "done",          type: "done",         description: "Merged, deployed, and closed", is_final: true },
			{ name: "blocked",       type: "blocked",      description: "Blocked on external dependency or decision" },
		],
		transitions: [
			{ name: "start_implementation", from: "planning",     to: "implementing", type: "manual",    description: "Requirements are clear, begin coding" },
			{ name: "submit_for_review",    from: "implementing", to: "reviewing",    type: "manual",    description: "Code complete, tests passing" },
			{ name: "request_changes",      from: "reviewing",    to: "implementing", type: "manual",    description: "Review requests changes" },
			{ name: "approve_and_merge",    from: "reviewing",    to: "done",         type: "manual",    description: "Review approved, merge and close" },
			{ name: "block",                from: "implementing", to: "blocked",      type: "manual",    description: "Hit a blocker, pause work" },
			{ name: "unblock",              from: "blocked",      to: "implementing", type: "manual",    description: "Blocker resolved, resume" },
			{ name: "reopen",               from: "done",         to: "planning",     type: "manual",    description: "Reopen due to regression or new requirements" },
		],
	},

	"bug-fix": {
		title: "Bug Fix",
		description: "Bug triage and resolution lifecycle: triage → investigate → fix → verify → closed",
		entity_types: "task",
		states: [
			{ name: "triaged",       type: "start",       description: "Bug reported and confirmed, severity assessed" },
			{ name: "investigating", type: "in_progress",  description: "Root cause analysis in progress" },
			{ name: "fixing",        type: "in_progress",  description: "Writing the fix and regression tests" },
			{ name: "verifying",     type: "review",       description: "Testing the fix against the original report" },
			{ name: "closed",        type: "done",         description: "Fix verified and deployed", is_final: true },
			{ name: "wont_fix",      type: "done",         description: "Triaged as not a bug or not worth fixing", is_final: true },
		],
		transitions: [
			{ name: "start_investigation", from: "triaged",       to: "investigating", type: "manual", description: "Start root cause analysis" },
			{ name: "begin_fix",           from: "investigating", to: "fixing",        type: "manual", description: "Root cause identified, write the fix" },
			{ name: "submit_for_verify",   from: "fixing",        to: "verifying",     type: "manual", description: "Fix complete, verify against report" },
			{ name: "fix_verified",        from: "verifying",     to: "closed",        type: "manual", description: "Fix confirmed, close the bug" },
			{ name: "fix_failed",          from: "verifying",     to: "fixing",        type: "manual", description: "Verification failed, back to fixing" },
			{ name: "wont_fix",            from: "triaged",       to: "wont_fix",      type: "manual", description: "Mark as won't fix" },
		],
	},

	"code-review": {
		title: "Code Review",
		description: "Structured code review flow: submitted → reviewed → approved/revisions → merged",
		entity_types: "task,session",
		states: [
			{ name: "submitted",     type: "start",       description: "PR/MR submitted, awaiting reviewer assignment" },
			{ name: "in_review",     type: "in_progress",  description: "Actively being reviewed" },
			{ name: "needs_changes", type: "in_progress",  description: "Reviewer requested changes" },
			{ name: "approved",      type: "review",       description: "Review passed, awaiting merge" },
			{ name: "merged",        type: "done",         description: "Changes merged", is_final: true },
			{ name: "abandoned",     type: "done",         description: "Review abandoned or closed without merge", is_final: true },
		],
		transitions: [
			{ name: "begin_review",       from: "submitted",     to: "in_review",     type: "manual",    description: "Reviewer picks it up" },
			{ name: "request_changes",    from: "in_review",     to: "needs_changes", type: "manual",    description: "Changes requested" },
			{ name: "resubmit",           from: "needs_changes", to: "in_review",     type: "manual",    description: "Author addresses feedback" },
			{ name: "approve",            from: "in_review",     to: "approved",      type: "manual",    description: "Reviewer approves" },
			{ name: "merge",              from: "approved",      to: "merged",        type: "manual",    description: "Merge the change" },
			{ name: "abandon",            from: "submitted",     to: "abandoned",     type: "manual",    description: "Close without merging" },
		],
	},

	"release": {
		title: "Release",
		description: "Software release pipeline: planning → development → testing → staging → production",
		entity_types: "task",
		states: [
			{ name: "planning",    type: "start",       description: "Release scope defined, tasks assigned" },
			{ name: "development", type: "in_progress",  description: "Feature development in progress" },
			{ name: "testing",     type: "review",       description: "QA testing, regression, and acceptance" },
			{ name: "staging",     type: "review",       description: "Deployed to staging, final validation" },
			{ name: "production",  type: "done",         description: "Released to production", is_final: true },
			{ name: "rolled_back", type: "blocked",      description: "Rolled back due to production issue" },
		],
		transitions: [
			{ name: "start_development",  from: "planning",    to: "development", type: "manual",    description: "Begin feature work" },
			{ name: "enter_testing",      from: "development", to: "testing",     type: "manual",    description: "All features done, enter QA" },
			{ name: "testing_failed",     from: "testing",     to: "development", type: "manual",    description: "QA found blockers, back to dev" },
			{ name: "deploy_to_staging",  from: "testing",     to: "staging",     type: "manual",    description: "QA passed, deploy to staging" },
			{ name: "staging_failed",     from: "staging",     to: "testing",     type: "manual",    description: "Staging issues found" },
			{ name: "release",            from: "staging",     to: "production",  type: "manual",    description: "Ship it" },
			{ name: "rollback",           from: "production",  to: "rolled_back", type: "manual",    description: "Rollback due to production issue" },
			{ name: "hotfix_and_retry",   from: "rolled_back", to: "staging",     type: "manual",    description: "Hotfix applied, retry staging" },
		],
	},

	"incident": {
		title: "Incident Response",
		description: "Incident management: detected → investigating → mitigating → resolved → post-mortem",
		entity_types: "task,session",
		states: [
			{ name: "detected",      type: "start",       description: "Incident detected and acknowledged" },
			{ name: "investigating", type: "in_progress",  description: "Root cause analysis underway" },
			{ name: "mitigating",    type: "in_progress",  description: "Mitigation in progress (hotfix, rollback, etc.)" },
			{ name: "monitoring",    type: "review",       description: "Fix applied, monitoring for stability" },
			{ name: "resolved",      type: "review",       description: "Incident resolved, awaiting post-mortem" },
			{ name: "closed",        type: "done",         description: "Post-mortem complete, incident closed", is_final: true },
		],
		transitions: [
			{ name: "begin_investigation", from: "detected",      to: "investigating", type: "manual",    description: "Start root cause analysis" },
			{ name: "start_mitigation",    from: "investigating",  to: "mitigating",    type: "manual",    description: "Cause found, apply mitigation" },
			{ name: "deploy_fix",          from: "mitigating",    to: "monitoring",    type: "manual",    description: "Fix deployed, monitor" },
			{ name: "confirm_resolved",    from: "monitoring",    to: "resolved",      type: "manual",    description: "System stable, mark resolved" },
			{ name: "regression",          from: "monitoring",    to: "mitigating",    type: "manual",    description: "Regression detected, re-mitigate" },
			{ name: "close_post_mortem",   from: "resolved",      to: "closed",        type: "manual",    description: "Post-mortem written and published" },
		],
	},

	"adr": {
		title: "ADR Lifecycle",
		description: "Architecture Decision Record: proposed → discussed → decided → implemented → superseded",
		entity_types: "adr",
		states: [
			{ name: "proposed",     type: "start",       description: "ADR draft written, awaiting discussion" },
			{ name: "discussing",   type: "review",       description: "Stakeholders reviewing and commenting" },
			{ name: "decided",      type: "in_progress",  description: "Decision made and documented" },
			{ name: "implemented",  type: "done",         description: "Decision implemented in code/infra", is_final: true },
			{ name: "superseded",   type: "done",         description: "Superseded by a newer ADR", is_final: true },
			{ name: "rejected",     type: "done",         description: "Proposal rejected", is_final: true },
		],
		transitions: [
			{ name: "open_discussion",  from: "proposed",   to: "discussing",  type: "manual",    description: "Circulate for feedback" },
			{ name: "accept",           from: "discussing", to: "decided",     type: "manual",    description: "Decision reached: accept" },
			{ name: "reject",           from: "discussing", to: "rejected",    type: "manual",    description: "Decision reached: reject" },
			{ name: "implement",        from: "decided",    to: "implemented", type: "manual",    description: "Implementation complete" },
			{ name: "supersede",        from: "implemented",to: "superseded",  type: "manual",    description: "Superseded by newer ADR" },
		],
	},

	"research-spike": {
		title: "Research Spike",
		description: "Time-boxed technical investigation: framing → researching → synthesising → concluded",
		entity_types: "task,session",
		states: [
			{ name: "framing",      type: "start",       description: "Question defined, scope and timebox set" },
			{ name: "researching",  type: "in_progress",  description: "Active investigation, reading, prototyping" },
			{ name: "synthesising", type: "review",       description: "Consolidating findings into a recommendation" },
			{ name: "concluded",    type: "done",         description: "Spike complete, findings stored in engram", is_final: true },
			{ name: "inconclusive", type: "done",         description: "Timebox expired without clear answer", is_final: true },
		],
		transitions: [
			{ name: "begin_research",  from: "framing",     to: "researching",  type: "manual",    description: "Question is clear, start digging" },
			{ name: "start_synthesis", from: "researching", to: "synthesising",  type: "manual",    description: "Enough data, start writing up" },
			{ name: "conclude",        from: "synthesising", to: "concluded",    type: "manual",    description: "Clear recommendation reached" },
			{ name: "timebox_expired", from: "researching", to: "inconclusive",  type: "manual",    description: "Timebox up, no clear answer" },
		],
	},
};

const TEMPLATE_NAMES = Object.keys(WORKFLOW_TEMPLATES) as Array<keyof typeof WORKFLOW_TEMPLATES>;

// ─── Helpers ──────────────────────────────────────────────────────────────────
> {
	try {
		const spawnOpts: Parameters<typeof execFileAsync>[2] = {
			maxBuffer: 2 * 1024 * 1024,
			timeout: options?.timeout ?? 20_000,
		};
		if (options?.cwd) spawnOpts.cwd = options.cwd;
		const { stdout, stderr } = await execFileAsync("engram", args, spawnOpts);
		return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: (err.stdout ?? "").trim(),
			stderr: (err.stderr ?? "").trim(),
			code: err.status ?? 1,
		};
	}
}

function truncate(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return t.truncated ? t.content + `\n[truncated: ${t.outputLines}/${t.totalLines} lines]` : t.content;
}

/** Write a temp JSON file and return the path (for --context-file). */
async function writeTempJson(data: unknown): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-wf-"));
	const filePath = path.join(dir, "ctx.json");
	await fs.promises.writeFile(filePath, JSON.stringify(data), { mode: 0o600 });
	return filePath;
}

async function cleanTempFile(filePath: string) {
	try {
		await fs.promises.unlink(filePath);
		await fs.promises.rmdir(path.dirname(filePath));
	} catch { /* ignore */ }
}

/**
 * Create a complete workflow from a spec in one atomic operation:
 * create → add all states → add all transitions → set initial state → activate
 */
async function buildWorkflow(
	spec: WorkflowSpec,
	onUpdate?: (msg: string) => void,
	cwd?: string,
): Promise<{ workflowId: string; stateIds: Record<string, string>; error?: string }> {
	const cwdOpt = cwd ? { cwd } : {};
	// 1. Create the workflow
	const createArgs = [
		"workflow", "create",
		"--title", spec.title,
		"--description", spec.description,
		"--json",
	];
	if (spec.entity_types) createArgs.push("--entity-types", spec.entity_types);
	if (spec.agent) createArgs.push("--agent", spec.agent);

	const createResult = await runEngram(createArgs, cwdOpt);
	if (createResult.code !== 0) {
		return { workflowId: "", stateIds: {}, error: `create failed: ${createResult.stderr}` };
	}
	const workflowId = parseUuid(createResult.stdout);
	if (!workflowId) {
		return { workflowId: "", stateIds: {}, error: `could not parse workflow ID from: ${createResult.stdout}` };
	}
	onUpdate?.(`Created workflow ${workflowId}`);

	// 2. Add all states, collecting their IDs
	const stateIds: Record<string, string> = {};
	for (const state of spec.states) {
		const stateArgs = [
			"workflow", "add-state", workflowId,
			"--name", state.name,
			"--state-type", state.type,
			"--description", state.description,
			"--json",
		];
		if (state.is_final) stateArgs.push("--is-final");

		const stateResult = await runEngram(stateArgs, cwdOpt);
		if (stateResult.code !== 0) {
			return { workflowId, stateIds, error: `add-state '${state.name}' failed: ${stateResult.stderr}` };
		}
		const stateId = parseUuid(stateResult.stdout);
		if (stateId) {
			stateIds[state.name] = stateId;
			onUpdate?.(`  + state '${state.name}' (${stateId.slice(0, 8)})`);
		}
	}

	// 3. Add all transitions (by state name — engram accepts state IDs or names)
	for (const tx of spec.transitions) {
		const fromId = stateIds[tx.from];
		const toId = stateIds[tx.to];
		if (!fromId || !toId) {
			return { workflowId, stateIds, error: `transition '${tx.name}': unknown state '${!fromId ? tx.from : tx.to}'` };
		}

		const txArgs = [
			"workflow", "add-transition", workflowId,
			"--name", tx.name,
			"--from-state", fromId,
			"--to-state", toId,
			"--transition-type", tx.type,
			"--description", tx.description,
			"--json",
		];

		const txResult = await runEngram(txArgs, cwdOpt);
		if (txResult.code !== 0) {
			return { workflowId, stateIds, error: `add-transition '${tx.name}' failed: ${txResult.stderr}` };
		}
		onUpdate?.(`  → transition '${tx.name}' (${tx.from} → ${tx.to})`);
	}

	// 4. Set initial state (first state with type "start", or first state)
	const initialState = spec.states.find((s) => s.type === "start") ?? spec.states[0];
	if (initialState && stateIds[initialState.name]) {
		await runEngram([
			"workflow", "update", workflowId,
			"--initial-state", stateIds[initialState.name],
		], cwdOpt);
		onUpdate?.(`  ✓ Initial state: '${initialState.name}'`);
	}

	// 5. Activate the workflow
	const activateResult = await runEngram(["workflow", "activate", workflowId, "--json"], cwdOpt);
	if (activateResult.code !== 0) {
		return { workflowId, stateIds, error: `activate failed: ${activateResult.stderr}` };
	}
	onUpdate?.(`✓ Workflow activated`);

	return { workflowId, stateIds };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ─── Tools ──────────────────────────────────────────────────────────────────

	/**
	 * engram_workflow_scaffold
	 * The primary "create a full workflow" tool — agents call this to build a workflow
	 * from a template or from a fully specified JSON spec without needing multiple calls.
	 */
	pi.registerTool({
		name: "engram_workflow_scaffold",
		label: "Engram Workflow Scaffold",
		description: `Create a complete, ready-to-use engram workflow in one call. Either pick a built-in template by name, or supply a full spec JSON. The workflow is created, all states and transitions are added, and it is activated automatically.

Built-in templates: ${TEMPLATE_NAMES.join(", ")}

To use a template: set template_name to one of the above names.
To create custom: set spec_json to a JSON object with shape:
{
  "title": "...",
  "description": "...",
  "entity_types": "task",  // optional, comma-separated
  "agent": "...",          // optional
  "states": [
    { "name": "planning", "type": "start", "description": "...", "is_final": false }
  ],
  "transitions": [
    { "name": "begin", "from": "planning", "to": "implementing", "type": "manual", "description": "..." }
  ]
}

State types: start | in_progress | review | done | blocked
Transition types: automatic | manual | conditional | scheduled`,

		parameters: Type.Object({
			template_name: Type.Optional(Type.String({
				description: `Name of a built-in template. One of: ${TEMPLATE_NAMES.join(", ")}`,
			})),
			spec_json: Type.Optional(Type.String({
				description: "Full workflow spec as JSON string (use instead of template_name for custom workflows)",
			})),
			agent: Type.Optional(Type.String({
				description: "Agent name to assign to the workflow (defaults to current session agent)",
			})),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace.",
			})),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let spec: WorkflowSpec;

			if (params.template_name) {
				const template = WORKFLOW_TEMPLATES[params.template_name as keyof typeof WORKFLOW_TEMPLATES];
				if (!template) {
					throw new Error(`Unknown template '${params.template_name}'. Available: ${TEMPLATE_NAMES.join(", ")}`);
				}
				spec = { ...template };
			} else if (params.spec_json) {
				try {
					spec = JSON.parse(params.spec_json);
				} catch (e) {
					throw new Error(`Invalid spec_json: ${(e as Error).message}`);
				}
			} else {
				throw new Error("Provide either template_name or spec_json");
			}

			if (params.agent) spec.agent = params.agent;

			const repoCwd = (params as { repo_path?: string }).repo_path;
			const updates: string[] = [];
			const result = await buildWorkflow(spec, (msg) => {
				updates.push(msg);
				onUpdate?.({
					content: [{ type: "text", text: updates.join("\n") }],
					details: { step: msg },
				});
			}, repoCwd);

			if (result.error) {
				throw new Error(result.error);
			}

			const stateCount = Object.keys(result.stateIds).length;
			const txCount = spec.transitions.length;
			const summary = [
				`✓ Workflow ready: ${spec.title}`,
				`  ID: ${result.workflowId}`,
				`  ${stateCount} states, ${txCount} transitions`,
				`  Status: active`,
				``,
				`To start an instance:`,
				`  engram_workflow_start workflow_id="${result.workflowId}" agent="<agent-name>"`,
				`  (optionally pass entity_id + entity_type to attach to a task/ADR/etc.)`,
			].join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: {
					workflowId: result.workflowId,
					stateIds: result.stateIds,
					stateCount,
					transitionCount: txCount,
					title: spec.title,
				},
			};
		},
	});

	// ── engram_workflow_create ──────────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_create",
		label: "Engram Workflow Create",
		description: "Create a bare workflow definition (no states/transitions yet). Use engram_workflow_scaffold to create a complete workflow in one step instead.",
		parameters: Type.Object({
			title: Type.String({ description: "Workflow title" }),
			description: Type.String({ description: "What this workflow models" }),
			entity_types: Type.Optional(Type.String({ description: "Comma-separated entity types (task, session, adr, etc.)" })),
			agent: Type.Optional(Type.String({ description: "Assigning agent" })),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = ["workflow", "create", "--title", params.title, "--description", params.description, "--json"];
			if (params.entity_types) args.push("--entity-types", params.entity_types);
			if (params.agent) args.push("--agent", params.agent);

			const result = await runEngram(args, cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);

			const id = parseUuid(result.stdout);
			return {
				content: [{ type: "text", text: `Created workflow: ${id}\n${result.stdout}` }],
				details: { workflowId: id, raw: result.stdout },
			};
		},
	});

	// ── engram_workflow_add_state ───────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_add_state",
		label: "Engram Workflow Add State",
		description: "Add a state to an existing workflow definition.",
		parameters: Type.Object({
			workflow_id: Type.String({ description: "Workflow UUID" }),
			name: Type.String({ description: "State name (e.g. 'planning', 'in_review')" }),
			state_type: StringEnum(["start", "in_progress", "review", "done", "blocked"] as const, {
				description: "State type",
			}),
			description: Type.String({ description: "What this state represents" }),
			is_final: Type.Optional(Type.Boolean({ description: "True if this is a terminal/final state" })),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = [
				"workflow", "add-state", params.workflow_id,
				"--name", params.name,
				"--state-type", params.state_type,
				"--description", params.description,
				"--json",
			];
			if (params.is_final) args.push("--is-final");

			const result = await runEngram(args, cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);

			const id = parseUuid(result.stdout);
			return {
				content: [{ type: "text", text: `Added state '${params.name}': ${id}` }],
				details: { stateId: id, name: params.name },
			};
		},
	});

	// ── engram_workflow_add_transition ─────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_add_transition",
		label: "Engram Workflow Add Transition",
		description: "Add a transition between two states in a workflow.",
		parameters: Type.Object({
			workflow_id: Type.String({ description: "Workflow UUID" }),
			name: Type.String({ description: "Transition name (e.g. 'submit_for_review')" }),
			from_state_id: Type.String({ description: "UUID of the source state" }),
			to_state_id: Type.String({ description: "UUID of the target state" }),
			transition_type: StringEnum(["automatic", "manual", "conditional", "scheduled"] as const, {
				description: "How the transition is triggered",
			}),
			description: Type.String({ description: "What triggers this transition" }),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = [
				"workflow", "add-transition", params.workflow_id,
				"--name", params.name,
				"--from-state", params.from_state_id,
				"--to-state", params.to_state_id,
				"--transition-type", params.transition_type,
				"--description", params.description,
				"--json",
			];

			const result = await runEngram(args, cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);

			return {
				content: [{ type: "text", text: `Added transition '${params.name}'` }],
				details: { name: params.name, raw: result.stdout },
			};
		},
	});

	// ── engram_workflow_activate ───────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_activate",
		label: "Engram Workflow Activate",
		description: "Activate a workflow definition so instances can be started from it.",
		parameters: Type.Object({
			workflow_id: Type.String({ description: "Workflow UUID to activate" }),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const result = await runEngram(["workflow", "activate", params.workflow_id, "--json"], cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			return {
				content: [{ type: "text", text: `Workflow ${params.workflow_id} activated` }],
				details: { workflowId: params.workflow_id },
			};
		},
	});

	// ── engram_workflow_get ────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_get",
		label: "Engram Workflow Get",
		description: "Get full details of a workflow definition: states, transitions, current status.",
		parameters: Type.Object({
			workflow_id: Type.String({ description: "Workflow UUID" }),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const result = await runEngram(["workflow", "get", params.workflow_id, "--json"], cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			return {
				content: [{ type: "text", text: truncate(result.stdout) }],
				details: { raw: result.stdout },
			};
		},
	});

	// ── engram_workflow_list ───────────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_list",
		label: "Engram Workflow List",
		description: "List all workflow definitions in the engram workspace.",
		parameters: Type.Object({
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = (params as { repo_path?: string }).repo_path ? { cwd: (params as { repo_path?: string }).repo_path! } : {};
			const result = await runEngram(["workflow", "list", "--json"], cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			const text = result.stdout || "No workflows found.";
			return {
				content: [{ type: "text", text: truncate(text) }],
				details: { raw: result.stdout },
			};
		},
	});

	// ── engram_workflow_update ─────────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_update",
		label: "Engram Workflow Update",
		description: "Update workflow metadata (title, description, status, initial state).",
		parameters: Type.Object({
			workflow_id: Type.String({ description: "Workflow UUID" }),
			title: Type.Optional(Type.String({ description: "New title" })),
			description: Type.Optional(Type.String({ description: "New description" })),
			status: Type.Optional(StringEnum(["active", "inactive", "draft", "archived"] as const, {
				description: "New status",
			})),
			initial_state_id: Type.Optional(Type.String({ description: "State UUID to set as initial state" })),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = ["workflow", "update", params.workflow_id, "--json"];
			if (params.title) args.push("--title", params.title);
			if (params.description) args.push("--description", params.description);
			if (params.status) args.push("--status", params.status);
			if (params.initial_state_id) args.push("--initial-state", params.initial_state_id);

			const result = await runEngram(args, cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			return {
				content: [{ type: "text", text: `Workflow ${params.workflow_id} updated` }],
				details: { workflowId: params.workflow_id },
			};
		},
	});

	// ── engram_workflow_start ──────────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_start",
		label: "Engram Workflow Start",
		description: "Start a workflow instance. Optionally attach it to an entity (task, ADR, session, etc.) and pass initial context variables.",
		parameters: Type.Object({
			workflow_id: Type.String({ description: "Workflow definition UUID" }),
			agent: Type.String({ description: "Agent starting this instance (e.g. 'pi-orchestrator')" }),
			entity_id: Type.Optional(Type.String({ description: "UUID of the entity to associate (task, ADR, etc.)" })),
			entity_type: Type.Optional(Type.String({ description: "Type of the associated entity (task, adr, session, etc.)" })),
			variables: Type.Optional(Type.String({ description: "Initial variables as key=value pairs, comma-separated (e.g. 'priority=high,owner=alice')" })),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = [
				"workflow", "start", params.workflow_id,
				"--agent", params.agent,
				"--json",
			];
			if (params.entity_id) args.push("--entity-id", params.entity_id);
			if (params.entity_type) args.push("--entity-type", params.entity_type);
			if (params.variables) args.push("--variables", params.variables);

			const result = await runEngram(args, cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);

			const instanceId = parseUuid(result.stdout);
			return {
				content: [{ type: "text", text: `Instance started: ${instanceId}\n${result.stdout}` }],
				details: { instanceId, workflowId: params.workflow_id },
			};
		},
	});

	// ── engram_workflow_transition ─────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_transition",
		label: "Engram Workflow Transition",
		description: "Advance a workflow instance by executing a named transition. Check available transitions first with engram_workflow_status.",
		parameters: Type.Object({
			instance_id: Type.String({ description: "Workflow instance UUID" }),
			transition: Type.String({ description: "Name of the transition to execute (e.g. 'submit_for_review')" }),
			agent: Type.String({ description: "Agent executing the transition" }),
			context: Type.Optional(Type.String({ description: "JSON object of context variables to pass with this transition" })),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = [
				"workflow", "transition", params.instance_id,
				"--transition", params.transition,
				"--agent", params.agent,
				"--json",
			];

			let tmpFile: string | undefined;
			if (params.context) {
				try {
					const contextObj = JSON.parse(params.context);
					tmpFile = await writeTempJson(contextObj);
					args.push("--context-file", tmpFile);
				} catch {
					throw new Error(`context must be valid JSON: ${params.context}`);
				}
			}

			try {
				const result = await runEngram(args, cwdOpt);
				if (result.code !== 0) throw new Error(result.stderr);
				return {
					content: [{ type: "text", text: `Transition '${params.transition}' executed\n${result.stdout}` }],
					details: { instanceId: params.instance_id, transition: params.transition },
				};
			} finally {
				if (tmpFile) await cleanTempFile(tmpFile);
			}
		},
	});

	// ── engram_workflow_status ─────────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_status",
		label: "Engram Workflow Status",
		description: "Get the current state of a running workflow instance, including available next transitions.",
		parameters: Type.Object({
			instance_id: Type.String({ description: "Workflow instance UUID" }),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const result = await runEngram(["workflow", "status", params.instance_id, "--json"], cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			return {
				content: [{ type: "text", text: truncate(result.stdout) }],
				details: { raw: result.stdout },
			};
		},
	});

	// ── engram_workflow_instances ──────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_instances",
		label: "Engram Workflow Instances",
		description: "List active (or all) workflow instances, optionally filtered by workflow or agent.",
		parameters: Type.Object({
			workflow_id: Type.Optional(Type.String({ description: "Filter by workflow definition UUID" })),
			agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
			running_only: Type.Optional(Type.Boolean({ description: "Only show running instances (default: true)" })),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = ["workflow", "instances", "--json"];
			if (params.workflow_id) args.push("--workflow-id", params.workflow_id);
			if (params.agent) args.push("--agent", params.agent);
			if (params.running_only !== false) args.push("--running-only");

			const result = await runEngram(args, cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			const text = result.stdout || "No active instances.";
			return {
				content: [{ type: "text", text: truncate(text) }],
				details: { raw: result.stdout },
			};
		},
	});

	// ── engram_workflow_cancel ─────────────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_cancel",
		label: "Engram Workflow Cancel",
		description: "Cancel a running workflow instance.",
		parameters: Type.Object({
			instance_id: Type.String({ description: "Workflow instance UUID to cancel" }),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const result = await runEngram(["workflow", "cancel", params.instance_id, "--json"], cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			return {
				content: [{ type: "text", text: `Instance ${params.instance_id} cancelled` }],
				details: { instanceId: params.instance_id },
			};
		},
	});

	// ── engram_workflow_execute_action ─────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_execute_action",
		label: "Engram Workflow Execute Action",
		description: "Execute a workflow action: run an external command, send a notification, or update an entity.",
		parameters: Type.Object({
			action_type: StringEnum(["external_command", "notification", "update_entity"] as const, {
				description: "Type of action to execute",
			}),
			command: Type.Optional(Type.String({ description: "Command to run (for external_command)" })),
			args: Type.Optional(Type.String({ description: "Command arguments, comma-separated (for external_command)" })),
			working_directory: Type.Optional(Type.String({ description: "Working directory (for external_command)" })),
			environment: Type.Optional(Type.String({ description: "Env vars as KEY=VALUE pairs, comma-separated" })),
			timeout_seconds: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
			message: Type.Optional(Type.String({ description: "Notification message (for notification)" })),
			entity_id: Type.Optional(Type.String({ description: "Entity UUID to update (for update_entity)" })),
			entity_type: Type.Optional(Type.String({ description: "Entity type (for update_entity)" })),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = ["workflow", "execute-action", "--action-type", params.action_type, "--json"];
			if (params.command) args.push("--command", params.command);
			if (params.args) args.push("--args", params.args);
			if (params.working_directory) args.push("--working-directory", params.working_directory);
			if (params.environment) args.push("--environment", params.environment);
			if (params.timeout_seconds != null) args.push("--timeout-seconds", String(params.timeout_seconds));
			if (params.message) args.push("--message", params.message);
			if (params.entity_id) args.push("--entity-id", params.entity_id);
			if (params.entity_type) args.push("--entity-type", params.entity_type);

			const result = await runEngram(args, cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			return {
				content: [{ type: "text", text: result.stdout || "Action executed" }],
				details: { actionType: params.action_type, raw: result.stdout },
			};
		},
	});

	// ── engram_workflow_query_actions ──────────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_query_actions",
		label: "Engram Workflow Query Actions",
		description: "List available actions, guards, and checks for a workflow definition (optionally filtered by state).",
		parameters: Type.Object({
			workflow_id: Type.String({ description: "Workflow definition UUID" }),
			state_id: Type.Optional(Type.String({ description: "Filter to actions available in a specific state" })),
			repo_path: Type.Optional(Type.String({ description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const args = ["workflow", "query-actions", params.workflow_id, "--json"];
			if (params.state_id) args.push("--state-id", params.state_id);

			const result = await runEngram(args, cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			return {
				content: [{ type: "text", text: truncate(result.stdout) }],
				details: { raw: result.stdout },
			};
		},
	});

	// ─── Commands ────────────────────────────────────────────────────────────────

	// ── /workflow-templates ────────────────────────────────────────────────

	pi.registerCommand("workflow-templates", {
		description: "List available built-in workflow templates",
		handler: async (_args, ctx) => {
			const lines = ["Built-in workflow templates:\n"];
			for (const [name, spec] of Object.entries(WORKFLOW_TEMPLATES)) {
				lines.push(`  ${name}`);
				lines.push(`    ${spec.description}`);
				lines.push(`    States: ${spec.states.map((s) => s.name).join(" → ")}`);
				lines.push("");
			}
			lines.push("Usage: /workflow-scaffold <template-name>");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── /workflow-scaffold ─────────────────────────────────────────────────

	pi.registerCommand("workflow-scaffold", {
		description: "Create a workflow from a built-in template. Usage: /workflow-scaffold <template-name> [agent-name]",
		getArgumentCompletions: (prefix) => {
			const matches = TEMPLATE_NAMES
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: `${n} — ${WORKFLOW_TEMPLATES[n].description}` }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const templateName = parts[0];
			const agentName = parts[1] ?? "pi";

			if (!templateName) {
				ctx.ui.notify(
					`Usage: /workflow-scaffold <template> [agent]\n\nTemplates: ${TEMPLATE_NAMES.join(", ")}`,
					"warning",
				);
				return;
			}

			const template = WORKFLOW_TEMPLATES[templateName as keyof typeof WORKFLOW_TEMPLATES];
			if (!template) {
				ctx.ui.notify(
					`Unknown template '${templateName}'. Available: ${TEMPLATE_NAMES.join(", ")}`,
					"error",
				);
				return;
			}

			ctx.ui.setStatus("engram-wf", `scaffolding '${templateName}'...`);
			ctx.ui.notify(`Creating workflow: ${template.title}`, "info");

			const spec = { ...template, agent: agentName };
			const updates: string[] = [];

			const result = await buildWorkflow(spec, (msg) => {
				updates.push(msg);
				ctx.ui.setStatus("engram-wf", msg.slice(0, 50));
			});

			ctx.ui.setStatus("engram-wf", undefined);

			if (result.error) {
				ctx.ui.notify(`Failed: ${result.error}`, "error");
				return;
			}

			const stateCount = Object.keys(result.stateIds).length;
			ctx.ui.notify(
				`✓ Workflow '${template.title}' created\n  ID: ${result.workflowId}\n  ${stateCount} states, ${spec.transitions.length} transitions\n  Status: active`,
				"success",
			);

			// Inject summary for the LLM
			pi.sendUserMessage(
				[
					`Workflow scaffolded: **${template.title}**`,
					`Workflow ID: \`${result.workflowId}\``,
					``,
					`States:`,
					...spec.states.map((s) => `  - \`${s.name}\` (${s.type})${s.is_final ? " [final]" : ""}: ${s.description}`),
					``,
					`Transitions:`,
					...spec.transitions.map((t) => `  - \`${t.name}\`: ${t.from} → ${t.to}`),
					``,
					`To start an instance against a task:`,
					`\`\`\``,
					`engram_workflow_start workflow_id="${result.workflowId}" agent="${agentName}" entity_id="<task-uuid>" entity_type="task"`,
					`\`\`\``,
				].join("\n"),
				{ deliverAs: "followUp" },
			);
		},
	});

	// ── /workflow-list ─────────────────────────────────────────────────────

	pi.registerCommand("workflow-list", {
		description: "List all engram workflow definitions",
		handler: async (_args, ctx) => {
			const result = await runEngram(["workflow", "list"]);
			if (result.code !== 0) {
				ctx.ui.notify(`Failed: ${result.stderr}`, "error");
				return;
			}
			const text = result.stdout || "No workflows found. Use /workflow-scaffold to create one.";
			ctx.ui.notify(text, "info");
		},
	});

	// ── /workflow-instances ────────────────────────────────────────────────

	pi.registerCommand("workflow-instances", {
		description: "List active workflow instances",
		handler: async (_args, ctx) => {
			const result = await runEngram(["workflow", "instances", "--running-only"]);
			if (result.code !== 0) {
				ctx.ui.notify(`Failed: ${result.stderr}`, "error");
				return;
			}
			const text = result.stdout || "No active instances.";
			ctx.ui.notify(text, "info");
		},
	});

	// ── /workflow-status ───────────────────────────────────────────────────

	pi.registerCommand("workflow-status", {
		description: "Get status of a workflow instance. Usage: /workflow-status <instance-uuid>",
		handler: async (args, ctx) => {
			const instanceId = args?.trim();
			if (!instanceId) {
				ctx.ui.notify("Usage: /workflow-status <instance-uuid>", "warning");
				return;
			}

			const result = await runEngram(["workflow", "status", instanceId]);
			if (result.code !== 0) {
				ctx.ui.notify(`Failed: ${result.stderr}`, "error");
				return;
			}
			ctx.ui.notify(result.stdout, "info");
		},
	});

	// ── engram_workflow_templates tool ───────────────────────────────────

	pi.registerTool({
		name: "engram_workflow_templates",
		label: "Engram Workflow Templates",
		description:
			"List all available built-in engram workflow templates with their descriptions and state sequences. " +
			"Use before calling engram_workflow_scaffold to see what templates are available.",
		parameters: Type.Object({}),
		async execute() {
			const lines = ["Built-in workflow templates:\n"];
			for (const [name, spec] of Object.entries(WORKFLOW_TEMPLATES)) {
				lines.push(`  ${name}`);
				lines.push(`    ${spec.description}`);
				lines.push(`    States: ${spec.states.map((s: { name: string }) => s.name).join(" → ")}`);
				lines.push("");
			}
			lines.push(`Use: engram_workflow_scaffold template_name="<name>"`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { templates: TEMPLATE_NAMES },
			};
		},
	});
}
