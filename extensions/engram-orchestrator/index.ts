/**
 * Engram Orchestrator — Pi-native orchestration with engram task tracking
 *
 * Provides:
 *   /orchestrate <goal>     — Create engram task hierarchy + spawn subagents
 *   /engram-dispatch <id>  — Dispatch a specific subtask to a subagent
 *   /engram-collect <id>   — Collect results from a completed subtask
 *
 * Spawns child pi processes with the engram-subagent-register skill injected
 * as system prompt. Each child works in an isolated context but shares the
 * same engram workspace, so task tracking and entity storage are unified.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function runEngram(
	args: string[],
	options?: { timeout?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const spawnOpts: Parameters<typeof execFileAsync>[2] = {
			maxBuffer: 2 * 1024 * 1024,
			timeout: options?.timeout ?? 15_000,
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

function parseUuid(output: string): string | null {
	const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
	return match ? match[0] : null;
}

function truncate(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (t.truncated) {
		return t.content + `\n[truncated: ${t.outputLines}/${t.totalLines} lines]`;
	}
	return t.content;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

// ─── Model Selection ─────────────────────────────────────────────────────────

interface FailoverEntry {
	provider: string;
	model: string;
	priority: number;
	label?: string;
}

interface ModelRoutingRule {
	tier: string;
	task_keywords: string[];
	agent_keywords: string[];
}

interface ModelRoutingConfig {
	tier_rules: ModelRoutingRule[];
	tier_priorities: Record<string, { prefer: number[]; fallback: number[] }>;
}

interface SelectedModel {
	provider: string;
	model: string;
	tier: string;
	label: string;
}

function loadFailoverEntries(cwd: string): FailoverEntry[] {
	const candidates = [
		path.join(cwd, ".pi", "failover.json"),
		path.join(os.homedir(), ".pi", "agent", "failover.json"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) {
			try {
				const raw = fs.readFileSync(p, "utf8");
				const parsed = JSON.parse(raw) as { models?: FailoverEntry[] };
				return parsed.models ?? [];
			} catch { /* ignore */ }
		}
	}
	return [];
}

function loadRoutingConfig(cwd: string): ModelRoutingConfig | null {
	const candidates = [
		path.join(cwd, ".pi", "model-routing.json"),
		path.join(os.homedir(), ".pi", "agent", "model-routing.json"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) {
			try {
				const raw = fs.readFileSync(p, "utf8");
				return JSON.parse(raw) as ModelRoutingConfig;
			} catch { /* ignore */ }
		}
	}
	return null;
}

function classifyTaskTier(
	taskTitle: string,
	agentHint: string,
	rules: ModelRoutingRule[],
): string {
	const text = `${taskTitle} ${agentHint}`.toLowerCase();
	for (const rule of rules) {
		const hit =
			rule.task_keywords.some((k) => text.includes(k.toLowerCase())) ||
			rule.agent_keywords.some((k) => text.includes(k.toLowerCase()));
		if (hit) return rule.tier;
	}
	return "standard";
}

/**
 * Select the most suitable available model for a task.
 * Reads .pi/model-routing.json for tier rules and .pi/failover.json for the
 * priority-ordered model list. Returns the first model in the appropriate
 * tier that has a configured API key.
 */
function selectModelForTask(
	taskTitle: string,
	agentHint: string,
	ctx: ExtensionContext,
	cwd: string,
): SelectedModel | null {
	const entries = loadFailoverEntries(cwd);
	if (entries.length === 0) return null;

	const sorted = [...entries].sort((a, b) => a.priority - b.priority);
	const routing = loadRoutingConfig(cwd);

	let tier = "standard";
	let priorityOrder: number[];

	if (routing) {
		tier = classifyTaskTier(taskTitle, agentHint, routing.tier_rules);
		const tierCfg = routing.tier_priorities[tier] ?? { prefer: [1, 2, 3], fallback: [4, 5, 6, 7] };
		priorityOrder = [...tierCfg.prefer, ...tierCfg.fallback];
	} else {
		priorityOrder = sorted.map((e) => e.priority);
	}

	for (const p of priorityOrder) {
		const entry = sorted.find((m) => m.priority === p);
		if (!entry) continue;
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
		return {
			provider: entry.provider,
			model: entry.model,
			tier,
			label: entry.label ?? `${entry.provider}/${entry.model}`,
		};
	}

	// Last resort: any available model
	for (const entry of sorted) {
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
		return {
			provider: entry.provider,
			model: entry.model,
			tier,
			label: entry.label ?? `${entry.provider}/${entry.model}`,
		};
	}

	return null;
}

// ─── Subagent Spawning ────────────────────────────────────────────────────────

interface SubagentResult {
	taskId: string;
	agentName: string;
	exitCode: number;
	output: string;
	stderr: string;
	duration: number; // ms
	model?: SelectedModel;
}

/** Build the system prompt that makes a child pi process follow engram protocol. */
function buildSubagentSystemPrompt(taskId: string): string {
	return [
		"You are a subagent working on an engram-tracked task.",
		"",
		"## Your Task",
		`Your task UUID is: ${taskId}`,
		"Run `engram_task_show` with this ID to get your full instructions.",
		"Run `engram_relationship_connected` to pull all linked context.",
		"",
		"## Protocol",
		"1. Claim the task: `engram_task_update` status=in_progress",
		"2. Pull context: `engram_relationship_connected` on your task UUID",
		"3. Store EVERY finding immediately with `engram_context_create` + `engram_relationship_create`",
		"4. Store reasoning with `engram_reasoning_create` + `engram_relationship_create`",
		"5. When done, write a completion report as reasoning, then `engram_task_update` status=done",
		"",
		"## Critical Rules",
		"- NEVER batch findings. Write each one to engram immediately upon discovery.",
		"- ALWAYS link every entity you create with `engram_relationship_create`.",
		"- Store your completion report as reasoning linked to the task before marking done.",
		"- The orchestrator will collect your results via `engram_relationship_connected`.",
	].join("\n");
}

/** Write a prompt to a temp file and return the path. */
async function writePromptFile(content: string): Promise<string> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-engram-"));
	const filePath = path.join(tmpDir, "system-prompt.md");
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

/** Resolve the pi binary path. */
function getPiCommand(): string {
	// Try to find pi in PATH
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		// We're running as an extension loaded by pi
		const execName = path.basename(process.execPath).toLowerCase();
		if (/^(node|bun)(\.exe)?$/.test(execName)) {
			return "pi";
		}
		return process.execPath;
	}
	return "pi";
}

