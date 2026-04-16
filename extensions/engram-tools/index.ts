/**
 * Engram Tools — First-class engraph CLI tools for pi
 *
 * Wraps every commonly-used `engram` subcommand as a typed pi tool,
 * giving the LLM structured parameters instead of raw bash invocations.
 *
 * Every tool accepts an optional `repo_path` parameter. When provided, engram
 * commands run with that directory as cwd, targeting the engram workspace for
 * that sub-project (e.g. `/home/user/project/agentic-repos`). Omit it to use
 * the current working directory (the default workspace).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Run an engraph command, return truncated stdout. */
async function runEngram(
	args: string[],
	options?: { timeout?: number; cwd?: string; input?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
	const spawnOpts: Parameters<typeof execFileAsync>[2] = {
		maxBuffer: 10 * 1024 * 1024, // 10 MB
		timeout: options?.timeout ?? 30_000,
	};
	if (options?.cwd) spawnOpts.cwd = options.cwd;

	if (options?.input !== undefined) {
		return new Promise((resolve) => {
			const child = execFile("engram", args, spawnOpts, (err, stdout, stderr) => {
				resolve({
					stdout: (stdout ?? "").trim(),
					stderr: (stderr ?? "").trim(),
					code: err ? (err.killed ? 137 : (err.errno === undefined ? (err.status ?? 1) : 1)) : 0,
				});
			});
			if (options.input) child.stdin?.write(options.input);
			child.stdin?.end();
		});
	}

	try {
		const { stdout, stderr } = await execFileAsync("engram", args, spawnOpts);
		return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; killed?: boolean; status?: number };
		return {
			stdout: (err.stdout ?? "").trim(),
			stderr: (err.stderr ?? "").trim(),
			code: err.killed ? 137 : (err.status ?? 1),
		};
	}
}

/** Truncate output for LLM consumption. */
function truncate(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (t.truncated) {
		return (
			t.content +
			`\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)})]`
		);
	}
	return t.content;
}

/** Build a success result. */
function ok(text: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: truncate(text) }],
		details: details ?? {},
	};
}

/** Build an error result. */
function err(text: string) {
	throw new Error(text);
}

/** Parse a UUID from engram output lines like "Task 'abc-123' created" */
function parseUuid(output: string): string | null {
	const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
	return match ? match[0] : null;
}

// ─── Shared repo_path helpers ──────────────────────────────────────────────────

/**
 * Optional repo_path parameter added to every tool.
 * When provided, engram commands run in that directory, targeting the
 * sub-project's engram workspace instead of the default cwd.
 * Example values: "/home/user/project/agentic-repos", "../engram"
 */
const REPO_PATH_PARAM = Type.Optional(
	Type.String({
		description:
			"Absolute (or relative) path to the repo whose engram workspace to use " +
			"(e.g. '/home/user/project/agentic-repos'). Omit to use the current workspace.",
	}),
);

/** Extract a cwd option from any params object that carries repo_path. */
function repoCwd(params: { repo_path?: string }): { cwd?: string } {
	return params.repo_path ? { cwd: params.repo_path } : {};
}

