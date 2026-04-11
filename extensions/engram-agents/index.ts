/**
 * Engram Agents Extension
 *
 * Integrates the 171 engram agent personas from ./engram/prompts/agents/ into pi.
 *
 * Each agent YAML defines a specialist persona with:
 *   - title / description
 *   - instructions (system prompt)
 *   - parameters (for template prompts)
 *   - SEP metadata: cov_questions, fap_table, ov_requirements
 *
 * This extension provides:
 *
 * Tools (LLM-facing):
 *   engram_agent_list     — browse all 171 agents (title + description)
 *   engram_agent_get      — get full agent definition (instructions, SEP metadata)
 *   engram_agent_search   — search by keyword across title/description/instructions
 *   engram_agent_dispatch — spawn a child pi process with agent persona injected
 *   engram_agent_register — register an agent profile in the engram workspace
 *
 * Commands:
 *   /agent-list [query]               — list agents, optional keyword filter
 *   /agent-use <slug>                 — load agent persona into current session
 *   /agent-dispatch <slug> <task-id>  — spawn child pi with persona + engram protocol
 *   /agent-info <slug>                — show full agent definition
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentParameter {
	key: string;
	input_type?: string;
	requirement?: string;
	description?: string;
}

interface AgentDefinition {
	slug: string;           // e.g. "70-the-rustacean"
	number: string;         // e.g. "70"
	shortName: string;      // e.g. "the-rustacean"
	title: string;
	description: string;
	instructions: string;
	parameters: AgentParameter[];
	covQuestions: string[];
	fapTable: Record<string, string>;
	ovRequirements: string[];
	filePath: string;
}

// ─── YAML Parser (no external dependency) ────────────────────────────────────

/**
 * Extract a scalar field value (handles quoted and unquoted).
 * e.g.  title: "Agent 01: The One"  or  version: 1.0
 */
