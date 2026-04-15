/**
 * Model Failover Extension
 *
 * Automatically switches to fallback models when rate limits are hit, then
 * re-queues the failed message so the conversation continues uninterrupted.
 * After a configurable cool-down, tries to return to higher-priority models.
 *
 * Config: .pi/failover.json (see FAILOVER_CONFIG_EXAMPLE below)
 *
 * Commands:
 *   /failover-status   — show current model state and rate-limit timers
 *   /failover-list     — show the full priority list and which models are available
 *   /failover-reset    — clear all rate-limit cooldowns and return to primary
 *   /failover-skip     — skip the current model and force the next fallback
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Config ──────────────────────────────────────────────────────────────────

interface FailoverModelEntry {
	provider: string;
	model: string;
	priority: number;        // 1 = highest (most preferred)
	label?: string;          // display name
	cooldownMinutes?: number; // override global cooldown for this model
}

interface FailoverConfig {
	models: FailoverModelEntry[];
	defaultCooldownMinutes: number; // default time before retrying a rate-limited model
	autoRequeue: boolean;           // automatically re-send the failed message after switching
	autoReturnToPreferred: boolean; // try returning to higher-priority model on each new turn
	maxRequeueAttempts: number;     // max times to auto-requeue before giving up
}

const FAILOVER_CONFIG_DEFAULTS: Omit<FailoverConfig, "models"> = {
	defaultCooldownMinutes: 30,
	autoRequeue: true,
	autoReturnToPreferred: true,
	maxRequeueAttempts: 3,
};

// Written to .pi/failover.json if the file doesn't exist yet
const FAILOVER_CONFIG_EXAMPLE: FailoverConfig = {
	models: [
		{ provider: "zai",           model: "glm-5.1",           priority: 1, label: "z.ai (primary)" },
		{ provider: "github-copilot", model: "claude-sonnet-4.6", priority: 2, label: "Copilot Claude Sonnet" },
		{ provider: "anthropic",      model: "claude-sonnet-4-5", priority: 3, label: "Anthropic Sonnet" },
		{ provider: "openai",         model: "gpt-4.1",           priority: 4, label: "OpenAI GPT-4.1" },
		{ provider: "google",         model: "gemini-2.5-pro",    priority: 5, label: "Gemini 2.5 Pro" },
		{ provider: "groq",           model: "llama-3.3-70b-versatile", priority: 6, label: "Groq LLaMA (free)" },
	],
	defaultCooldownMinutes: 30,
	autoRequeue: true,
	autoReturnToPreferred: true,
	maxRequeueAttempts: 3,
};

// ─── Rate Limit Patterns ──────────────────────────────────────────────────────

const RATE_LIMIT_PATTERNS: RegExp[] = [
	/rate.?limit/i,
	/too many requests/i,
	/quota.?exceed/i,
	/exceed.*quota/i,
	/quota.*reset/i,
	/capacity.?exceed/i,
	/overloaded/i,
	/temporarily unavailable/i,
	/service.?unavailable/i,
	/\b429\b/,
	/request.?limit/i,
	/usage.?limit/i,
	/resource.?exhaust/i,
	/retry-after/i,              // header-style throttle response
	/throttl/i,
	/try again (later|in \d)/i,  // generic retry hint
];

/** Returns true if this error message looks like a rate limit. */
function isRateLimitError(msg: string): boolean {
	return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

/**
 * Try to extract a retry-after duration (in ms) from an error message.
 * Returns null if none found — caller should use the configured default.
 */
function extractRetryAfterMs(msg: string): number | null {
	// "retry after 300 seconds"
	const sec = msg.match(/retry.{0,20}?(\d+)\s*second/i);
	if (sec) return parseInt(sec[1]) * 1000;

	// "retry after 5 minutes" / "try again in 30 minutes"
	const min = msg.match(/(?:retry.{0,20}?|try again in\s*)(\d+)\s*minute/i);
	if (min) return parseInt(min[1]) * 60_000;

	// "5 hour rate limit" / "try again in 2 hours"
	const hr = msg.match(/(?:retry.{0,20}?|try again in\s*|(\d+)\s*hour.{0,20}?rate)(\d+)?\s*hour/i);
	if (hr) {
		const hours = parseInt(hr[1] ?? hr[2] ?? "1");
		return hours * 3_600_000;
	}

	// "retry-after: 1800" (seconds as header value in error text)
	const hdr = msg.match(/retry-after:\s*(\d+)/i);
	if (hdr) return parseInt(hdr[1]) * 1000;

	// "Your limit will reset at 2026-04-11 20:49:38" (z.ai style reset time)
	const resetMatch = msg.match(/reset at (\d{4}-\d{2}-\d{2}[T ]?\d{2}:\d{2}:\d{2})/i);
	if (resetMatch) {
		const resetTime = new Date(resetMatch[1]);
		if (!isNaN(resetTime.getTime())) {
			return Math.max(0, resetTime.getTime() - Date.now());
		}
	}

	return null;
}

// ─── State ────────────────────────────────────────────────────────────────────

interface ModelCooldown {
	provider: string;
	model: string;
	rateLimitedAt: number;        // epoch ms when the rate limit was hit
	cooldownUntil: number;        // epoch ms when we should retry
	errorSnippet: string;         // first 200 chars of the error
}

interface FailoverState {
	config: FailoverConfig;
	cooldowns: Map<string, ModelCooldown>;  // key: "provider/model"
	currentPriority: number | null;         // priority of the currently active model (null = untracked)
	lastPrompt: string | null;             // last user prompt (for auto-requeue)
	requeueAttempts: number;               // how many times we've auto-requeued in this chain
	failoverActive: boolean;               // are we currently in a failover chain?
	handledErrorIds: Set<string>;          // dedup: prevent handling same error twice
}

function modelKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function findConfigEntry(config: FailoverConfig, provider: string, model: string): FailoverModelEntry | undefined {
	return config.models.find((m) => m.provider === provider && m.model === model);
}

function isOnCooldown(state: FailoverState, provider: string, model: string): boolean {
	const cd = state.cooldowns.get(modelKey(provider, model));
	if (!cd) return false;
	return Date.now() < cd.cooldownUntil;
}

function cooldownRemainingLabel(state: FailoverState, provider: string, model: string): string {
	const cd = state.cooldowns.get(modelKey(provider, model));
	if (!cd) return "";
	const remaining = cd.cooldownUntil - Date.now();
	if (remaining <= 0) return "";
	if (remaining < 60_000) return `${Math.ceil(remaining / 1000)}s`;
	if (remaining < 3_600_000) return `${Math.ceil(remaining / 60_000)}m`;
	return `${(remaining / 3_600_000).toFixed(1)}h`;
}

// ─── Config Loading ───────────────────────────────────────────────────────────

function findConfigPath(cwd: string): string {
	// Look in project .pi/ first, then user home
	const candidates = [
		path.join(cwd, ".pi", "failover.json"),
		path.join(os.homedir(), ".pi", "agent", "failover.json"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	return candidates[0]; // default write location
}

function loadConfig(cwd: string): FailoverConfig {
	const configPath = findConfigPath(cwd);
	if (!fs.existsSync(configPath)) {
		// Write example config so the user can edit it
		try {
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(configPath, JSON.stringify(FAILOVER_CONFIG_EXAMPLE, null, 2) + "\n");
		} catch {
			// Can't write — use defaults silently
		}
		return { ...FAILOVER_CONFIG_DEFAULTS, models: FAILOVER_CONFIG_EXAMPLE.models };
	}

	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as Partial<FailoverConfig>;
		return {
			...FAILOVER_CONFIG_DEFAULTS,
			...parsed,
			models: parsed.models ?? FAILOVER_CONFIG_EXAMPLE.models,
		};
	} catch {
		return { ...FAILOVER_CONFIG_DEFAULTS, models: FAILOVER_CONFIG_EXAMPLE.models };
	}
}

// ─── Model Switching ──────────────────────────────────────────────────────────

/**
 * Find the next best available model from the priority list.
 * Skips: rate-limited models, models without API keys, the current model.
 */
function findNextModel(
	state: FailoverState,
	ctx: ExtensionContext,
	skipCurrent = true,
): FailoverModelEntry | null {
	const sorted = [...state.config.models].sort((a, b) => a.priority - b.priority);

	for (const entry of sorted) {
		// Skip current model if requested
		if (skipCurrent) {
			const cur = ctx.model;
			if (cur && cur.provider === entry.provider && cur.id === entry.model) continue;
		}

		// Skip rate-limited models still on cooldown
		if (isOnCooldown(state, entry.provider, entry.model)) continue;

		// Check API key availability
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model) continue;
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) continue;

		return entry;
	}
	return null;
}