/** Spawn a child pi process for a subagent task. */
async function spawnSubagent(
	taskId: string,
	taskTitle: string,
	cwd: string,
	signal: AbortSignal | undefined,
	modelSelection?: SelectedModel,
): Promise<SubagentResult> {
	const startTime = Date.now();
	const promptContent = buildSubagentSystemPrompt(taskId);
	const promptFile = await writePromptFile(promptContent);

	const args = [
		"--mode", "json",
		...(modelSelection ? ["--model", `${modelSelection.provider}/${modelSelection.model}`] : []),
		"-p",
		"--no-session",
		"--append-system-prompt", promptFile,
		`Complete this task using engram for all tracking:\n\nTask UUID: ${taskId}\nTask: ${taskTitle}\n\nFollow the engram subagent protocol: claim the task, pull context, store findings immediately, write a completion report, and mark done.`,
	];

	const result: SubagentResult = {
		taskId,
		agentName: "subagent",
		exitCode: -1,
		output: "",
		stderr: "",
		duration: 0,
		model: modelSelection,
	};

	try {
		const command = getPiCommand();
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(command, args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdoutBuf = "";
			let lastAssistantText = "";

			proc.stdout.on("data", (data) => {
				stdoutBuf += data.toString();
				// Parse JSON events to extract the final assistant text
				const lines = stdoutBuf.split("\n");
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message) {
							const msg = event.message;
							if (msg.role === "assistant") {
								for (const part of msg.content) {
									if (part.type === "text") {
										lastAssistantText = part.text;
									}
								}
							}
						}
					} catch {
						// Not JSON, ignore
					}
				}
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}

			result.output = lastAssistantText;
		});

		result.exitCode = exitCode;
	} finally {
		// Clean up temp file
		try {
			await fs.promises.unlink(promptFile);
			await fs.promises.rmdir(path.dirname(promptFile));
		} catch {
			// ignore
		}
	}

	result.duration = Date.now() - startTime;
	return result;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── /orchestrate command ───────────────────────────────────────────────

	pi.registerCommand("orchestrate", {
		description: "Create an engram task hierarchy and orchestrate subagents to complete the goal",
		getArgumentCompletions: (prefix: string) => {
			// No special completions — free text goal
			return null;
		},
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /orchestrate <goal description>", "warning");
				return;
			}

			const goal = args.trim();
			ctx.ui.setStatus("engram-orch", "planning...");
			ctx.ui.notify(`Planning: ${goal}`, "info");

			// Step 1: Search for prior context
			const searchResult = await runEngram(["ask", "query", goal]);
			if (searchResult.code === 0 && searchResult.stdout) {
				ctx.ui.notify(`Prior context found — ${searchResult.stdout.split("\n").length} lines`, "info");
			}

			// Step 2: Create parent task
			const parentResult = await runEngram(["task", "create", "--title", `Goal: ${goal}`, "--priority", "high", "--output", "json"]);
			if (parentResult.code !== 0) {
				ctx.ui.notify(`Failed to create parent task: ${parentResult.stderr}`, "error");
				ctx.ui.setStatus("engram-orch", undefined);
				return;
			}
			const parentUuid = parseUuid(parentResult.stdout);
			if (!parentUuid) {
				ctx.ui.notify("Failed to parse parent task UUID", "error");
				ctx.ui.setStatus("engram-orch", undefined);
				return;
			}

			await runEngram(["task", "update", parentUuid, "--status", "in_progress"]);
			ctx.ui.notify(`Parent task: ${parentUuid}`, "info");

			// Step 3: Store the orchestration plan as context
			await runEngram([
				"context", "create",
				"--title", `Orchestration plan: ${goal}`,
				"--content", `## Goal\n${goal}\n\n## Parent Task\n${parentUuid}\n\n## Subtasks\n(to be created by orchestrator)\n\n## Status\nPlanning`,
				"--source", "orchestration-plan",
			]);

			// Step 4: Ask the LLM to plan and dispatch
			// We inject a message that tells the agent to create subtasks and dispatch
			pi.sendUserMessage(
				[
					`I've created parent task ${parentUuid} for: "${goal}"`,
					"",
					"Prior context from engram:",
					searchResult.stdout || "(none)",
					"",
					"Please:",
					"1. Review the prior context above",
					"2. Break this goal into 2-4 subtasks using `engram_task_create` with `--parent ${parentUuid}`",
					"3. Store detailed instructions for each subtask as context linked to it",
					"4. When ready, I'll dispatch subagents for each subtask",
					"",
					"Use `engram_task_create`, `engram_context_create`, and `engram_relationship_create` to build the hierarchy.",
				].join("\n"),
				{ deliverAs: "steer" },
			);

			ctx.ui.setStatus("engram-orch", `parent: ${parentUuid.slice(0, 8)}`);
		},
	});

	// ── /engram-dispatch command ───────────────────────────────────────────

	pi.registerCommand("engram-dispatch", {
		description: "Spawn a subagent for a specific engram task (by UUID)",
		getArgumentCompletions: (prefix: string) => {
			// Could query engram for in_progress tasks, but keep it simple
			return null;
		},
		handler: async (args, ctx) => {
			const taskId = args?.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /engram-dispatch <task-uuid>", "warning");
				return;
			}

			// Validate the task exists
			const showResult = await runEngram(["task", "show", taskId]);
			if (showResult.code !== 0) {
				ctx.ui.notify(`Task not found: ${showResult.stderr}`, "error");
				return;
			}

			// Extract title from output
			const titleMatch = showResult.stdout.match(/Title:\s*(.+)/i);
			const taskTitle = titleMatch ? titleMatch[1].trim() : taskId;

			// Select the best model for this task
			const cmdMs = selectModelForTask(taskTitle, "", ctx, ctx.cwd);
			const cmdModelInfo = cmdMs ? ` via ${cmdMs.label} [${cmdMs.tier}]` : "";
			ctx.ui.setStatus("engram-orch", `dispatching ${taskId.slice(0, 8)}...`);
			ctx.ui.notify(`Dispatching subagent for: ${taskTitle}${cmdModelInfo}`, "info");

			// Spawn the subagent
			const result = await spawnSubagent(taskId, taskTitle, ctx.cwd, ctx.signal, cmdMs ?? undefined);

			const duration = (result.duration / 1000).toFixed(1);
			if (result.exitCode === 0) {
				ctx.ui.notify(
					`✓ Subagent completed for ${taskId.slice(0, 8)} (${duration}s)`,
					"success",
				);
			} else {
				ctx.ui.notify(
					`✗ Subagent failed for ${taskId.slice(0, 8)} (exit ${result.exitCode}, ${duration}s): ${result.stderr.slice(0, 200)}`,
					"error",
				);
			}

			// Collect results from engram
			const connectedResult = await runEngram(["relationship", "connected", "--entity-id", taskId, "--max-depth", "2"]);
			if (connectedResult.code === 0 && connectedResult.stdout) {
				ctx.ui.notify(`Connected entities: ${connectedResult.stdout.split("\n").length} lines`, "info");
			}

			// Inject results as a follow-up for the orchestrator to review
			pi.sendUserMessage(
				[
					`Subagent result for task ${taskId} (${taskTitle}):`,
					`Exit code: ${result.exitCode} | Duration: ${duration}s`,
					result.exitCode === 0 ? "Status: COMPLETED" : `Status: FAILED\nStderr: ${result.stderr.slice(0, 500)}`,
					"",
					"Connected engram entities:",
					connectedResult.stdout || "(none)",
					"",
					"Review the results and decide: mark done, re-dispatch, or create follow-up tasks.",
				].join("\n"),
				{ deliverAs: "followUp" },
			);

			ctx.ui.setStatus("engram-orch", undefined);
		},
	});

	// ── /engram-dispatch-parallel command ────────────────────────────────

	pi.registerCommand("engram-dispatch-parallel", {
		description: "Spawn subagents for multiple task UUIDs in parallel (space-separated)",
		handler: async (args, ctx) => {
			const taskIds = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			if (taskIds.length === 0) {
				ctx.ui.notify("Usage: /engram-dispatch-parallel <uuid1> <uuid2> ...", "warning");
				return;
			}
			if (taskIds.length > 8) {
				ctx.ui.notify("Max 8 parallel tasks", "warning");
				return;
			}

			ctx.ui.notify(`Dispatching ${taskIds.length} subagents in parallel...`, "info");
			ctx.ui.setStatus("engram-orch", `parallel: ${taskIds.length} tasks`);

			// Resolve task titles
			const tasks: Array<{ id: string; title: string }> = [];
			for (const id of taskIds) {
				const show = await runEngram(["task", "show", id]);
				const titleMatch = show.stdout.match(/Title:\s*(.+)/i);
				tasks.push({ id, title: titleMatch ? titleMatch[1].trim() : id });
			}

			// Spawn all in parallel (max 4 concurrent)
			const MAX_CONCURRENT = 4;
			let nextIndex = 0;
			const results: SubagentResult[] = [];

			const workers = Array.from({ length: Math.min(MAX_CONCURRENT, tasks.length) }, async () => {
				while (nextIndex < tasks.length) {
					const idx = nextIndex++;
					const task = tasks[idx];
					ctx.ui.setStatus("engram-orch", `parallel: ${idx + 1}/${tasks.length} — ${task.id.slice(0, 8)}`);
					const pms = selectModelForTask(task.title, "", ctx, ctx.cwd);
					const result = await spawnSubagent(task.id, task.title, ctx.cwd, ctx.signal, pms ?? undefined);
					results.push(result);
				}
			});

			await Promise.all(workers);

			// Report results
			const succeeded = results.filter((r) => r.exitCode === 0).length;
			const failed = results.length - succeeded;
			ctx.ui.notify(
				`Parallel dispatch complete: ${succeeded}/${results.length} succeeded, ${failed} failed`,
				succeeded === results.length ? "success" : "warning",
			);

			// Collect all results
			const summaries: string[] = [];
			for (const result of results) {
				const duration = (result.duration / 1000).toFixed(1);
				const icon = result.exitCode === 0 ? "✓" : "✗";
				summaries.push(`${icon} ${result.taskId.slice(0, 8)}: ${result.exitCode === 0 ? "completed" : "failed"} (${duration}s)`);

				// Pull connected entities
				const connected = await runEngram(["relationship", "connected", "--entity-id", result.taskId, "--max-depth", "1"]);
				if (connected.code === 0 && connected.stdout) {
					summaries.push(`  Entities: ${connected.stdout.split("\n").length} linked`);
				}
			}

			pi.sendUserMessage(
				[
					`Parallel dispatch results (${succeeded}/${results.length} succeeded):`,
					"",
					...summaries,
					"",
					"Review the results. Use `engram_task_update` to close completed tasks or re-dispatch failures.",
				].join("\n"),
				{ deliverAs: "followUp" },
			);

			ctx.ui.setStatus("engram-orch", undefined);
		},
	});

	// ── /engram-collect command ───────────────────────────────────────────

	pi.registerCommand("engram-collect", {
		description: "Collect and display all connected entities for a task",
		handler: async (args, ctx) => {
			const taskId = args?.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /engram-collect <task-uuid>", "warning");
				return;
			}

			const result = await runEngram(["relationship", "connected", "--entity-id", taskId, "--max-depth", "2"]);
			if (result.code !== 0) {
				ctx.ui.notify(`Failed: ${result.stderr}`, "error");
				return;
			}

			if (result.stdout) {
				// Inject as follow-up so the LLM can review
				pi.sendUserMessage(
					`Connected entities for task ${taskId}:\n\n${truncate(result.stdout)}`,
					{ deliverAs: "followUp" },
				);
			} else {
				ctx.ui.notify("No connected entities found", "info");
			}
		},
	});

	// ── /engram-review command ────────────────────────────────────────────

	pi.registerCommand("engram-review", {
		description: "Run `engram validate` and show task hierarchy status for a parent task",
		handler: async (args, ctx) => {
			const parentIds = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			if (parentIds.length === 0) {
				ctx.ui.notify("Usage: /engram-review <parent-task-uuid>", "warning");
				return;
			}

			const parts: string[] = [];

			// Validate
			const validateResult = await runEngram(["validate", "check"]);
			parts.push(`Validation: ${validateResult.code === 0 ? "✅ PASS" : "❌ FAIL"}`);
			if (validateResult.code !== 0) {
				parts.push(validateResult.stderr);
			}

			// For each parent, show connected tasks
			for (const parentId of parentIds) {
				const show = await runEngram(["task", "show", parentId]);
				if (show.code !== 0) {
					parts.push(`\nTask ${parentId}: not found`);
					continue;
				}

				const titleMatch = show.stdout.match(/Title:\s*(.+)/i);
				parts.push(`\n📊 ${titleMatch?.[1]?.trim() ?? parentId} (${parentId})`);

				const connected = await runEngram(["relationship", "connected", "--entity-id", parentId, "--max-depth", "1"]);
				if (connected.code === 0 && connected.stdout) {
					parts.push(truncate(connected.stdout));
				}

				// List in-progress tasks
				const inProgress = await runEngram(["task", "list", "--status", "in_progress"]);
				if (inProgress.code === 0 && inProgress.stdout) {
					parts.push(`\nIn-progress tasks:\n${inProgress.stdout}`);
				}
			}

			ctx.ui.notify(parts.join("\n"), "info");
		},
	});

	// ── Tool: engram_dispatch ─────────────────────────────────────────────
	//
	// Register as a tool so the LLM can dispatch subagents directly
	// when the orchestrator skill is loaded.

	pi.registerTool({
		name: "engram_dispatch",
		label: "Engram Dispatch",
		description:
			"Spawn a child pi process as a subagent for an engram task. The child follows the engram subagent protocol: claims the task, pulls context, stores findings, and reports back. Use for delegating work to isolated agents.",
		parameters: Type.Object({
			task_id: Type.String({ description: "Engram task UUID to dispatch" }),
			mode: Type.Optional(
				StringEnum(["single", "parallel"] as const, {
					description: "Dispatch mode: single (one task) or parallel (space-separated UUIDs in task_id)",
				}),
			),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use (e.g. '/home/user/project/agentic-repos'). Omit to use the current workspace.",
			})),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.mode === "parallel") {
				const parallelCwd = (params as { repo_path?: string }).repo_path ?? ctx.cwd;
				const parallelCwdOpt = parallelCwd !== ctx.cwd ? { cwd: parallelCwd } : {};
				const taskIds = params.task_id.trim().split(/\s+/).filter(Boolean);
				if (taskIds.length > 8) {
					throw new Error("Max 8 parallel tasks");
				}

				const tasks: Array<{ id: string; title: string }> = [];
				for (const id of taskIds) {
					const show = await runEngram(["task", "show", id], parallelCwdOpt);
					const titleMatch = show.stdout.match(/Title:\s*(.+)/i);
					tasks.push({ id, title: titleMatch ? titleMatch[1].trim() : id });
				}

				onUpdate?.({
					content: [{ type: "text", text: `Dispatching ${tasks.length} subagents in parallel...` }],
					details: { mode: "parallel", total: tasks.length, completed: 0 },
				});

				const MAX_CONCURRENT = 4;
				let nextIndex = 0;
				const results: SubagentResult[] = [];

				const workers = Array.from({ length: Math.min(MAX_CONCURRENT, tasks.length) }, async () => {
					while (nextIndex < tasks.length) {
						const idx = nextIndex++;
						const task = tasks[idx];
						const ms = selectModelForTask(task.title, "", ctx, parallelCwd);
						const result = await spawnSubagent(task.id, task.title, parallelCwd, signal, ms ?? undefined);
						results.push(result);
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Parallel: ${results.length}/${tasks.length} done — ${result.taskId.slice(0, 8)} ${result.exitCode === 0 ? "✓" : "✗"}${ms ? ` [${ms.tier}]` : ""}`,
								},
							],
							details: { mode: "parallel", total: tasks.length, completed: results.length },
						});
					}
				});

				await Promise.all(workers);

				const succeeded = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const icon = r.exitCode === 0 ? "✓" : "✗";
					const duration = (r.duration / 1000).toFixed(1);
					return `${icon} ${r.taskId.slice(0, 8)} (${duration}s)`;
				});

				return {
					content: [
						{
							type: "text",
							text: `Parallel dispatch: ${succeeded}/${results.length} succeeded\n\n${summaries.join("\n")}`,
						},
					],
					details: { mode: "parallel", results: results.map((r) => ({ taskId: r.taskId, exitCode: r.exitCode, duration: r.duration })) },
				};
			}

			// Single mode
			const dispatchCwd = (params as { repo_path?: string }).repo_path ?? ctx.cwd;
			const dispatchCwdOpt = dispatchCwd !== ctx.cwd ? { cwd: dispatchCwd } : {};
			const showResult = await runEngram(["task", "show", params.task_id], dispatchCwdOpt);
			if (showResult.code !== 0) {
				throw new Error(`Task not found: ${showResult.stderr}`);
			}
			const titleMatch = showResult.stdout.match(/Title:\s*(.+)/i);
			const taskTitle = titleMatch ? titleMatch[1].trim() : params.task_id;

			// Select the best model for this task
			const modelSel = selectModelForTask(taskTitle, "", ctx, dispatchCwd);
			const modelInfo = modelSel ? ` via ${modelSel.label} [${modelSel.tier}]` : "";

			onUpdate?.({
				content: [{ type: "text", text: `Dispatching subagent for: ${taskTitle}${modelInfo}...` }],
				details: { mode: "single", taskId: params.task_id, model: modelSel?.label, tier: modelSel?.tier },
			});

			const result = await spawnSubagent(params.task_id, taskTitle, dispatchCwd, signal, modelSel ?? undefined);

			const duration = (result.duration / 1000).toFixed(1);
			const statusText = result.exitCode === 0 ? "COMPLETED" : `FAILED (exit ${result.exitCode})`;

			// Collect connected entities
			const connectedResult = await runEngram([
				"relationship", "connected",
				"--entity-id", params.task_id,
				"--max-depth", "2",
			], dispatchCwdOpt);

			return {
				content: [
					{
						type: "text",
						text: [
							`Subagent ${statusText} for ${params.task_id.slice(0, 8)} (${duration}s)`,
							modelSel ? `Model: ${modelSel.label} [tier: ${modelSel.tier}]` : "",
							"",
							"Connected entities:",
							connectedResult.stdout || "(none)",
						].filter(Boolean).join("\n"),
					},
				],
				details: {
					mode: "single",
					taskId: params.task_id,
					exitCode: result.exitCode,
					duration: result.duration,
					model: modelSel ?? null,
					connectedEntities: connectedResult.stdout,
				},
			};
		},
	});

	// ── /engram-auto command ───────────────────────────────────────────────
	//
	// Continuous autonomous task processing loop.
	// Polls engram for pending tasks, dispatches subagents, collects results,
	// and repeats until the queue is empty. Fully interruptible via Ctrl+C.

	interface AutoModeConfig {
		parent?: string; // Scope to subtasks of this parent
		maxRetries: number; // Re-dispatch failed tasks up to N times (default: 2)
		pollInterval: number; // Seconds between queue polls when empty (default: 5)
		dryRun: boolean; // Show what would be dispatched without running (default: false)
		cwd?: string; // Repo path override for engram commands and subagent spawning
	}

	interface AutoModeStats {
		completed: number;
		failed: number;
		blocked: number;
		retried: number;
		totalDuration: number; // ms
		tasks: AutoModeTaskRecord[];
	}

	interface AutoModeTaskRecord {
		id: string;
		title: string;
		status: "completed" | "failed" | "blocked";
		duration: number; // ms
		attempts: number;
	}

	/** Extract the first UUID from text that looks like an engram task reference. */
	function extractTaskUuid(text: string): string | null {
		const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
		return match ? match[0] : null;
	}

	/** Parse engram next output to find the suggested task UUID. */
	function parseNextTaskUuid(nextOutput: string): string | null {
		// engram next outputs markdown with task references
		// Try UUID patterns first
		const uuid = extractTaskUuid(nextOutput);
		if (uuid) return uuid;
		return null;
	}

	/** Query engram for the next todo task. Returns null if queue is empty. */
	async function getNextTask(config: AutoModeConfig): Promise<{ id: string; title: string } | null> {
		const cwdOpt = config.cwd ? { cwd: config.cwd } : {};
		// First try engram next
		const nextResult = await runEngram(["next", "--format", "json", "--json"], cwdOpt);
		if (nextResult.code === 0) {
			// Try to parse JSON output
			try {
				const parsed = JSON.parse(nextResult.stdout);
				if (parsed.id) {
					return { id: parsed.id, title: parsed.title || parsed.id };
				}
			} catch {
				// Not JSON, try regex
				const uuid = parseNextTaskUuid(nextResult.stdout);
				if (uuid) {
					// Fetch the title
					const show = await runEngram(["task", "show", uuid], cwdOpt);
					const titleMatch = show.stdout.match(/Title:\s*(.+)/i);
					return { id: uuid, title: titleMatch ? titleMatch[1].trim() : uuid };
				}
			}
		}

		// Fallback: list todo tasks directly
		const listArgs = ["task", "list", "--status", "todo", "--output", "json", "--limit", "1"];
		if (config.parent) listArgs.push("--parent", config.parent);

		const listResult = await runEngram(listArgs, cwdOpt);
		if (listResult.code !== 0 || !listResult.stdout || listResult.stdout.includes("No tasks")) {
			return null;
		}

		try {
			// Output may be NDJSON
			const firstLine = listResult.stdout.split("\n")[0];
			const parsed = JSON.parse(firstLine);
			if (parsed.id) {
				return { id: parsed.id, title: parsed.title || parsed.id };
			}
		} catch {
			// Try regex on raw output
			const uuid = extractTaskUuid(listResult.stdout);
			if (uuid) {
				const show = await runEngram(["task", "show", uuid], cwdOpt);
				const titleMatch = show.stdout.match(/Title:\s*(.+)/i);
				return { id: uuid, title: titleMatch ? titleMatch[1].trim() : uuid };
			}
		}

		return null;
	}

	/** Count remaining todo tasks (for status display). */
	async function countRemainingTasks(config: AutoModeConfig): Promise<number> {
		const listArgs = ["task", "list", "--status", "todo"];
		if (config.parent) listArgs.push("--parent", config.parent);
		const cwdOpt = config.cwd ? { cwd: config.cwd } : {};
		const result = await runEngram(listArgs, cwdOpt);
		if (result.code !== 0 || result.stdout.includes("No tasks")) return 0;

		// Count non-empty lines (table rows)
		const lines = result.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("─") && !l.startsWith("│") && !l.startsWith("├") && !l.startsWith("╭") && !l.startsWith("╰"));
		return Math.max(0, lines.length - 1); // subtract header
	}

	/** Sleep with abort support. */
	function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) { resolve(); return; }
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
		});
	}

	/** Format a duration in human-readable form. */
	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
	}

	/** Persist auto mode stats to session for recovery on reload. */
	const AUTO_STATS_KEY = "engram:auto-mode-stats";

	function persistAutoStats(stats: AutoModeStats) {
		pi.appendEntry(AUTO_STATS_KEY, { ...stats, timestamp: Date.now() });
	}

	function restoreAutoStats(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): AutoModeStats | null {
		for (let i = ctx.sessionManager.getEntries().length - 1; i >= 0; i--) {
			const entry = ctx.sessionManager.getEntries()[i];
			if (entry.type === "custom" && entry.customType === AUTO_STATS_KEY) {
				return entry.data as AutoModeStats;
			}
		}
		return null;
	}

	let autoModeRunning = false;

	pi.registerCommand("engram-auto", {
		description: "Start autonomous task processing loop — continuously dispatches subagents until the engram task queue is empty",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "", label: "Process all pending tasks" },
				{ value: "--dry-run", label: "Show what would be processed (no execution)" },
				{ value: "--max-retries 0", label: "No retries on failure" },
				{ value: "--max-retries 3", label: "Up to 3 retries per task" },
				{ value: "--parent", label: "Scope to subtasks of a parent UUID" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (autoModeRunning) {
				ctx.ui.notify("Auto mode is already running. Use /engram-auto-stop to halt.", "warning");
				return;
			}

			// Parse arguments
			const argParts = args?.trim().split(/\s+/) ?? [];
			const config: AutoModeConfig = {
				maxRetries: 2,
				pollInterval: 5,
				dryRun: false,
			};

			for (let i = 0; i < argParts.length; i++) {
				switch (argParts[i]) {
					case "--dry-run":
						config.dryRun = true;
						break;
					case "--max-retries":
						config.maxRetries = parseInt(argParts[++i]) || 0;
						break;
					case "--parent":
						config.parent = argParts[++i];
						break;
					case "--poll":
						config.pollInterval = parseInt(argParts[++i]) || 5;
						break;
			}
			}

			autoModeRunning = true;
			const stats: AutoModeStats = {
				completed: 0,
				failed: 0,
				blocked: 0,
				retried: 0,
				totalDuration: 0,
				tasks: [],
			};
			const loopStart = Date.now();
			const retryMap = new Map<string, number>(); // taskId -> attempt count

			const scopeLabel = config.parent ? `parent ${config.parent.slice(0, 8)}` : "all tasks";
			ctx.ui.notify(
				`🤖 Auto mode started — ${scopeLabel}, max ${config.maxRetries} retries${config.dryRun ? " (DRY RUN)" : ""}`,
				"info",
			);
			ctx.ui.setStatus("engram-auto", "starting...");

			try {
				// Main loop
				while (autoModeRunning) {
					// Check for abort
					if (ctx.signal?.aborted) {
						ctx.ui.notify("Auto mode: aborting...", "warning");
						break;
					}

					// Find next task
					const task = await getNextTask(config);

					if (!task) {
						// Queue empty — poll and wait
						const remaining = await countRemainingTasks(config);
						if (remaining === 0) {
							// Also check for in_progress tasks that might be stranded
							const ipResult = await runEngram(["task", "list", "--status", "in_progress"]);
							const hasInProgress = ipResult.code === 0 && !ipResult.stdout.includes("No tasks");

							if (!hasInProgress) {
								// Truly empty — exit
								ctx.ui.setStatus("engram-auto", "queue empty");
								ctx.ui.notify(
									`🤖 Auto mode complete — queue empty. ${stats.completed} done, ${stats.failed} failed, ${stats.blocked} blocked in ${formatDuration(Date.now() - loopStart)}`,
										"success",
									);
								break;
							}

							// There are in-progress tasks — wait for them to clear
							ctx.ui.setStatus("engram-auto", `waiting: ${remaining} todo, in-progress tasks exist`);
							await sleep(config.pollInterval * 1000, ctx.signal);
							continue;
						}

						// Tasks exist but engram next didn't return one — list directly
						ctx.ui.setStatus("engram-auto", `polling: ${remaining} remaining`);
						await sleep(config.pollInterval * 1000, ctx.signal);
						continue;
					}

					const attempt = retryMap.get(task.id) ?? 0;
					const remaining = await countRemainingTasks(config);

					// Dry run — just report
					if (config.dryRun) {
						ctx.ui.notify(`[DRY] Would dispatch: ${task.title} (${task.id.slice(0, 8)})`, "info");
						// Mark as done in dry run so we move to next
						await runEngram(["task", "update", task.id, "--status", "done", "--outcome", "(dry run)"]);
						stats.completed++;
						stats.tasks.push({ id: task.id, title: task.title, status: "completed", duration: 0, attempts: 1 });
						continue;
					}

					// Update status
					const attemptLabel = attempt > 0 ? ` (attempt ${attempt + 1}/${config.maxRetries + 1})` : "";
					ctx.ui.setStatus(
						"engram-auto",
						`${stats.completed}✓ ${stats.failed}✗ ${stats.blocked}⛔ | ${remaining} left | ${task.title.slice(0, 30)}${attemptLabel}`,
					);

					// Dispatch subagent
					const autoMs = selectModelForTask(task.title, "", ctx, ctx.cwd);
					const autoModelInfo = autoMs ? ` via ${autoMs.label} [${autoMs.tier}]` : "";
					ctx.ui.notify(`Dispatching: ${task.title}${attemptLabel}${autoModelInfo}`, "info");

					const result = await spawnSubagent(task.id, task.title, ctx.cwd, ctx.signal, autoMs ?? undefined);
					const duration = result.duration;

					if (result.exitCode === 0) {
						// Success
						stats.completed++;
						stats.totalDuration += duration;
						stats.tasks.push({ id: task.id, title: task.title, status: "completed", duration, attempts: attempt + 1 });
						retryMap.delete(task.id);

						ctx.ui.notify(
							`✓ ${task.title.slice(0, 40)} (${formatDuration(duration)})`,
							"success",
						);

						// Collect and display connected entities briefly
						const connected = await runEngram(["relationship", "connected", "--entity-id", task.id, "--max-depth", "1"]);
						if (connected.code === 0 && connected.stdout) {
							const entityLines = connected.stdout.split("\n").filter((l) => l.trim()).length;
							ctx.ui.setStatus(
								"engram-auto",
								`${stats.completed}✓ ${stats.failed}✗ ${stats.blocked}⛔ | ${remaining - 1} left | ✓ ${entityLines} entities linked`,
							);
						}
					} else {
						// Failure
						const retryCount = attempt + 1;

						if (retryCount <= config.maxRetries) {
							// Retry
							retryMap.set(task.id, retryCount);
							stats.retried++;
							ctx.ui.notify(
								`✗ ${task.title.slice(0, 40)} — retrying (${retryCount}/${config.maxRetries})`,
								"warning",
							);
							// Reset task to todo so engram next picks it up again
							await runEngram(["task", "update", task.id, "--status", "todo"]);
							// Brief pause before retry
							await sleep(2000, ctx.signal);
						} else {
							// Max retries exceeded — block the task
							const failReason = result.stderr
								.slice(0, 300)
								.replace(/\n/g, " ");
							await runEngram([
								"task", "update", task.id,
								"--status", "blocked",
								"--reason", `Auto mode: failed after ${retryCount} attempts. Last error: ${failReason}`,
							]);
							stats.failed++;
							stats.tasks.push({ id: task.id, title: task.title, status: "failed", duration, attempts: retryCount });
							retryMap.delete(task.id);

							ctx.ui.notify(
								`⛔ ${task.title.slice(0, 40)} — blocked after ${retryCount} attempts`,
								"error",
							);
						}
					}

					// Persist stats periodically
					persistAutoStats(stats);
				}
			} finally {
				autoModeRunning = false;
				ctx.ui.setStatus("engram-auto", undefined);

				// Final summary
				const elapsed = Date.now() - loopStart;
				const summary = [
					`🤖 Auto mode stopped after ${formatDuration(elapsed)}`,
					`   ${stats.completed} completed`,
					`   ${stats.failed} failed`,
					`   ${stats.blocked} blocked`,
					`   ${stats.retried} retried`,
					`   Total task time: ${formatDuration(stats.totalDuration)}`,
				];

				if (stats.tasks.length > 0) {
					summary.push("");
					summary.push("Task log:");
					for (const t of stats.tasks) {
						const icon = t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : "⛔";
						summary.push(`  ${icon} ${t.title.slice(0, 50)} (${formatDuration(t.duration)}, ${t.attempts} attempt${t.attempts > 1 ? "s" : ""})`);
					}
				}

				// Inject summary as follow-up so the LLM can review
				pi.sendUserMessage(summary.join("\n"), { deliverAs: "followUp" });

				// Run final validation
				const validateResult = await runEngram(["validate", "check"]);
				if (validateResult.code === 0) {
					ctx.ui.notify("Validation: ✅ PASS", "success");
				} else {
					ctx.ui.notify("Validation: ❌ FAIL — review blocked tasks", "error");
				}

				persistAutoStats(stats);
			}
		},
	});

	// ── /engram-auto-stop command ──────────────────────────────────────────

	pi.registerCommand("engram-auto-stop", {
		description: "Stop the running auto mode loop",
		handler: async (_args, ctx) => {
			if (!autoModeRunning) {
				ctx.ui.notify("Auto mode is not running", "info");
				return;
			}
			autoModeRunning = false;
			ctx.ui.notify("Stopping auto mode after current task...", "warning");
		},
	});

	// ── /engram-auto-status command ───────────────────────────────────────

	pi.registerCommand("engram-auto-status", {
		description: "Show auto mode statistics (current or last run)",
		handler: async (_args, ctx) => {
			const stats = restoreAutoStats(ctx);
			if (!stats) {
				ctx.ui.notify("No auto mode stats found in this session", "info");
				return;
			}

			const lines = [
				`Auto mode stats (${stats.completed + stats.failed + stats.blocked} tasks processed):`,
				`  ✓ ${stats.completed} completed`,
				`  ✗ ${stats.failed} failed`,
				`  ⛔ ${stats.blocked} blocked`,
				`  ↻ ${stats.retried} retried`,
			];

			if (stats.tasks.length > 0) {
				lines.push("");
				lines.push("Task log:");
				for (const t of stats.tasks.slice(-10)) { // last 10
					const icon = t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : "⛔";
					lines.push(`  ${icon} ${t.title.slice(0, 50)}`);
				}
				if (stats.tasks.length > 10) {
					lines.push(`  ... and ${stats.tasks.length - 10} more`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Tools exposed to the LLM ───────────────────────────────────────────
	// Every command above is also available as a tool so the LLM can call it
	// directly without requiring interactive /commands.

	// ── engram_orchestrate ───────────────────────────────────────

	pi.registerTool({
		name: "engram_orchestrate",
		label: "Engram Orchestrate",
		description:
			"Create an engram parent task for a goal and search for prior context. " +
			"Returns the parent task UUID and any prior engram context so you can " +
			"immediately create subtasks with engram_task_create (using parent=<UUID>) " +
			"and then dispatch subagents with engram_dispatch.",
		parameters: Type.Object({
			goal: Type.String({ description: "The goal or feature description to orchestrate" }),
			priority: Type.Optional(StringEnum(
				["low", "medium", "high", "critical"] as const,
				{ description: "Priority for the parent task (default: high)" },
			)),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use (e.g. '/home/user/project/agentic-repos'). Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			onUpdate?.({
				content: [{ type: "text", text: `Searching prior context for: ${params.goal}...` }],
				details: { status: "searching" },
			});

			const searchResult = await runEngram(["ask", "query", params.goal], cwdOpt);

			const parentResult = await runEngram([
				"task", "create",
				"--title", `Goal: ${params.goal}`,
				"--priority", params.priority ?? "high",
				"--output", "json",
			], cwdOpt);
			if (parentResult.code !== 0) throw new Error(`Failed to create task: ${parentResult.stderr}`);
			const parentUuid = parseUuid(parentResult.stdout);
			if (!parentUuid) throw new Error("Failed to parse task UUID from engram output");

			await runEngram(["task", "update", parentUuid, "--status", "in_progress"], cwdOpt);

			return {
				content: [{
					type: "text",
					text: [
						`Parent task created: ${parentUuid}`,
						`Goal: ${params.goal}`,
						"",
						"Prior engram context:",
						searchResult.stdout || "(none)",
						"",
						"Next: use engram_task_create with parent=\"" + parentUuid + "\" to add subtasks,",
						"then engram_dispatch to run subagents for each one.",
					].join("\n"),
				}],
				details: { parentTaskId: parentUuid, goal: params.goal, repoCwd: params.repo_path },
			};
		},
	});

	// ── engram_collect ──────────────────────────────────────────────

	pi.registerTool({
		name: "engram_collect",
		label: "Engram Collect",
		description:
			"Collect and return all engram entities connected to a task (context, reasoning, ADRs, subtasks). " +
			"Use after dispatching subagents to gather their stored findings.",
		parameters: Type.Object({
			task_id: Type.String({ description: "Task UUID to collect connected entities for" }),
			max_depth: Type.Optional(Type.Number({ description: "Graph traversal depth (default: 2)" })),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const result = await runEngram([
				"relationship", "connected",
				"--entity-id", params.task_id,
				"--max-depth", String(params.max_depth ?? 2),
			], cwdOpt);
			if (result.code !== 0) throw new Error(result.stderr);
			return {
				content: [{ type: "text", text: result.stdout || "(no connected entities)" }],
				details: { taskId: params.task_id },
			};
		},
	});

	// ── engram_review ───────────────────────────────────────────────

	pi.registerTool({
		name: "engram_review",
		label: "Engram Review",
		description:
			"Run engram validate and show the task hierarchy and in-progress task status for one or more parent tasks. " +
			"Use before marking orchestration work done.",
		parameters: Type.Object({
			parent_ids: Type.Array(Type.String(), {
				description: "One or more parent task UUIDs to review",
			}),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : {};
			const parts: string[] = [];

			const validateResult = await runEngram(["validate", "check"], cwdOpt);
			parts.push(`Validation: ${validateResult.code === 0 ? "✅ PASS" : "❌ FAIL"}`);
			if (validateResult.code !== 0) parts.push(validateResult.stderr);

			for (const parentId of params.parent_ids) {
				const show = await runEngram(["task", "show", parentId], cwdOpt);
				if (show.code !== 0) { parts.push(`\nTask ${parentId}: not found`); continue; }
				const titleMatch = show.stdout.match(/Title:\s*(.+)/i);
				parts.push(`\n📊 ${titleMatch?.[1]?.trim() ?? parentId} (${parentId})`);
				const connected = await runEngram(["relationship", "connected", "--entity-id", parentId, "--max-depth", "1"], cwdOpt);
				if (connected.code === 0 && connected.stdout) parts.push(truncate(connected.stdout));
			}

			const inProgress = await runEngram(["task", "list", "--status", "in_progress"], cwdOpt);
			if (inProgress.code === 0 && inProgress.stdout) {
				parts.push(`\nIn-progress tasks:\n${inProgress.stdout}`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { validationPassed: validateResult.code === 0, parentIds: params.parent_ids },
			};
		},
	});

	// ── engram_auto ─────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_auto",
		label: "Engram Auto",
		description:
			"Run the autonomous task processing loop. Continuously fetches the next pending engram task, " +
			"dispatches a subagent, retries failures up to max_retries times, and blocks tasks that " +
			"exceed the retry limit. Runs until the queue is empty or the signal is aborted. " +
			"Returns a full summary with per-task results when done.",
		parameters: Type.Object({
			parent: Type.Optional(Type.String({
				description: "Scope to subtasks of this parent task UUID (default: all tasks)",
			})),
			max_retries: Type.Optional(Type.Number({
				description: "Max retry attempts per failed task before blocking it (default: 2)",
			})),
			dry_run: Type.Optional(Type.Boolean({
				description: "Preview what would be dispatched without executing (default: false)",
			})),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use (e.g. '/home/user/project/agentic-repos'). Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (autoModeRunning) {
				return {
					content: [{ type: "text", text: "Auto mode is already running. Call engram_auto_stop to halt it first." }],
					details: { running: true },
				};
			}

			const config: AutoModeConfig = {
				parent: params.parent,
				maxRetries: params.max_retries ?? 2,
				pollInterval: 5,
				dryRun: params.dry_run ?? false,
				cwd: params.repo_path,
			};

			autoModeRunning = true;
			const stats: AutoModeStats = {
				completed: 0, failed: 0, blocked: 0, retried: 0, totalDuration: 0, tasks: [],
			};
			const loopStart = Date.now();
			const retryMap = new Map<string, number>();
			const scopeLabel = config.parent ? `parent ${config.parent.slice(0, 8)}` : "all tasks";

			onUpdate?.({
				content: [{ type: "text", text: `🤖 Auto mode starting — ${scopeLabel}, max ${config.maxRetries} retries${config.dryRun ? " (DRY RUN)" : ""}` }],
				details: { status: "starting", config },
			});
			if (ctx.hasUI) ctx.ui.setStatus("engram-auto", "starting...");

			try {
				while (autoModeRunning) {
					if (signal?.aborted) break;

					const task = await getNextTask(config);

					if (!task) {
						const remaining = await countRemainingTasks(config);
						if (remaining === 0) {
							const ip = await runEngram(["task", "list", "--status", "in_progress"]);
							if (ip.code === 0 && !ip.stdout.includes("No tasks")) {
								await sleep(config.pollInterval * 1000, signal);
								continue;
							}
							onUpdate?.({
								content: [{ type: "text", text: `🤖 Queue empty — ${stats.completed} done, ${stats.failed} failed, ${stats.blocked} blocked` }],
								details: { status: "complete", ...stats },
							});
							break;
						}
						await sleep(config.pollInterval * 1000, signal);
						continue;
					}

					const attempt = retryMap.get(task.id) ?? 0;
					const remaining = await countRemainingTasks(config);
					const attemptLabel = attempt > 0 ? ` (attempt ${attempt + 1}/${config.maxRetries + 1})` : "";

					if (config.dryRun) {
						onUpdate?.({
							content: [{ type: "text", text: `[DRY] Would dispatch: ${task.title} (${task.id.slice(0, 8)})` }],
							details: { dryRun: true, taskId: task.id, title: task.title },
						});
						await runEngram(["task", "update", task.id, "--status", "done", "--outcome", "(dry run)"], config.cwd ? { cwd: config.cwd } : {});
						stats.completed++;
						stats.tasks.push({ id: task.id, title: task.title, status: "completed", duration: 0, attempts: 1 });
						continue;
					}

					const spawnCwd = config.cwd ?? ctx.cwd;
					const autoMs = selectModelForTask(task.title, "", ctx, spawnCwd);
					const modelInfo = autoMs ? ` via ${autoMs.label} [${autoMs.tier}]` : "";

					onUpdate?.({
						content: [{ type: "text", text: `Dispatching: ${task.title}${attemptLabel}${modelInfo} | ${remaining} remaining` }],
						details: { status: "dispatching", taskId: task.id, title: task.title, remaining, model: autoMs?.label },
					});
					if (ctx.hasUI) {
						ctx.ui.setStatus("engram-auto", `${stats.completed}✓ ${stats.failed}✗ | ${remaining} left | ${task.title.slice(0, 30)}${attemptLabel}`);
					}

					const result = await spawnSubagent(task.id, task.title, spawnCwd, signal, autoMs ?? undefined);
					const duration = result.duration;

					if (result.exitCode === 0) {
						stats.completed++;
						stats.totalDuration += duration;
						stats.tasks.push({ id: task.id, title: task.title, status: "completed", duration, attempts: attempt + 1 });
						retryMap.delete(task.id);
						onUpdate?.({
							content: [{ type: "text", text: `✓ ${task.title.slice(0, 50)} (${formatDuration(duration)}) | ${stats.completed} done, ${remaining - 1} remaining` }],
							details: { status: "task_complete", taskId: task.id, exitCode: 0, duration },
						});
					} else {
						const retryCount = attempt + 1;
						if (retryCount <= config.maxRetries) {
							retryMap.set(task.id, retryCount);
							stats.retried++;
							onUpdate?.({
								content: [{ type: "text", text: `✗ ${task.title.slice(0, 40)} — retrying (${retryCount}/${config.maxRetries})` }],
								details: { status: "retrying", taskId: task.id, attempt: retryCount },
							});
							await runEngram(["task", "update", task.id, "--status", "todo"], config.cwd ? { cwd: config.cwd } : {});
							await sleep(2000, signal);
						} else {
							const failReason = result.stderr.slice(0, 300).replace(/\n/g, " ");
							await runEngram(["task", "update", task.id, "--status", "blocked",
								"--reason", `Auto mode: failed after ${retryCount} attempts. ${failReason}`], config.cwd ? { cwd: config.cwd } : {});
							stats.failed++;
							stats.tasks.push({ id: task.id, title: task.title, status: "failed", duration, attempts: retryCount });
							retryMap.delete(task.id);
							onUpdate?.({
								content: [{ type: "text", text: `⛔ ${task.title.slice(0, 40)} — blocked after ${retryCount} attempts` }],
								details: { status: "blocked", taskId: task.id, attempts: retryCount },
							});
						}
					}

					persistAutoStats(stats);
				}
			} finally {
				autoModeRunning = false;
				if (ctx.hasUI) ctx.ui.setStatus("engram-auto", undefined);
			}

			const elapsed = Date.now() - loopStart;
			const validateResult = await runEngram(["validate", "check"], config.cwd ? { cwd: config.cwd } : {});
			const taskLog = stats.tasks.map((t) => {
				const icon = t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : "⛔";
				return `  ${icon} ${t.title.slice(0, 60)} (${formatDuration(t.duration)}, ${t.attempts} attempt${t.attempts !== 1 ? "s" : ""})`;
			});

			persistAutoStats(stats);

			return {
				content: [{
					type: "text",
					text: [
						`🤖 Auto mode finished in ${formatDuration(elapsed)}`,
						`   ${stats.completed} completed | ${stats.failed} failed | ${stats.blocked} blocked | ${stats.retried} retried`,
						`   Validation: ${validateResult.code === 0 ? "✅ PASS" : "❌ FAIL"}`,
						...(taskLog.length > 0 ? ["", "Task log:", ...taskLog] : []),
					].join("\n"),
				}],
				details: {
					elapsed,
					completed: stats.completed,
					failed: stats.failed,
					blocked: stats.blocked,
					retried: stats.retried,
					totalDuration: stats.totalDuration,
					validationPassed: validateResult.code === 0,
					tasks: stats.tasks,
				},
			};
		},
	});

	// ── engram_auto_stop ────────────────────────────────────────────

	pi.registerTool({
		name: "engram_auto_stop",
		label: "Engram Auto Stop",
		description: "Stop the running engram_auto loop after the current task completes. Has no effect if auto mode is not running.",
		parameters: Type.Object({}),
		async execute() {
			if (!autoModeRunning) {
				return { content: [{ type: "text", text: "Auto mode is not running." }], details: { running: false } };
			}
			autoModeRunning = false;
			return { content: [{ type: "text", text: "Stopping auto mode after current task completes..." }], details: { running: false } };
		},
	});

	// ── engram_auto_status ──────────────────────────────────────────

	pi.registerTool({
		name: "engram_auto_status",
		label: "Engram Auto Status",
		description: "Get statistics from the current or most recent engram_auto run: tasks completed, failed, blocked, retried, and per-task log.",
		parameters: Type.Object({}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const stats = restoreAutoStats(ctx);
			if (!stats) {
				return { content: [{ type: "text", text: "No auto mode stats found in this session." }], details: {} };
			}
			const lines = [
				`Auto mode stats (${autoModeRunning ? "RUNNING" : "stopped"}):`,
				`  ✓ ${stats.completed} completed`,
				`  ✗ ${stats.failed} failed`,
				`  ⛔ ${stats.blocked} blocked`,
				`  ↻ ${stats.retried} retried`,
			];
			if (stats.tasks.length > 0) {
				lines.push("", "Recent tasks:");
				for (const t of stats.tasks.slice(-15)) {
					const icon = t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : "⛔";
					lines.push(`  ${icon} ${t.title.slice(0, 60)}`);
				}
				if (stats.tasks.length > 15) lines.push(`  ... and ${stats.tasks.length - 15} more`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { running: autoModeRunning, ...stats },
			};
		},
	});
}