function extractScalar(content: string, field: string): string {
	const re = new RegExp(`^${field}:\\s*['"](.*?)['"\\s]*$`, "m");
	const m = content.match(re);
	if (m) return m[1].trim();
	const re2 = new RegExp(`^${field}:\\s*(.+)$`, "m");
	const m2 = content.match(re2);
	return m2 ? m2[1].trim().replace(/^["']|["']$/g, "") : "";
}

/**
 * Extract a YAML block scalar (|) or folded (>) field.
 * Grabs all lines indented relative to the field until the next root-level key.
 */
function extractBlock(content: string, field: string): string {
	const lines = content.split("\n");
	let inBlock = false;
	let blockIndent = -1;
	const collected: string[] = [];

	for (const line of lines) {
		if (!inBlock) {
			if (new RegExp(`^${field}:\\s*[|>]`).test(line)) {
				inBlock = true;
			}
			continue;
		}
		// Detect end of block: non-empty line that starts a new root-level key
		if (line.length > 0 && !/^\s/.test(line) && /^[a-z_]+:/.test(line)) {
			break;
		}
		if (blockIndent === -1 && line.trim()) {
			const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
			blockIndent = leadingSpaces;
		}
		// Strip the common leading indent
		if (blockIndent >= 0) {
			collected.push(line.slice(blockIndent));
		} else {
			collected.push(line);
		}
	}

	return collected.join("\n").trim();
}

/**
 * Extract a YAML sequence field (- item or - key: val).
 * Returns string items only (used for cov_questions and ov_requirements).
 */
function extractStringList(content: string, field: string): string[] {
	const lines = content.split("\n");
	let inSection = false;
	const items: string[] = [];

	for (const line of lines) {
		if (!inSection) {
			if (new RegExp(`^${field}:`).test(line)) {
				inSection = true;
				continue;
			}
			continue;
		}
		// End of section
		if (line.length > 0 && !/^\s/.test(line) && /^[a-z_]+:/.test(line)) break;
		// List item: `  - "text"` or `  - text`
		const m = line.match(/^\s+-\s+"?(.+?)"?\s*$/);
		if (m) items.push(m[1].trim());
	}

	return items;
}

/**
 * Extract the fap_table (key: value pairs under the section).
 */
function extractFapTable(content: string): Record<string, string> {
	const lines = content.split("\n");
	let inSection = false;
	const table: Record<string, string> = {};

	for (const line of lines) {
		if (!inSection) {
			if (/^fap_table:/.test(line)) { inSection = true; continue; }
			continue;
		}
		if (line.length > 0 && !/^\s/.test(line) && /^[a-z_]+:/.test(line)) break;
		// key: "value" or key: value
		const m = line.match(/^\s+([A-Z]+):\s*"?(.+?)"?\s*$/);
		if (m) table[m[1]] = m[2].trim();
	}

	return table;
}

/**
 * Extract parameters list (handles both list format and properties dict).
 */
function extractParameters(content: string): AgentParameter[] {
	const lines = content.split("\n");
	let inSection = false;
	let current: Partial<AgentParameter> | null = null;
	const params: AgentParameter[] = [];

	for (const line of lines) {
		if (!inSection) {
			if (/^parameters:/.test(line)) { inSection = true; continue; }
			continue;
		}
		if (line.length > 0 && !/^\s/.test(line) && /^[a-z_]+:/.test(line)) break;

		// List item start: `  - key: foo`
		const itemStart = line.match(/^\s+-\s+key:\s*(.+)$/);
		if (itemStart) {
			if (current?.key) params.push(current as AgentParameter);
			current = { key: itemStart[1].trim() };
			continue;
		}

		if (current) {
			const inputType = line.match(/^\s+input_type:\s*(.+)$/);
			if (inputType) { current.input_type = inputType[1].trim(); continue; }
			const req = line.match(/^\s+requirement:\s*(.+)$/);
			if (req) { current.requirement = req[1].trim(); continue; }
			const desc = line.match(/^\s+description:\s*"?(.+?)"?\s*$/);
			if (desc) { current.description = desc[1].trim(); continue; }
		}
	}
	if (current?.key) params.push(current as AgentParameter);
	return params;
}

// ─── Agent Discovery ──────────────────────────────────────────────────────────

/** Strip the repeated evidence-based boilerplate that appears in every agent. */
function stripBoilerplate(instructions: string): string {
	// The boilerplate appears as one or two contiguous sections:
	//   EVIDENCE-BASED VALIDATION REQUIREMENTS: ... (bullet list)
	//   EVIDENCE COLLECTION INSTRUCTIONS: ... (bullet list ending with "Instead, provide...")
	// These sections only contain lines that are blank, start with "- ", or are the section headings.
	// We strip them line-by-line: once we see a non-boilerplate heading line, we start collecting.
	const BOILERPLATE_HEADINGS = [
		"EVIDENCE-BASED VALIDATION REQUIREMENTS:",
		"EVIDENCE COLLECTION INSTRUCTIONS:",
	];

	const lines = instructions.split("\n");
	const output: string[] = [];
	let skipping = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Start skipping when we hit a boilerplate heading
		if (BOILERPLATE_HEADINGS.some((h) => trimmed.startsWith(h))) {
			skipping = true;
			continue;
		}

		if (skipping) {
			// Keep skipping while line is blank or is a bullet point within boilerplate
			if (trimmed === "" || trimmed.startsWith("- ") || trimmed.startsWith("## Claim") || trimmed.startsWith("### Evidence") || trimmed.startsWith("**Code") || trimmed.startsWith("**Test") || trimmed.startsWith("**Execution") || trimmed.startsWith("**Documentation") || trimmed.startsWith("- Never make") || trimmed.startsWith("- Instead,") || trimmed.startsWith("- Always provide")) {
				continue;
			}
			// Non-boilerplate line encountered — stop skipping
			skipping = false;
		}

		output.push(line);
	}

	return output.join("\n").trim();
}

let agentCache: AgentDefinition[] | null = null;

function parseAgentFile(filePath: string): AgentDefinition | null {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const filename = path.basename(filePath, ".yaml");

		// Extract slug components
		const slugMatch = filename.match(/^(\d+)-(.+)$/);
		const number = slugMatch?.[1] ?? "";
		const shortName = slugMatch?.[2] ?? filename;

		const title = extractScalar(content, "title");
		const description = extractScalar(content, "description");
		const rawInstructions = extractBlock(content, "instructions");
		const instructions = stripBoilerplate(rawInstructions);
		const parameters = extractParameters(content);
		const covQuestions = extractStringList(content, "cov_questions");
		const fapTable = extractFapTable(content);
		const ovRequirements = extractStringList(content, "ov_requirements");

		if (!title && !description) return null;

		return {
			slug: filename,
			number,
			shortName,
			title: title || filename,
			description: description || "(no description)",
			instructions,
			parameters,
			covQuestions,
			fapTable,
			ovRequirements,
			filePath,
		};
	} catch {
		return null;
	}
}

