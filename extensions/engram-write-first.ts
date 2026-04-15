/**
 * Engram Write-First — Soft enforcement of write-before-responding
 *
 * Tracks engram entity writes per turn and warns the agent on agent_end
 * if it produced substantive work without storing findings in engram.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runEngram, parseUuid } from "./common/runEngram.js";

const ENGRAM_WRITE_TOOLS = new Set([
	"engram_context_create",
	"engram_reasoning_create",
	"engram_adr_create",
]);

const SUBSTANTIVE_TOOLS = new Set([
	"edit",
	"write",
	"bash",
]);

export default function (pi: ExtensionAPI) {
	let turnHasEngramWrite = false;
	let turnHasSubstantiveWork = false;
	let consecutiveTurnsWithoutWrite = 0;
	let agentActive = false;

	pi.on("agent_start", () => {
		agentActive = true;
		consecutiveTurnsWithoutWrite = 0;
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentActive = false;

		if (consecutiveTurnsWithoutWrite >= 3) {
			const count = consecutiveTurnsWithoutWrite;
			const warning =
				`⚠ **Engram write-first violation**: ${count} consecutive turn${
					count === 1 ? "" : "s"
				} with substantive work (bash/edit/write) and no engram writes.\n\n` +
				`Store your findings now before continuing:\n` +
				`- \`engram_context_create\` — facts, observations, command output\n` +
				`- \`engram_reasoning_create\` — decisions and logic chains\n` +
				`- \`engram_adr_create\` — architectural choices\n\n` +
				`Always follow with \`engram_relationship_create\` to link to the active task UUID.`;

			// Show in TUI
			if (ctx.hasUI) {
				ctx.ui.notify(warning, "warning");
			}

			// Inject into LLM context — visible at the start of the next turn
			pi.sendMessage({
				customType: "engram-write-first-warning",
				content: warning,
				display: true,
			});
		}

		consecutiveTurnsWithoutWrite = 0;
	});

	pi.on("turn_start", () => {
		turnHasEngramWrite = false;
		turnHasSubstantiveWork = false;
	});

	pi.on("turn_end", () => {
		if (agentActive && turnHasSubstantiveWork && !turnHasEngramWrite) {
			consecutiveTurnsWithoutWrite++;
		} else if (turnHasEngramWrite) {
			consecutiveTurnsWithoutWrite = 0;
		}
	});

	pi.on("tool_result", (event) => {
		if (ENGRAM_WRITE_TOOLS.has(event.toolName) && !event.isError) {
			turnHasEngramWrite = true;
		}
		if (SUBSTANTIVE_TOOLS.has(event.toolName) && !event.isError) {
			turnHasSubstantiveWork = true;
		}
	});
}
