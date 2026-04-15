/**
 * Engram Session — Automatic session lifecycle management
 *
 * Hooks into pi's session events to run the engram session start/end
 * protocol automatically. Manages sync pull/push, session creation,
 * and handoff summary generation.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runEngram, parseUuid } from "./common/runEngram.js";

const execFileAsync = promisify(execFile);

const ENGRAM_SESSION_KEY = "engram:session-id";
const ENGRAM_SESSION_NAME = "engram:session-name";

/** Check if an engram workspace is initialized in the given directory (default: cwd). */
async function isEngramWorkspace(cwd?: string): Promise<boolean> {
	const result = await runEngram(["info"], { timeout: 5_000, cwd });
	return result.code === 0;
}

// parseUuid imported from common/runEngram.js

/** Auto-generate a session name from git branch or fallback. */
async function autoSessionName(): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
			maxBuffer: 1024,
			timeout: 3_000,
		});
		const branch = stdout.trim();
		if (branch) {
			// Sanitise: lowercase, replace non-alphanum with dash
			return `pi-${branch.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 40)}`;
		}
	} catch {
		// git not available or not in a repo
	}
	return `pi-session-${Date.now().toString(36)}`;
}

export default function (pi: ExtensionAPI) {
	let sessionId: string | null = null;
	let sessionName: string | null = null;
	let workspaceReady: boolean | null = null;

	// ── Restore state from previous session ────────────────────────────────

	function restoreState(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENGRAM_SESSION_KEY) {
				sessionId = (entry.data as { id?: string })?.id ?? null;
			}
			if (entry.type === "custom" && entry.customType === ENGRAM_SESSION_NAME) {
				sessionName = (entry.data as { name?: string })?.name ?? null;
			}
		}
	}

	function persistState() {
		if (sessionId) {
			pi.appendEntry(ENGRAM_SESSION_KEY, { id: sessionId });
		}
		if (sessionName) {
			pi.appendEntry(ENGRAM_SESSION_NAME, { name: sessionName });
		}
	}

	// ── session_start ─────────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		// Restore persisted state on reload/resume
		if (event.reason === "reload" || event.reason === "resume") {
			restoreState(ctx);
			if (sessionId && ctx.hasUI) {
				ctx.ui.setStatus("engram", `session: ${sessionName ?? "?"} (${sessionId.slice(0, 8)})`);
			}
			return;
		}

		// Check workspace availability asynchronously
		workspaceReady = await isEngramWorkspace();
		if (!workspaceReady) {
			if (ctx.hasUI) {
				ctx.ui.setStatus("engram", "no workspace");
			}
			return;
		}

		// Sync pull if remotes configured
		const remotes = await runEngram(["sync", "list-remotes"], { timeout: 5_000 });
		if (remotes.code === 0 && remotes.stdout.trim()) {
			if (ctx.hasUI) {
				ctx.ui.setStatus("engram", "syncing...");
			}
			const pull = await runEngram(["sync", "pull", "--remote", "origin"], { timeout: 30_000 });
			if (pull.code !== 0 && ctx.hasUI) {
				ctx.ui.notify(`engram sync pull: ${pull.stderr || "failed"}`, "warning");
			}
		}

		// Auto-generate or prompt for session name
		const name = await autoSessionName();

		// Start engram session
		const result = await runEngram(["session", "start", "--name", name]);
		if (result.code === 0) {
			sessionId = parseUuid(result.stdout);
			sessionName = name;
			persistState();
			if (ctx.hasUI) {
				ctx.ui.setStatus("engram", `session: ${name} (${sessionId?.slice(0, 8) ?? "?"})`);
				ctx.ui.notify(`engram session started: ${name}`, "info");
			}
		} else if (ctx.hasUI) {
			ctx.ui.notify(`engram session start failed: ${result.stderr}`, "warning");
			ctx.ui.setStatus("engram", "session failed");
		}
	});

	// ── session_shutdown ──────────────────────────────────────────────────

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!sessionId || !workspaceReady) return;

		// End session with summary
		const endResult = await runEngram(["session", "end", "--id", sessionId, "--generate-summary"], {
			timeout: 30_000,
		});
		if (endResult.code !== 0 && ctx.hasUI) {
			ctx.ui.notify(`engram session end: ${endResult.stderr || "failed"}`, "warning");
		}

		// Sync push if remotes configured
		const remotes = await runEngram(["sync", "list-remotes"], { timeout: 5_000 });
		if (remotes.code === 0 && remotes.stdout.trim()) {
			await runEngram(["sync", "push", "--remote", "origin"], { timeout: 30_000 });
		}

		sessionId = null;
		sessionName = null;

		if (ctx.hasUI) {
			ctx.ui.setStatus("engram", undefined);
		}
	});

	// ── session_before_compact ────────────────────────────────────────────

	pi.on("session_before_compact", async (event, ctx) => {
		if (!sessionId || !workspaceReady) return;

		// Inject engram context into compaction to preserve handoff information
		const statusResult = await runEngram(["session", "list"], { timeout: 5_000 });
		const sessionInfo = sessionId
			? `\n\nActive engram session: ${sessionName} (${sessionId})\nRecent sessions:\n${statusResult.stdout}`
			: "";

		return {
			compaction: {
				summary: (event.preparation.existingSummary ?? "") + sessionInfo,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("engram-status", {
		description: "Show current engram session info and workspace status",
		handler: async (_args, ctx) => {
			const parts: string[] = [];

			if (sessionId && sessionName) {
				parts.push(`Session: ${sessionName} (${sessionId})`);
			} else {
				parts.push("Session: (none)");
			}

			if (workspaceReady) {
				const info = await runEngram(["info"]);
				parts.push(info.stdout.split("\n").filter((l) => l.includes("Entities") || l.includes("health")).join(" | "));
			} else {
				parts.push("Workspace: not initialized");
			}

			ctx.ui.notify(parts.join("\n"), "info");
		},
	});

	pi.registerCommand("engram-next", {
		description: "Get the next priority action from engram",
		handler: async (_args, ctx) => {
			if (!workspaceReady) {
				ctx.ui.notify("No engram workspace", "warning");
				return;
			}
			const result = await runEngram(["next"]);
			if (result.code === 0 && result.stdout) {
				// Inject as a follow-up message so the agent acts on it
				pi.sendUserMessage(result.stdout, { deliverAs: "followUp" });
			} else {
				ctx.ui.notify(result.stderr || "(no pending tasks)", "info");
			}
		},
	});

	pi.registerCommand("engram-session-end", {
		description: "Manually end the current engram session with summary",
		handler: async (_args, ctx) => {
			if (!sessionId) {
				ctx.ui.notify("No active engram session", "warning");
				return;
			}
			const result = await runEngram(["session", "end", "--id", sessionId, "--generate-summary"]);
			if (result.code === 0) {
				ctx.ui.notify("Session ended, summary generated", "success");
			} else {
				ctx.ui.notify(`Failed: ${result.stderr}`, "error");
			}
			// Sync push
			const remotes = await runEngram(["sync", "list-remotes"], { timeout: 5_000 });
			if (remotes.code === 0 && remotes.stdout.trim()) {
				await runEngram(["sync", "push", "--remote", "origin"], { timeout: 30_000 });
				ctx.ui.notify("Synced to remote", "success");
			}
			sessionId = null;
			sessionName = null;
			ctx.ui.setStatus("engram", undefined);
		},
	});

	// ── Track engram session_start tool calls ─────────────────────────────

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "engram_session_start" && event.content) {
			const text = event.content.find((c) => c.type === "text")?.text ?? "";
			const uuid = parseUuid(text);
			if (uuid) {
				sessionId = uuid;
				persistState();
			}
		}
		if (event.toolName === "engram_session_end" && event.content) {
			sessionId = null;
			sessionName = null;
			if (ctx.hasUI) {
				ctx.ui.setStatus("engram", undefined);
			}
		}
	});

	// ── engram_workspace_status tool ────────────────────────────────

	pi.registerTool({
		name: "engram_workspace_status",
		label: "Engram Workspace Status",
		description:
			"Return the current engram workspace status: active session name and ID, " +
			"entity counts, and workspace health. Use to check if an engram session " +
			"is active before starting work.",
		parameters: Type.Object({
			repo_path: Type.Optional(
				Type.String({
					description:
						"Absolute path to the repo whose engram workspace to use. Omit to use the current workspace.",
				}),
			),
		}),
		async execute(_id, params) {
			const cwdOpt = params.repo_path ? { cwd: params.repo_path } : undefined;
			const parts: string[] = [];
			if (!params.repo_path) {
				// Report session state for the default (current) workspace
				if (sessionId && sessionName) {
					parts.push(`Session: ${sessionName} (${sessionId})`);
				} else {
					parts.push("Session: (none active)");
				}
			}
			const ready = await isEngramWorkspace(params.repo_path);
			if (ready) {
				const info = await runEngram(["info"], cwdOpt);
				if (info.code === 0 && info.stdout) parts.push(info.stdout);
			} else {
				parts.push("Workspace: not initialised (.engram/ not found)");
			}
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { sessionId: params.repo_path ? null : sessionId, sessionName: params.repo_path ? null : sessionName, workspaceReady: ready },
			};
		},
	});
}