/** Find the agent YAML directory relative to cwd. */
function findAgentsDir(cwd: string): string | null {
	// Look for engram/prompts/agents/ relative to cwd
	const candidates = [
		path.join(cwd, "engram", "prompts", "agents"),
		path.join(cwd, "prompts", "agents"),
		path.join(cwd, ".engram", "agents"),
	];
	for (const dir of candidates) {
		if (fs.existsSync(dir)) return dir;
	}
	return null;
}

function loadAgents(cwd: string): AgentDefinition[] {
	if (agentCache) return agentCache;

	const dir = findAgentsDir(cwd);
	if (!dir) {
		agentCache = [];
		return [];
	}

	const files = fs.readdirSync(dir)
		.filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
		.sort();

	const agents: AgentDefinition[] = [];
	for (const file of files) {
		const agent = parseAgentFile(path.join(dir, file));
		if (agent) agents.push(agent);
	}

	agentCache = agents;
	return agents;
}

/**
 * Resolve an agent by slug, number, partial name, or keyword.
 * Accepts: "70", "rustacean", "70-the-rustacean", "the-rustacean", "Rust"
 */
function resolveAgent(query: string, agents: AgentDefinition[]): AgentDefinition | null {
	const q = query.toLowerCase().trim();

	// Exact slug match
	const bySlug = agents.find((a) => a.slug.toLowerCase() === q);
	if (bySlug) return bySlug;

	// Number match
	const byNumber = agents.find((a) => a.number === q);
	if (byNumber) return byNumber;

	// Short name match (e.g. "the-rustacean")
	const byShort = agents.find((a) => a.shortName.toLowerCase() === q);
	if (byShort) return byShort;

	// Word in short name (e.g. "rustacean")
	const byWord = agents.find((a) => a.shortName.toLowerCase().includes(q));
	if (byWord) return byWord;

	// Word in title
	const byTitle = agents.find((a) => a.title.toLowerCase().includes(q));
	if (byTitle) return byTitle;

	// Word in description
	const byDesc = agents.find((a) => a.description.toLowerCase().includes(q));
	if (byDesc) return byDesc;

	return null;
}

/** Search agents by keyword across title + description + instructions. */
function searchAgents(query: string, agents: AgentDefinition[]): AgentDefinition[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return agents.filter((a) => {
		const haystack = `${a.title} ${a.description} ${a.shortName}`.toLowerCase();
		return terms.every((t) => haystack.includes(t));
	});
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text: string): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	return t.truncated ? t.content + `\n[truncated: ${t.outputLines}/${t.totalLines} lines]` : t.content;
}

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

async function writeTemp(content: string, ext = ".md"): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-"));
	const filePath = path.join(dir, `prompt${ext}`);
	await fs.promises.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
	return filePath;
}

async function cleanTemp(filePath: string) {
	try {
		await fs.promises.unlink(filePath);
		await fs.promises.rmdir(path.dirname(filePath));
	} catch { /* ignore */ }
}

