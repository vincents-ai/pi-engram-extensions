/**
 * Engram Status — Persistent engram status display in the pi footer
 *
 * Shows the active engram session, current task, and workspace health
 * in the pi TUI status bar. Updates on relevant engram tool calls.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runEngram, parseUuid } from "./common/runEngram.js";

export default function (pi: ExtensionAPI) {
	let currentSessionId: string | null = null;
	let currentTaskId: string | null = null;
	let taskStatus: string | null = null;
	let ready = false;

	async function refreshStatus(ctx: { hasUI: boolean; ui: { setStatus: (key: string, value?: string) => void } }) {
		if (!ready || !ctx.hasUI) return;

		const parts: string[] = [];

		if (currentSessionId) {
			parts.push(currentSessionId.slice(0, 8));
		}

		if (currentTaskId) {
			const taskPart = taskStatus
				? currentTaskId.slice(0, 8) + ":" + taskStatus
				: currentTaskId.slice(0, 8);
			parts.push(taskPart);
		}

		if (parts.length > 0) {
			ctx.ui.setStatus("engram", "⚙ " + parts.join(" | "));
		} else {
			ctx.ui.setStatus("engram", "⚙ ready");
		}
	}

	// ── Check workspace on startup ────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const info = await runEngram(["info"]);
		ready = info.code === 0;
		await refreshStatus(ctx);
	});

	// ── Track engram tool results ─────────────────────────────────────────

	pi.on("tool_result", async (event, ctx) => {
		const text = event.content.find((c) => c.type === "text")?.text ?? "";

		switch (event.toolName) {
			case "engram_session_start": {
				const uuid = parseUuid(text);
				if (uuid) currentSessionId = uuid;
				break;
			}
			case "engram_session_end": {
				currentSessionId = null;
				break;
			}
			case "engram_task_create": {
				const uuid = parseUuid(text);
				if (uuid) {
					currentTaskId = uuid;
					taskStatus = "todo";
				}
				break;
			}
			case "engram_task_update": {
				// Extract status from the result text
				const statusMatch = text.match(/status[:\s]+(\w+)/i);
				if (statusMatch) {
					taskStatus = statusMatch[1].toLowerCase();
				}
				// Check if the result mentions "done"
				if (text.includes("done") && !text.includes("in_progress")) {
					taskStatus = "done";
				}
				break;
			}
			case "engram_next": {
				// Extract task UUID from next output
				const nextUuid = parseUuid(text);
				if (nextUuid) {
					currentTaskId = nextUuid;
					taskStatus = "next";
				}
				break;
			}
			case "engram_validate": {
				// Could show validation status, but keep it simple
				break;
			}
		}

		await refreshStatus(ctx);
	});
}