// ─── Tool Definitions ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── engram_ask ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_ask",
		label: "Engram Ask",
		description:
			"Natural language search across all engram entities (tasks, context, reasoning, ADRs, sessions). Always run this BEFORE starting any new task to check for prior work.",
		promptSnippet: "Search engram for prior context, decisions, and findings",
		promptGuidelines: [
			"Use `engram_ask` as the first step for any new task — never assume prior state.",
			"Use specific queries: 'rate limiting API', 'OAuth design decision', 'token validation bug'.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural language query about engram data" }),
			context: Type.Optional(Type.String({ description: "Optional context scope (task ID, agent, etc.)" })),
			knowledge_type: Type.Optional(
				StringEnum(["fact", "pattern", "rule", "concept", "procedure", "heuristic", "skill", "technique"] as const, {
					description: "Filter knowledge results by type",
				}),
			),
			deep: Type.Optional(Type.Boolean({ description: "Enable deep relationship graph walking" })),
			max_depth: Type.Optional(Type.Integer({ description: "Max traversal depth for deep walk (default: 2)" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["ask", "query", params.query];
			if (params.context) args.push("--context", params.context);
			if (params.knowledge_type) args.push("--knowledge-type", params.knowledge_type);
			if (params.deep) args.push("--deep");
			if (params.max_depth) args.push("--max-depth", String(params.max_depth));

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0 && result.stderr) {
				err(`engram ask failed: ${result.stderr}`);
			}
			return ok(result.stdout || "(no results)");
		},
	});

	// ── engram_task_create ────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_task_create",
		label: "Engram Task Create",
		description:
			"Create a new engram task. Returns the task UUID needed for commits and relationships. Always link the task to context and reasoning after creation.",
		promptSnippet: "Create a new engram task to anchor work",
		promptGuidelines: [
			"Create a task for every unit of work — features, bugs, spikes, reviews.",
			"Use --parent to build task hierarchies (parent + subtasks).",
			"After creating, link context and reasoning with engram_relationship_create.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Task title" }),
			priority: Type.Optional(
				StringEnum(["low", "medium", "high", "critical"] as const, { description: "Task priority (default: medium)" }),
			),
			parent: Type.Optional(Type.String({ description: "Parent task UUID for subtask nesting" })),
			agent: Type.Optional(Type.String({ description: "Assigned agent name" })),
			tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
			description: Type.Optional(Type.String({ description: "Task description" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["task", "create", "--output", "json"];
			args.push("--title", params.title);
			if (params.priority) args.push("--priority", params.priority);
			if (params.parent) args.push("--parent", params.parent);
			if (params.agent) args.push("--agent", params.agent);
			if (params.tags) args.push("--tags", params.tags);
			if (params.description) args.push("--description", params.description);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram task create failed: ${result.stderr}`);
			}
			const uuid = parseUuid(result.stdout);
			return ok(result.stdout, { uuid });
		},
	});

	// ── engram_task_create_batch ──────────────────────────────────────────────

	pi.registerTool({
		name: "engram_task_create_batch",
		label: "Engram Task Create Batch",
		description:
			"Create multiple tasks at once under a parent. Provide a JSON array of {title, priority?} objects or a plain-text file with one title per line.",
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					title: Type.String(),
					priority: Type.Optional(StringEnum(["low", "medium", "high", "critical"] as const)),
				}),
				{ description: "Array of tasks to create" },
			),
			parent: Type.String({ description: "Parent task UUID applied to all tasks" }),
			priority: Type.Optional(
				StringEnum(["low", "medium", "high", "critical"] as const, {
					description: "Default priority for tasks that don't specify one (default: medium)",
				}),
			),
			agent: Type.Optional(Type.String({ description: "Default agent for all tasks" })),
			output_format: Type.Optional(
				StringEnum(["json", "ids", "text"] as const, { description: "Output format (default: json)" }),
			),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["task", "create-batch", "--parent", params.parent];
			if (params.priority) args.push("--priority", params.priority);
			if (params.agent) args.push("--agent", params.agent);
			if (params.output_format) args.push("--output", params.output_format);
			args.push("--json");

			const input = JSON.stringify(params.tasks);
			const result = await runEngram(args, { input, ...repoCwd(params) });
			if (result.code !== 0) {
				err(`engram task create-batch failed: ${result.stderr}`);
			}
			return ok(result.stdout);
		},
	});

	// ── engram_task_update ────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_task_update",
		label: "Engram Task Update",
		description:
			"Update a task's status. Use 'in_progress' when starting work, 'done' with an outcome when complete, 'blocked' with a reason when stuck.",
		promptGuidelines: [
			"Set status to 'in_progress' when you begin working on a task.",
			"Set status to 'done' with --outcome when the task is complete.",
			"Set status to 'blocked' with --reason if you cannot continue — tell the next agent what they need.",
			"Never use --no-verify on git commit; validate via engram instead.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Task UUID to update" }),
			status: StringEnum(["todo", "in_progress", "done", "blocked", "cancelled"] as const, {
				description: "New task status",
			}),
			outcome: Type.Optional(Type.String({ description: "Outcome summary (use with status=done)" })),
			reason: Type.Optional(Type.String({ description: "Block reason (use with status=blocked)" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["task", "update", params.id, "--status", params.status];
			if (params.outcome) args.push("--outcome", params.outcome);
			if (params.reason) args.push("--reason", params.reason);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram task update failed: ${result.stderr}`);
			}
			return ok(result.stdout || `Task ${params.id} updated to ${params.status}`);
		},
	});

	// ── engram_task_show ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_task_show",
		label: "Engram Task Show",
		description: "Show full details of a specific engram task by UUID. Use after engram_ask returns a task UUID.",
		parameters: Type.Object({
			id: Type.String({ description: "Task UUID to show" }),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const result = await runEngram(["task", "show", params.id], repoCwd(params));
			if (result.code !== 0) {
				err(`engram task show failed: ${result.stderr}`);
			}
			return ok(result.stdout);
		},
	});

	// ── engram_task_list ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_task_list",
		label: "Engram Task List",
		description: "List engram tasks, optionally filtered by status or agent.",
		parameters: Type.Object({
			status: Type.Optional(
				StringEnum(["todo", "in_progress", "done", "blocked", "cancelled"] as const, {
					description: "Filter by status",
				}),
			),
			agent: Type.Optional(Type.String({ description: "Filter by assigned agent" })),
			limit: Type.Optional(Type.Integer({ description: "Max results to return" })),
			stale: Type.Optional(Type.Boolean({ description: "Show stale in-progress tasks (no recent git activity)" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["task", "list"];
			if (params.status) args.push("--status", params.status);
			if (params.agent) args.push("--agent", params.agent);
			if (params.limit) args.push("--limit", String(params.limit));
			if (params.stale) args.push("--stale");

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram task list failed: ${result.stderr}`);
			}
			return ok(result.stdout || "(no tasks found)");
		},
	});

	// ── engram_context_create ─────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_context_create",
		label: "Engram Context Create",
		description:
			"Store a finding, fact, observation, or artifact in engram. Always link to a task with engram_relationship_create immediately after.",
		promptGuidelines: [
			"Store raw facts, error logs, code snippets, and observations as context.",
			"Write findings IMMEDIATELY upon discovery — do not batch them.",
			"Always follow with engram_relationship_create to link to the task.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short descriptive title" }),
			content: Type.String({ description: "Full content — be specific, include error text or relevant output" }),
			source: Type.Optional(Type.String({ description: "Source file path, URL, or command that produced this" })),
			relevance: Type.Optional(
				StringEnum(["low", "medium", "high", "critical"] as const, { description: "Relevance level (default: medium)" }),
			),
			agent: Type.Optional(Type.String({ description: "Agent creating this context" })),
			tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["context", "create"];
			args.push("--title", params.title);
			args.push("--content", params.content);
			if (params.source) args.push("--source", params.source);
			if (params.relevance) args.push("--relevance", params.relevance);
			if (params.agent) args.push("--agent", params.agent);
			if (params.tags) args.push("--tags", params.tags);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram context create failed: ${result.stderr}`);
			}
			const uuid = parseUuid(result.stdout);
			return ok(result.stdout, { uuid });
		},
	});

	// ── engram_reasoning_create ───────────────────────────────────────────────

	pi.registerTool({
		name: "engram_reasoning_create",
		label: "Engram Reasoning Create",
		description:
			"Store reasoning, logic, or a decision chain linked to a task. Always follow with engram_relationship_create.",
		promptGuidelines: [
			"Store your interpretation, rationale, and logic chains as reasoning.",
			"Always provide --task-id to link reasoning to its parent task.",
			"Follow with engram_relationship_create to complete the link.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short reasoning title" }),
			task_id: Type.String({ description: "Task UUID this reasoning belongs to" }),
			content: Type.String({ description: "Your reasoning, logic, and conclusions" }),
			confidence: Type.Optional(Type.Number({ description: "Initial confidence level 0.0-1.0" })),
			agent: Type.Optional(Type.String({ description: "Agent creating this reasoning" })),
			tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["reasoning", "create"];
			args.push("--title", params.title);
			args.push("--task-id", params.task_id);
			args.push("--content", params.content);
			if (params.confidence !== undefined) args.push("--confidence", String(params.confidence));
			if (params.agent) args.push("--agent", params.agent);
			if (params.tags) args.push("--tags", params.tags);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram reasoning create failed: ${result.stderr}`);
			}
			const uuid = parseUuid(result.stdout);
			return ok(result.stdout, { uuid });
		},
	});

	// ── engram_adr_create ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_adr_create",
		label: "Engram ADR Create",
		description:
			"Record an architectural decision record. Use for technical choices with lasting impact. Always follow with engram_relationship_create.",
		promptGuidelines: [
			"Use ADRs for architectural choices that future agents need to understand.",
			"--number must be a sequential integer.",
			"--context should include the situation, options considered, and what was decided.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "ADR title" }),
			number: Type.Integer({ description: "Sequential ADR number" }),
			context: Type.String({
				description: "Context: the situation, options considered, and what was decided and why",
			}),
			agent: Type.Optional(Type.String({ description: "Agent making the decision" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["adr", "create"];
			args.push("--title", params.title);
			args.push("--number", String(params.number));
			args.push("--context", params.context);
			if (params.agent) args.push("--agent", params.agent);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram adr create failed: ${result.stderr}`);
			}
			const uuid = parseUuid(result.stdout);
			return ok(result.stdout, { uuid });
		},
	});

	// ── engram_relationship_create ────────────────────────────────────────────

	pi.registerTool({
		name: "engram_relationship_create",
		label: "Engram Relationship Create",
		description:
			"Link two engram entities. REQUIRED after every context/reasoning/ADR create — unlinked records are effectively lost.",
		promptGuidelines: [
			"ALWAYS run this immediately after creating any context, reasoning, or ADR.",
			"Common patterns: task→context (relates_to), task→reasoning (explains), task→adr (relates_to).",
			"Unlinked records cannot be found by graph traversal — they are lost.",
		],
		parameters: Type.Object({
			source_id: Type.String({ description: "Source entity UUID" }),
			source_type: StringEnum(["task", "context", "reasoning", "adr", "knowledge", "session"] as const, {
				description: "Source entity type",
			}),
			target_id: Type.String({ description: "Target entity UUID" }),
			target_type: StringEnum(["task", "context", "reasoning", "adr", "knowledge", "session"] as const, {
				description: "Target entity type",
			}),
			relationship_type: StringEnum(
				["depends_on", "relates_to", "explains", "contradicts", "blocks", "implements", "tests"] as const,
				{ description: "Relationship type" },
			),
			agent: Type.String({ description: "Agent creating the relationship" }),
			description: Type.Optional(Type.String({ description: "Optional description of the relationship" })),
			direction: Type.Optional(
				StringEnum(["unidirectional", "bidirectional", "inverse"] as const, {
					description: "Relationship direction (default: unidirectional)",
				}),
			),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["relationship", "create"];
			args.push("--source-id", params.source_id);
			args.push("--source-type", params.source_type);
			args.push("--target-id", params.target_id);
			args.push("--target-type", params.target_type);
			args.push("--relationship-type", params.relationship_type);
			args.push("--agent", params.agent);
			if (params.description) args.push("--description", params.description);
			if (params.direction) args.push("--direction", params.direction);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram relationship create failed: ${result.stderr}`);
			}
			return ok(result.stdout || "Relationship created");
		},
	});

	// ── engram_relationship_connected ─────────────────────────────────────────

	pi.registerTool({
		name: "engram_relationship_connected",
		label: "Engraph Relationship Connected",
		description:
			"Get all entities connected to a given entity via graph traversal. Use to pull context when starting work on a task or collecting subagent results.",
		parameters: Type.Object({
			entity_id: Type.String({ description: "Entity UUID to start traversal from" }),
			max_depth: Type.Optional(Type.Integer({ description: "Max traversal depth (default: 2)" })),
			algorithm: Type.Optional(
				StringEnum(["bfs", "dfs"] as const, { description: "Traversal algorithm (default: bfs)" }),
			),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["relationship", "connected", "--entity-id", params.entity_id];
			if (params.max_depth) args.push("--max-depth", String(params.max_depth));
			if (params.algorithm) args.push("--algorithm", params.algorithm);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram relationship connected failed: ${result.stderr}`);
			}
			return ok(result.stdout || "(no connected entities)");
		},
	});

	// ── engram_next ───────────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_next",
		label: "Engram Next",
		description:
			"Get the highest-priority next task/action. Use when unsure what to do next or after completing a task.",
		promptSnippet: "Get the next priority action from engram",
		parameters: Type.Object({
			parent: Type.Optional(Type.String({ description: "Scope to subtasks of a parent task" })),
			agent: Type.Optional(Type.String({ description: "Scope to tasks for a specific agent" })),
			session: Type.Optional(Type.String({ description: "Scope to tasks within a session" })),
			tag: Type.Optional(Type.String({ description: "Scope to tasks with a specific tag" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["next"];
			if (params.parent) args.push("--parent", params.parent);
			if (params.agent) args.push("--scope-agent", params.agent);
			if (params.session) args.push("--session", params.session);
			if (params.tag) args.push("--tag", params.tag);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0 && result.stderr) {
				err(`engram next failed: ${result.stderr}`);
			}
			return ok(result.stdout || "(no pending tasks)");
		},
	});

	// ── engram_validate ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_validate",
		label: "Engram Validate",
		description:
			"Run engram validation checks (hook status, workspace integrity). Must pass before marking tasks done.",
		parameters: Type.Object({
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const result = await runEngram(["validate", "check"], repoCwd(params));
			return ok(result.stdout, { passed: result.code === 0 });
		},
	});

	// ── engram_session_start ──────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_session_start",
		label: "Engram Session Start",
		description:
			"Start a named engram session. All subsequent engram activity is grouped under this session. Save the returned SESSION_ID for engram_session_end.",
		parameters: Type.Object({
			name: Type.String({ description: "Session name (format: <role>-<goal>)" }),
			auto_detect: Type.Optional(
				Type.Boolean({ description: "Auto-detect current task (default: false)" }),
			),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["session", "start", "--name", params.name];
			if (params.auto_detect) args.push("--auto-detect");

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram session start failed: ${result.stderr}`);
			}
			const sessionId = parseUuid(result.stdout);
			return ok(result.stdout, { session_id: sessionId });
		},
	});

	// ── engram_session_end ────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_session_end",
		label: "Engram Session End",
		description:
			"End an engram session and optionally generate a handoff summary. Always use --generate_summary so the next agent can pick up where you left off.",
		parameters: Type.Object({
			id: Type.String({ description: "Session ID (from engram_session_start)" }),
			generate_summary: Type.Boolean({ description: "Generate a handoff summary (recommended: true)" }),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["session", "end", "--id", params.id];
			if (params.generate_summary) args.push("--generate-summary");

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram session end failed: ${result.stderr}`);
			}
			return ok(result.stdout || "Session ended");
		},
	});

	// ── engram_sync_pull ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_sync_pull",
		label: "Engram Sync Pull",
		description: "Pull engram state from a remote. Run at session start to get the latest state from other agents.",
		parameters: Type.Object({
			remote: Type.String({ description: "Remote name (e.g. 'origin')" }),
			dry_run: Type.Optional(Type.Boolean({ description: "Show what would be pulled without pulling" })),
			branch: Type.Optional(Type.String({ description: "Branch to pull from" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["sync", "pull", "--remote", params.remote];
			if (params.dry_run) args.push("--dry-run");
			if (params.branch) args.push("--branch", params.branch);

			const result = await runEngram(args, { timeout: 60_000, ...repoCwd(params) });
			if (result.code !== 0 && !params.dry_run) {
				err(`engram sync pull failed: ${result.stderr}`);
			}
			return ok(result.stdout || "Pull complete");
		},
	});

	// ── engram_sync_push ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_sync_push",
		label: "Engram Sync Push",
		description: "Push engram state to a remote. Run at session end AFTER generating the session summary.",
		parameters: Type.Object({
			remote: Type.String({ description: "Remote name (e.g. 'origin')" }),
			dry_run: Type.Optional(Type.Boolean({ description: "Show what would be pushed without pushing" })),
			branch: Type.Optional(Type.String({ description: "Branch to push to" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["sync", "push", "--remote", params.remote];
			if (params.dry_run) args.push("--dry-run");
			if (params.branch) args.push("--branch", params.branch);

			const result = await runEngram(args, { timeout: 60_000, ...repoCwd(params) });
			if (result.code !== 0 && !params.dry_run) {
				err(`engram sync push failed: ${result.stderr}`);
			}
			return ok(result.stdout || "Push complete");
		},
	});

	// ── engram_sync_list_remotes ──────────────────────────────────────────────

	pi.registerTool({
		name: "engram_sync_list_remotes",
		label: "Engram Sync List Remotes",
		description: "List configured engram remotes. Use to check if a remote exists before sync pull/push.",
		parameters: Type.Object({
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const result = await runEngram(["sync", "list-remotes"], repoCwd(params));
			return ok(result.stdout || "(no remotes configured)");
		},
	});

	// ── engram_session_status ─────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_session_status",
		label: "Engram Session Status",
		description: "Check the current active engram session status.",
		parameters: Type.Object({
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const result = await runEngram(["session", "status"], repoCwd(params));
			if (result.code !== 0) {
				return ok("(no active session)");
			}
			return ok(result.stdout);
		},
	});

	// ── engram_session_list ───────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_session_list",
		label: "Engram Session List",
		description: "List all engram sessions. Use to find prior session summaries for handoff.",
		parameters: Type.Object({
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const result = await runEngram(["session", "list"], repoCwd(params));
			return ok(result.stdout || "(no sessions)");
		},
	});

	// ── engram_validate_commit ────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_validate_commit",
		label: "Engram Validate Commit",
		description:
			"Dry-run validate a commit message against engram rules (UUID present, task has context + reasoning). Run before committing to catch issues.",
		parameters: Type.Object({
			message: Type.String({ description: "Full commit message to validate" }),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["validate", "commit", "--message", params.message, "--dry-run"];
			const result = await runEngram(args, repoCwd(params));
			return ok(result.stdout, { passed: result.code === 0 });
		},
	});

	// ── engram_setup_agent ────────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_setup_agent",
		label: "Engram Setup Agent",
		description: "Register an agent profile with a role type and specialization for orchestrator discoverability.",
		parameters: Type.Object({
			name: Type.String({ description: "Agent name" }),
			agent_type: Type.String({
				description:
					"Agent type (e.g. orchestrator, coder, reviewer, tester, researcher, security-auditor, deployer, documenter)",
			}),
			specialization: Type.Optional(Type.String({ description: "Specialization details (e.g. 'Rust, actix-web, PostgreSQL')" })),
			repo_path: REPO_PATH_PARAM,
		}),
		async execute(_id, params) {
			const args = ["setup", "agent", "--name", params.name, "--agent-type", params.agent_type];
			if (params.specialization) args.push("--specialization", params.specialization);

			const result = await runEngram(args, repoCwd(params));
			if (result.code !== 0) {
				err(`engram setup agent failed: ${result.stderr}`);
			}
			return ok(result.stdout || `Agent '${params.name}' registered`);
		},
	});
}