function getPiCommand(): string { return "pi"; }

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
	agentTitle: string,
	rules: ModelRoutingRule[],
): string {
	const text = `${taskTitle} ${agentTitle}`.toLowerCase();
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
	agentTitle: string,
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
		tier = classifyTaskTier(taskTitle, agentTitle, routing.tier_rules);
		const tierCfg = routing.tier_priorities[tier] ?? { prefer: [1, 2, 3], fallback: [4, 5, 6, 7] };
		priorityOrder = [...tierCfg.prefer, ...tierCfg.fallback];
	} else {
		// No routing config — sequential priority order
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

// ─── Subagent Dispatch ────────────────────────────────────────────────────────

interface AgentDispatchResult {
	exitCode: number;
	duration: number;
	stderr: string;
	model?: SelectedModel;
}

/**
 * Build the full system prompt for a dispatched agent.
 * Combines: agent's own instructions + engram subagent protocol + task context.
 */
function buildAgentSystemPrompt(agent: AgentDefinition, taskId: string): string {
	const sep = [
		"## Your Identity",
		`You are **${agent.title}**.`,
		agent.description,
		"",
	];

	if (agent.instructions) {
		sep.push("## Your Instructions", agent.instructions, "");
	}

	if (agent.covQuestions.length > 0) {
		sep.push("## Questions to Answer Before Starting");
		agent.covQuestions.forEach((q) => sep.push(`- ${q}`));
		sep.push("");
	}

	if (Object.keys(agent.fapTable).length > 0) {
		sep.push("## Your Role");
		for (const [k, v] of Object.entries(agent.fapTable)) {
			sep.push(`**${k}:** ${v}`);
		}
		sep.push("");
	}

	sep.push(
		"## Engram Protocol",
		`Your task UUID is: **${taskId}**`,
		"",
		"1. Claim the task: `engram_task_update` status=in_progress",
		"2. Pull context: `engram_relationship_connected` on your task UUID",
		"3. Store EVERY finding immediately with `engram_context_create` + `engram_relationship_create`",
		"4. Store reasoning with `engram_reasoning_create` + `engram_relationship_create`",
		"5. When done, write a completion report as reasoning, then `engram_task_update` status=done",
		"",
		"**NEVER** batch findings — write each one to engram immediately.",
		"**ALWAYS** link every entity you create with `engram_relationship_create`.",
	);

	if (agent.ovRequirements.length > 0) {
		sep.push("", "## Acceptance Criteria");
		agent.ovRequirements.forEach((r) => sep.push(`- ${r}`));
	}

	return sep.join("\n");
}

async function dispatchAgent(
	agent: AgentDefinition,
	taskId: string,
	taskTitle: string,
	cwd: string,
	signal: AbortSignal | undefined,
	modelSelection?: SelectedModel,
): Promise<AgentDispatchResult> {
	const start = Date.now();
	const systemPrompt = buildAgentSystemPrompt(agent, taskId);
	const promptFile = await writeTemp(systemPrompt);

	const userPrompt = [
		`You are **${agent.title}** — ${agent.description}`,
		"",
		`Complete this task using engram for all tracking:`,
		`Task UUID: ${taskId}`,
		`Task: ${taskTitle}`,
		"",
		"Follow the engram subagent protocol shown in your system prompt.",
	].join("\n");

	const args = [
		"--mode", "json",
		...(modelSelection ? ["--model", `${modelSelection.provider}/${modelSelection.model}`] : []),
		"-p",
		"--no-session",
		"--append-system-prompt", promptFile,
		userPrompt,
	];

	const result: AgentDispatchResult = { exitCode: -1, duration: 0, stderr: "", model: modelSelection };

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(getPiCommand(), args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			proc.stderr.on("data", (d) => { result.stderr += d.toString(); });
			proc.on("close", (code) => resolve(code ?? 0));
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});
		result.exitCode = exitCode;
	} finally {
		await cleanTemp(promptFile);
	}

	result.duration = Date.now() - start;
	return result;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ─── Tools ──────────────────────────────────────────────────────────────────

	// ── engram_agent_list ──────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_agent_list",
		label: "Engram Agent List",
		description: "List all available engram agent personas with their title and description. Use this to browse agents before dispatching one. 171 agents cover: orchestration, Rust, DevOps, testing, architecture, security, databases, frontend, embedded, audio/video, AI/ML, 3D printing, and more.",
		parameters: Type.Object({
			category: Type.Optional(Type.String({
				description: "Optional keyword to filter by (e.g. 'rust', 'security', 'test', 'devops', 'database')",
			})),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(params.repo_path ?? ctx.cwd);
			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No agent files found. Expected at: ./engram/prompts/agents/" }],
					details: { count: 0 },
				};
			}

			const filtered = params.category
				? searchAgents(params.category, agents)
				: agents;

			const lines = filtered.map((a) => `[${a.number.padStart(3)}] ${a.slug.padEnd(35)} ${a.description}`);
			const text = `${filtered.length}/${agents.length} agents:\n\n${lines.join("\n")}`;

			return {
				content: [{ type: "text", text: truncate(text) }],
				details: { count: filtered.length, total: agents.length },
			};
		},
	});

	// ── engram_agent_get ───────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_agent_get",
		label: "Engram Agent Get",
		description: "Get the full definition of an agent: instructions, SEP metadata (cov_questions, fap_table, ov_requirements), and parameters. Use before dispatching to understand the agent's capabilities and protocols.",
		parameters: Type.Object({
			slug: Type.String({
				description: "Agent identifier — any of: number ('70'), short name ('the-rustacean'), full slug ('70-the-rustacean'), or keyword ('rust', 'security')",
			}),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(params.repo_path ?? ctx.cwd);
			const agent = resolveAgent(params.slug, agents);
			if (!agent) {
				throw new Error(`Agent not found: '${params.slug}'. Use engram_agent_list to browse.`);
			}

			const lines = [
				`# ${agent.title}`,
				`**Slug:** ${agent.slug}`,
				`**Description:** ${agent.description}`,
				"",
				"## Instructions",
				agent.instructions || "(none)",
			];

			if (agent.covQuestions.length > 0) {
				lines.push("", "## COV Questions");
				agent.covQuestions.forEach((q) => lines.push(`- ${q}`));
			}

			if (Object.keys(agent.fapTable).length > 0) {
				lines.push("", "## FAP Table");
				for (const [k, v] of Object.entries(agent.fapTable)) {
					lines.push(`**${k}:** ${v}`);
				}
			}

			if (agent.ovRequirements.length > 0) {
				lines.push("", "## OV Requirements");
				agent.ovRequirements.forEach((r) => lines.push(`- ${r}`));
			}

			if (agent.parameters.length > 0) {
				lines.push("", "## Parameters");
				agent.parameters.forEach((p) => {
					lines.push(`- **${p.key}** (${p.input_type ?? "string"}, ${p.requirement ?? "optional"}): ${p.description ?? ""}`);
				});
			}

			return {
				content: [{ type: "text", text: truncate(lines.join("\n")) }],
				details: { slug: agent.slug, title: agent.title },
			};
		},
	});

	// ── engram_agent_search ────────────────────────────────────────────────

	pi.registerTool({
		name: "engram_agent_search",
		label: "Engram Agent Search",
		description: "Search agents by keyword(s) across title, description, and short name. Returns matching agents with their slug and description.",
		parameters: Type.Object({
			query: Type.String({ description: "Search terms (e.g. 'rust memory safety', 'ci cd pipeline', 'database query optimization')" }),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(params.repo_path ?? ctx.cwd);
			const results = searchAgents(params.query, agents);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No agents matched '${params.query}'.` }],
					details: { count: 0 },
				};
			}

			const lines = results.map((a) => `${a.slug.padEnd(35)} ${a.description}`);
			return {
				content: [{ type: "text", text: `${results.length} matches:\n\n${lines.join("\n")}` }],
				details: { count: results.length, slugs: results.map((a) => a.slug) },
			};
		},
	});

	// ── engram_agent_dispatch ──────────────────────────────────────────────

	pi.registerTool({
		name: "engram_agent_dispatch",
		label: "Engram Agent Dispatch",
		description: "Spawn a child pi process as a specialist subagent. The agent's persona (instructions + SEP metadata) is injected as system prompt alongside the engram subagent protocol. The agent claims the task from engram, stores findings, and marks done when complete.",
		parameters: Type.Object({
			slug: Type.String({
				description: "Agent identifier — number ('70'), short name ('the-rustacean'), or keyword ('rust')",
			}),
			task_id: Type.String({
				description: "Engram task UUID for the agent to work on",
			}),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use (e.g. '/home/user/project/agentic-repos'). Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(params.repo_path ?? ctx.cwd);
			const agent = resolveAgent(params.slug, agents);
			if (!agent) {
				throw new Error(`Agent not found: '${params.slug}'. Use engram_agent_search to find one.`);
			}

			const agentCwd = params.repo_path ?? ctx.cwd;
			const agentCwdOpt = agentCwd !== ctx.cwd ? { cwd: agentCwd } : {};

			// Get task title
			const taskShow = await runEngram(["task", "show", params.task_id], agentCwdOpt);
			if (taskShow.code !== 0) throw new Error(`Task not found: ${taskShow.stderr}`);
			const titleMatch = taskShow.stdout.match(/Title:\s*(.+)/i);
			const taskTitle = titleMatch?.[1]?.trim() ?? params.task_id;

			// Select the best available model for this task + agent type
			const modelSelection = selectModelForTask(taskTitle, agent.title, ctx, agentCwd);
			const modelInfo = modelSelection
				? ` via ${modelSelection.label} [${modelSelection.tier}]`
				: "";

			onUpdate?.({
				content: [{ type: "text", text: `Dispatching ${agent.title} for: ${taskTitle}${modelInfo}...` }],
				details: { agent: agent.slug, taskId: params.task_id, model: modelSelection?.label, tier: modelSelection?.tier },
			});

			const result = await dispatchAgent(agent, params.task_id, taskTitle, agentCwd, signal, modelSelection ?? undefined);
			const duration = (result.duration / 1000).toFixed(1);
			const status = result.exitCode === 0 ? "COMPLETED" : `FAILED (exit ${result.exitCode})`;

			// Collect results
			const connected = await runEngram(["relationship", "connected", "--entity-id", params.task_id, "--max-depth", "2"], agentCwdOpt);

			return {
				content: [
					{
						type: "text",
						text: [
							`${agent.title} ${status} (${duration}s)`,
							modelSelection ? `Model: ${modelSelection.label} [tier: ${modelSelection.tier}]` : "",
							"",
							"Connected entities:",
							connected.stdout || "(none)",
						].filter(Boolean).join("\n"),
					},
				],
				details: {
					agent: agent.slug,
					taskId: params.task_id,
					exitCode: result.exitCode,
					duration: result.duration,
					model: modelSelection ?? null,
				},
			};
		},
	});

	// ── engram_agent_register ──────────────────────────────────────────────

	pi.registerTool({
		name: "engram_agent_register",
		label: "Engram Agent Register",
		description: "Register an agent persona in the engram workspace (creates .engram/agents/<name>.yaml). This makes the agent available for session tracking and task assignment.",
		parameters: Type.Object({
			name: Type.String({ description: "Agent name (used in engram task --agent flag)" }),
			slug: Type.String({ description: "Persona slug to link (e.g. '70-the-rustacean')" }),
			agent_type: Type.Optional(Type.String({ description: "Agent type: coder, reviewer, planner (default: coder)" })),
			specialization: Type.Optional(Type.String({ description: "Short specialization description" })),
			repo_path: Type.Optional(Type.String({
				description: "Absolute path to the repo whose engram workspace to use. Omit to use the current workspace.",
			})),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = loadAgents(params.repo_path ?? ctx.cwd);
			const agent = resolveAgent(params.slug, agents);
			if (!agent) {
				throw new Error(`Agent not found: '${params.slug}'`);
			}

			const args = [
				"setup", "agent",
				"--name", params.name,
				"--persona", agent.slug,
				"--json",
			];
			if (params.agent_type) args.push("--agent-type", params.agent_type);
			if (params.specialization) args.push("--specialization", params.specialization);

			const result = await runEngram(args, params.repo_path ? { cwd: params.repo_path } : {});
			if (result.code !== 0) throw new Error(result.stderr);

			return {
				content: [{ type: "text", text: `Registered agent '${params.name}' with persona '${agent.slug}'\n${result.stdout}` }],
				details: { name: params.name, persona: agent.slug },
			};
		},
	});

	// ─── Commands ────────────────────────────────────────────────────────────────

	// ── /agent-list [query] ────────────────────────────────────────────────

	pi.registerCommand("agent-list", {
		description: "Browse all 171 engram agent personas. Optional: /agent-list <keyword>",
		getArgumentCompletions: (prefix) => {
			if (!prefix) return null;
			// Suggest common domains
			const domains = ["rust", "security", "test", "devops", "database", "frontend", "embedded", "ai", "audio", "architect", "orchestrat"];
			const matches = domains.filter((d) => d.startsWith(prefix));
			return matches.length > 0 ? matches.map((d) => ({ value: d, label: d })) : null;
		},
		handler: async (args, ctx) => {
			const agents = loadAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify("No agents found. Expected: ./engram/prompts/agents/", "warning");
				return;
			}

			const query = args?.trim();
			const filtered = query ? searchAgents(query, agents) : agents;

			const lines = [`${filtered.length}/${agents.length} agents${query ? ` matching '${query}'` : ""}:\n`];
			for (const a of filtered) {
				lines.push(`  [${a.number.padStart(3, " ")}] ${a.slug.padEnd(34)} ${a.description.slice(0, 60)}`);
			}
			if (filtered.length > 30) {
				lines.push(`\n  ... use /agent-list <keyword> to filter`);
			}
			lines.push("\nUse /agent-info <slug> for details, /agent-use <slug> to load into session");

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── /agent-info <slug> ─────────────────────────────────────────────────

	pi.registerCommand("agent-info", {
		description: "Show full details of an agent persona. Usage: /agent-info <slug-or-number>",
		handler: async (args, ctx) => {
			const agents = loadAgents(ctx.cwd);
			const query = args?.trim();
			if (!query) {
				ctx.ui.notify("Usage: /agent-info <slug-or-number-or-keyword>", "warning");
				return;
			}

			const agent = resolveAgent(query, agents);
			if (!agent) {
				ctx.ui.notify(`Agent not found: '${query}'. Try /agent-list.`, "error");
				return;
			}

			const lines = [
				`${agent.title}`,
				`Slug: ${agent.slug}`,
				`Description: ${agent.description}`,
				"",
				"Instructions (first 500 chars):",
				agent.instructions.slice(0, 500) + (agent.instructions.length > 500 ? "..." : ""),
			];

			if (agent.covQuestions.length > 0) {
				lines.push("", "COV Questions:");
				agent.covQuestions.slice(0, 3).forEach((q) => lines.push(`  - ${q}`));
			}

			if (agent.ovRequirements.length > 0) {
				lines.push("", "OV Requirements:");
				agent.ovRequirements.slice(0, 3).forEach((r) => lines.push(`  - ${r}`));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── /agent-use <slug> ─────────────────────────────────────────────────
	//
	// Inject the agent's persona into the CURRENT session — no child spawn.
	// Useful for "becoming" a specialist agent for the rest of the conversation.

	pi.registerCommand("agent-use", {
		description: "Load an agent persona into the current session (no spawn). Usage: /agent-use <slug-or-number>",
		handler: async (args, ctx) => {
			const agents = loadAgents(ctx.cwd);
			const query = args?.trim();
			if (!query) {
				ctx.ui.notify("Usage: /agent-use <slug-or-number-or-keyword>", "warning");
				return;
			}

			const agent = resolveAgent(query, agents);
			if (!agent) {
				ctx.ui.notify(`Agent not found: '${query}'. Try /agent-list.`, "error");
				return;
			}

			// Build a concise persona injection (not full instructions — context window cost)
			const personaBlurb = [
				`You are now acting as **${agent.title}**.`,
				`${agent.description}`,
				"",
				agent.instructions
					? `## Your Instructions\n${agent.instructions}`
					: "",
				agent.covQuestions.length > 0
					? `\n## Key Questions to Answer\n${agent.covQuestions.map((q) => `- ${q}`).join("\n")}`
					: "",
				agent.ovRequirements.length > 0
					? `\n## Acceptance Criteria\n${agent.ovRequirements.map((r) => `- ${r}`).join("\n")}`
					: "",
			].filter(Boolean).join("\n");

			// Steer the current session with this persona
			pi.sendUserMessage(personaBlurb, { deliverAs: "steer" });

			ctx.ui.setStatus("engram-agent", agent.shortName);
			ctx.ui.notify(`✓ Loaded persona: ${agent.title}`, "success");
		},
	});

	// ── /agent-dispatch <slug> <task-id> ──────────────────────────────────

	pi.registerCommand("agent-dispatch", {
		description: "Spawn a specialist agent as a child pi process for an engram task. Usage: /agent-dispatch <slug> <task-uuid>",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /agent-dispatch <slug-or-number> <task-uuid>", "warning");
				return;
			}

			const [slugQuery, taskId] = parts;
			const agents = loadAgents(ctx.cwd);
			const agent = resolveAgent(slugQuery, agents);
			if (!agent) {
				ctx.ui.notify(`Agent not found: '${slugQuery}'. Try /agent-list.`, "error");
				return;
			}

			const taskShow = await runEngram(["task", "show", taskId]);
			if (taskShow.code !== 0) {
				ctx.ui.notify(`Task not found: ${taskShow.stderr}`, "error");
				return;
			}
			const titleMatch = taskShow.stdout.match(/Title:\s*(.+)/i);
			const taskTitle = titleMatch?.[1]?.trim() ?? taskId;

			const modelSelection = selectModelForTask(taskTitle, agent.title, ctx, ctx.cwd);
			const modelInfo = modelSelection
				? ` via ${modelSelection.label} [${modelSelection.tier}]`
				: "";

			ctx.ui.setStatus("engram-agent", `${agent.shortName} → ${taskId.slice(0, 8)}`);
			ctx.ui.notify(`Dispatching ${agent.title} for: ${taskTitle}${modelInfo}`, "info");

			const result = await dispatchAgent(agent, taskId, taskTitle, ctx.cwd, ctx.signal, modelSelection ?? undefined);
			const duration = (result.duration / 1000).toFixed(1);

			ctx.ui.setStatus("engram-agent", undefined);

			if (result.exitCode === 0) {
				ctx.ui.notify(`✓ ${agent.title} completed (${duration}s)`, "success");
			} else {
				ctx.ui.notify(`✗ ${agent.title} failed (exit ${result.exitCode}, ${duration}s)`, "error");
			}

			// Collect results and surface to LLM
			const connected = await runEngram(["relationship", "connected", "--entity-id", taskId, "--max-depth", "2"]);
			pi.sendUserMessage(
				[
					`Agent ${agent.title} finished for task ${taskId} (${taskTitle}):`,
					`Status: ${result.exitCode === 0 ? "COMPLETED" : `FAILED (exit ${result.exitCode})`} | Duration: ${duration}s`,
					"",
					"Connected engram entities:",
					connected.stdout || "(none)",
					"",
					"Review results and decide: mark done, re-dispatch, or create follow-up tasks.",
				].join("\n"),
				{ deliverAs: "followUp" },
			);
		},
	});

	// ── Footer status: show current persona if agent-use was called ────────

	pi.on("session_start", (_event, ctx) => {
		// Clear any stale persona status
		ctx.ui.setStatus("engram-agent", undefined);
	});
}
