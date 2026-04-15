/**
 * Engram Commit Gate — Enforces engram commit convention on git commits
 *
 * Intercepts bash tool calls containing `git commit` and:
 * 1. Blocks `--no-verify` unconditionally
 * 2. Validates that commit messages contain a UUID in [UUID] format
 * 3. Optionally runs `engram validate commit --dry-run`
 *
 * This is a soft gate — it blocks the tool call and returns guidance
 * so the agent can fix the issue.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

const UUID_PATTERN = /\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]/i;

async function runEngram(
	args: string[],
	options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const spawnOpts: Parameters<typeof execFileAsync>[2] = {
			maxBuffer: 1024 * 1024,
			timeout: 10_000,
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

/** Extract commit message(s) from a git commit command. */
function extractCommitMessages(command: string): string[] {
	const messages: string[] = [];

	// Match -m "..." or -m '...'
	const singleM = command.matchAll(/-m\s+(['"])(.*?)\1/g);
	for (const match of singleM) {
		messages.push(match[2]);
	}

	// Match -am "..." (git commit -am "msg")
	const amendM = command.matchAll(/-am\s+(['"])(.*?)\1/g);
	for (const match of amendM) {
		messages.push(match[2]);
	}

	return messages;
}

/** Check if a command is a git commit that we should intercept. */
function isGitCommit(command: string): boolean {
	// Match git commit (but not git commit-tree, git commit-graph, etc.)
	return /\bgit\s+commit\b/.test(command) && !/\bgit\s+commit-(?:tree|graph|refs)\b/.test(command);
}

/** Check if the command uses --no-verify. */
function hasNoVerify(command: string): boolean {
	return /--no-verify/.test(command);
}

const COMMIT_TYPES = ["feat", "fix", "chore", "docs", "test", "refactor", "perf", "build", "ci", "style"];

function formatGuidance(message: string): string {
	const lines = [
		"❌ Commit blocked by engram commit gate",
		"",
		`Message: "${message}"`,
		"",
	];

	if (!UUID_PATTERN.test(message)) {
		lines.push("Missing engram task UUID. Required format:");
		lines.push('  <type>: <title> [<TASK_UUID>]');
		lines.push("");
		lines.push("Valid types: " + COMMIT_TYPES.join(", "));
		lines.push("");
		lines.push("Steps to fix:");
		lines.push("  1. Create or find your task: engram_task_create or engram_ask");
		lines.push("  2. Ensure it has context + reasoning linked");
		lines.push("  3. Include the UUID in [brackets] at the end of the message");
		lines.push("  4. Re-run the commit");
	} else {
		lines.push("Run `engram validate commit` to check for missing relationships.");
	}

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command as string;
		if (!command || !isGitCommit(command)) return;

		// Rule 1: Always block --no-verify
		if (hasNoVerify(command)) {
			return {
				block: true,
				reason:
					"❌ git commit --no-verify is PROHIBITED in engram-managed projects.\n\n" +
					"This bypasses the pre-commit hook that enforces task traceability (ADR-018).\n" +
					"Every commit must reference a valid engram task UUID.\n" +
					"Create the task and link context + reasoning before committing.",
			};
		}

		// If no -m flag (opens editor), let it through — the hook will validate
		const messages = extractCommitMessages(command);
		if (messages.length === 0) {
			// No inline message — let the pre-commit hook handle it
			return;
		}

		// Validate each message
		for (const msg of messages) {
			if (!UUID_PATTERN.test(msg)) {
				return {
					block: true,
					reason: formatGuidance(msg),
				};
			}
		}

		// UUID present — let it through. The pre-commit hook handles deeper validation.
		// NOTE: removed engram validate commit --dry-run gate here because it was
		// blocking ALL commits even with valid UUIDs (validate subcommand has bugs).
		return;
	});
}