/**
 * Find the highest-priority model that is available (not rate-limited, has key).
 */
function findPreferredModel(
	state: FailoverState,
	ctx: ExtensionContext,
): FailoverModelEntry | null {
	const sorted = [...state.config.models].sort((a, b) => a.priority - b.priority);
	for (const entry of sorted) {
		if (isOnCooldown(state, entry.provider, entry.model)) continue;
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model) continue;
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) continue;
		return entry;
	}
	return null;
}

async function switchToModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	entry: FailoverModelEntry,
): Promise<boolean> {
	const model = ctx.modelRegistry.find(entry.provider, entry.model);
	if (!model) return false;
	const ok = await pi.setModel(model);
	return ok;
}

function entryLabel(entry: FailoverModelEntry): string {
	return entry.label ?? `${entry.provider}/${entry.model}`;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let manualOverride: boolean = false;
	let state: FailoverState = {
		config: { ...FAILOVER_CONFIG_DEFAULTS, models: [] },
		cooldowns: new Map(),
		currentPriority: null,
		lastPrompt: null,
		requeueAttempts: 0,
		failoverActive: false,
		handledErrorIds: new Set(),
	};

	// ── session_start: load config, set initial status ─────────────────────

	pi.on("session_start", (_event, ctx) => {
		state = {
			...state,
			config: loadConfig(ctx.cwd),
			cooldowns: new Map(),
			currentPriority: null,
			lastPrompt: null,
			requeueAttempts: 0,
			failoverActive: false,
			handledErrorIds: new Set(),
		};
		updateStatus(ctx);
	});

	// ── model_select: track which model is active ──────────────────────────

	pi.on("model_select", (event, ctx) => {
		const entry = findConfigEntry(state.config, event.model.provider, event.model.id);
		state.currentPriority = entry?.priority ?? null;

		// If user manually picked a model, respect their choice
		if (event.source !== "session_restore") {
			state.requeueAttempts = 0;
			state.failoverActive = false;
			manualOverride = true;
		}
		updateStatus(ctx);
	});

	// ── before_agent_start: cache prompt + try returning to preferred ──────

	pi.on("before_agent_start", async (event, ctx) => {
		// Cache the raw prompt text for potential re-queue
		if (typeof event.prompt === "string") {
			state.lastPrompt = event.prompt;
		}

		// If user manually chose a model, don't override it
		if (manualOverride) return;

		// If auto-return is enabled and we're not on the preferred model, check cooldowns
		if (state.config.autoReturnToPreferred && state.currentPriority !== null && state.currentPriority > 1) {
			const preferred = findPreferredModel(state, ctx);
			if (preferred && preferred.priority < (state.currentPriority ?? Infinity)) {
				const cur = ctx.model;
				const alreadyPreferred = cur && cur.provider === preferred.provider && cur.id === preferred.model;
				if (!alreadyPreferred) {
					const ok = await switchToModel(pi, ctx, preferred);
					if (ok) {
						ctx.ui.notify(
							`↩ Returned to preferred model: ${entryLabel(preferred)} (cooldown expired)`,
							"success",
						);
						state.currentPriority = preferred.priority;
						state.failoverActive = false;
						state.requeueAttempts = 0;
						updateStatus(ctx);
					}
				}
			}
		}
	});

	// ── message_update: detect rate-limit errors ───────────────────────────

	pi.on("message_update", async (event, ctx) => {
		const ae = event.assistantMessageEvent;

		// Only act on error events
		if (ae.type !== "error") return;

		const errorMsg = ae.error?.errorMessage ?? "";
		if (!errorMsg) return;

		// Dedup: only handle each unique error message once per turn
		const errorId = `${Date.now().toString().slice(-6)}-${errorMsg.slice(0, 40)}`;
		if (state.handledErrorIds.has(errorId)) return;
		// Use a short dedup window (same error within 2s = duplicate)
		const shortKey = errorMsg.slice(0, 40);
		for (const existing of state.handledErrorIds) {
			if (existing.endsWith(shortKey)) return;
		}
		state.handledErrorIds.add(errorId);
		// Trim the set
		if (state.handledErrorIds.size > 20) {
			const [first] = state.handledErrorIds;
			state.handledErrorIds.delete(first);
		}

		// Only failover on rate-limit errors (not auth errors, network errors, etc.)
		if (!isRateLimitError(errorMsg)) {
			// Show the error but don't switch
			ctx.ui.notify(`API error: ${errorMsg.slice(0, 120)}`, "error");
			return;
		}

		const currentModel = ctx.model;
		if (!currentModel) return;

		// Record the cooldown for this model
		const configEntry = findConfigEntry(state.config, currentModel.provider, currentModel.id);
		const cooldownMs = extractRetryAfterMs(errorMsg)
			?? (configEntry?.cooldownMinutes ?? state.config.defaultCooldownMinutes) * 60_000;
		const cooldown: ModelCooldown = {
			provider: currentModel.provider,
			model: currentModel.id,
			rateLimitedAt: Date.now(),
			cooldownUntil: Date.now() + cooldownMs,
			errorSnippet: errorMsg.slice(0, 200),
		};
		state.cooldowns.set(modelKey(currentModel.provider, currentModel.id), cooldown);

		const cooldownLabel = cooldownMs < 60_000
			? `${Math.round(cooldownMs / 1000)}s`
			: cooldownMs < 3_600_000
			? `${Math.round(cooldownMs / 60_000)}m`
			: `${(cooldownMs / 3_600_000).toFixed(1)}h`;

		ctx.ui.notify(
			`⚠️ Rate limit hit on ${currentModel.provider}/${currentModel.id} (cooldown: ${cooldownLabel})`,
			"warning",
		);

		// Find the next available model
		const next = findNextModel(state, ctx, true);
		if (!next) {
			ctx.ui.notify(
				"⛔ All models in the failover list are rate-limited or unavailable. Edit .pi/failover.json to add more.",
				"error",
			);
			updateStatus(ctx);
			return;
		}

		// Switch model
		const ok = await switchToModel(pi, ctx, next);
		if (!ok) {
			ctx.ui.notify(`Failed to switch to ${entryLabel(next)} (no API key?)`, "error");
			updateStatus(ctx);
			return;
		}

		state.currentPriority = next.priority;
		state.failoverActive = true;

		ctx.ui.notify(
			`🔄 Switched to ${entryLabel(next)} (priority ${next.priority})`,
			"info",
		);
		updateStatus(ctx);

		// Clear manual override when a rate limit forces a switch
		manualOverride = false;

		// Auto-requeue the failed message if configured
		if (state.config.autoRequeue && state.lastPrompt && state.requeueAttempts < state.config.maxRequeueAttempts) {
			state.requeueAttempts++;
			ctx.ui.notify(
				`↩ Continuing on ${entryLabel(next)}... (attempt ${state.requeueAttempts}/${state.config.maxRequeueAttempts})`,
				"info",
			);
			pi.sendUserMessage("Continue where you left off on the previous model.", { deliverAs: "followUp" });
		} else if (state.requeueAttempts >= state.config.maxRequeueAttempts) {
			ctx.ui.notify(
				`⚠️ Max requeue attempts (${state.config.maxRequeueAttempts}) reached. Please resend manually.`,
				"warning",
			);
		}
	});

	// ── Footer status ──────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		const cur = ctx.model;
		if (!cur) {
			ctx.ui.setStatus("failover", undefined);
			return;
		}

		const entry = findConfigEntry(state.config, cur.provider, cur.id);
		if (!entry) {
			// Model not in failover list — no status
			ctx.ui.setStatus("failover", undefined);
			return;
		}

		const onCooldown = isOnCooldown(state, cur.provider, cur.id);
		const activeCooldowns = [...state.cooldowns.values()].filter((c) => Date.now() < c.cooldownUntil).length;

		let label: string;
		if (state.failoverActive) {
			label = `🔄 ${entryLabel(entry)} [failover, ${activeCooldowns} limited]`;
		} else if (activeCooldowns > 0) {
			label = `✓ ${entryLabel(entry)} [${activeCooldowns} cooling]`;
		} else {
			label = `✓ ${entryLabel(entry)}`;
		}

		ctx.ui.setStatus("failover", label);
	}

	// ── Commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("failover-status", {
		description: "Show current model failover state: active model, cooldowns, and priority list",
		handler: async (_args, ctx) => {
			const config = state.config;
			const cur = ctx.model;
			const now = Date.now();
			const lines: string[] = ["Model Failover Status\n"];

			lines.push(`Active model: ${cur ? `${cur.provider}/${cur.id}` : "(none)"}`);
			if (state.failoverActive) lines.push("Mode: FAILOVER (switched away from primary)");
			if (state.requeueAttempts > 0) lines.push(`Requeue attempts this chain: ${state.requeueAttempts}/${config.maxRequeueAttempts}`);
			lines.push("");

			lines.push("Priority list:");
			const sorted = [...config.models].sort((a, b) => a.priority - b.priority);
			for (const entry of sorted) {
				const model = ctx.modelRegistry.find(entry.provider, entry.model);
				const hasKey = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
				const cd = state.cooldowns.get(modelKey(entry.provider, entry.model));
				const onCd = cd && now < cd.cooldownUntil;
				const remaining = onCd ? cooldownRemainingLabel(state, entry.provider, entry.model) : null;

				const isCurrent = cur && cur.provider === entry.provider && cur.id === entry.model;
				const icon = isCurrent ? "→" : " ";
				const keyIcon = !hasKey ? "🔑?" : onCd ? "⏱" : "✓";
				const name = entryLabel(entry);
				const cooldownStr = remaining ? ` (cooldown: ${remaining})` : "";
				const keyStr = !hasKey ? " (no API key)" : "";

				lines.push(`  ${icon} [${entry.priority}] ${keyIcon} ${name}${cooldownStr}${keyStr}`);
				if (onCd && cd) {
					lines.push(`         Error: ${cd.errorSnippet.slice(0, 80)}...`);
				}
			}

			lines.push("");
			lines.push(`Config: cooldown=${config.defaultCooldownMinutes}m, autoRequeue=${config.autoRequeue}, autoReturn=${config.autoReturnToPreferred}`);
			lines.push(`Edit: .pi/failover.json`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("failover-list", {
		description: "List all models in the failover priority list with their availability",
		handler: async (_args, ctx) => {
			const sorted = [...state.config.models].sort((a, b) => a.priority - b.priority);
			const lines = ["Failover model list:\n"];
			for (const entry of sorted) {
				const model = ctx.modelRegistry.find(entry.provider, entry.model);
				const hasKey = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
				const onCd = isOnCooldown(state, entry.provider, entry.model);
				const cdLabel = onCd ? ` ⏱ ${cooldownRemainingLabel(state, entry.provider, entry.model)}` : "";
				const avail = !model ? "not found" : !hasKey ? "no key" : onCd ? "cooling" : "ready";
				lines.push(`  [${entry.priority}] ${entryLabel(entry).padEnd(35)} ${avail}${cdLabel}`);
			}
			lines.push("\nUse /failover-reset to clear all cooldowns.");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("failover-reset", {
		description: "Clear all rate-limit cooldowns and return to the highest-priority available model",
		handler: async (_args, ctx) => {
			state.cooldowns.clear();
			state.requeueAttempts = 0;
			state.failoverActive = false;
			state.handledErrorIds.clear();
			manualOverride = false;

			const preferred = findPreferredModel(state, ctx);
			if (preferred) {
				const ok = await switchToModel(pi, ctx, preferred);
				if (ok) {
					state.currentPriority = preferred.priority;
					ctx.ui.notify(`✓ Cooldowns cleared. Switched to ${entryLabel(preferred)}.`, "success");
				} else {
					ctx.ui.notify(`Cooldowns cleared, but could not switch to ${entryLabel(preferred)} (no key?).`, "warning");
				}
			} else {
				ctx.ui.notify("Cooldowns cleared, but no models available.", "warning");
			}
			updateStatus(ctx);
		},
	});

	pi.registerCommand("failover-skip", {
		description: "Mark the current model as rate-limited and force a switch to the next fallback",
		handler: async (_args, ctx) => {
			const cur = ctx.model;
			if (!cur) {
				ctx.ui.notify("No active model.", "warning");
				return;
			}

			// Apply a short manual cooldown (5 minutes)
			const cooldownMs = 5 * 60_000;
			state.cooldowns.set(modelKey(cur.provider, cur.id), {
				provider: cur.provider,
				model: cur.id,
				rateLimitedAt: Date.now(),
				cooldownUntil: Date.now() + cooldownMs,
				errorSnippet: "(manually skipped)",
			});

			const next = findNextModel(state, ctx, true);
			if (!next) {
				ctx.ui.notify("No fallback available.", "error");
				return;
			}

			const ok = await switchToModel(pi, ctx, next);
			if (!ok) {
				ctx.ui.notify(`Could not switch to ${entryLabel(next)}.`, "error");
				return;
			}

			state.currentPriority = next.priority;
			state.failoverActive = true;
			ctx.ui.notify(`Skipped ${cur.provider}/${cur.id} → now on ${entryLabel(next)}`, "info");
			updateStatus(ctx);
		},
	});
}
