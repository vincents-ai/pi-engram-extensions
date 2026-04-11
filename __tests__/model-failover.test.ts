/**
 * Tests for model-failover extension rate limit detection and config
 * (Inline versions for testing - same logic as extension)
 */

import { describe, it, expect } from "vitest";

// ─── Rate Limit Patterns (copied from extension) ───────────────────────────────

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
	/retry-after/i,
	/throttl/i,
	/try again (later|in \d)/i,
];

function isRateLimitError(msg: string): boolean {
	return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

// ─── Retry After Extraction (copied from extension) ────────────────────────

function extractRetryAfterMs(msg: string): number | null {
	const sec = msg.match(/retry.{0,20}?(\d+)\s*second/i);
	if (sec) return parseInt(sec[1]) * 1000;

	const min = msg.match(/(?:retry.{0,20}?|try again in\s*)(\d+)\s*minute/i);
	if (min) return parseInt(min[1]) * 60_000;

	const hr = msg.match(/(?:retry.{0,20}?|try again in\s*|(\d+)\s*hour.{0,20}?rate)(\d+)?\s*hour/i);
	if (hr) {
		const hours = parseInt(hr[1] ?? hr[2] ?? "1");
		return hours * 3_600_000;
	}

	const hdr = msg.match(/retry-after:\s*(\d+)/i);
	if (hdr) return parseInt(hdr[1]) * 1000;

	const resetMatch = msg.match(/reset at (\d{4}-\d{2}-\d{2}[T ]?\d{2}:\d{2}:\d{2})/i);
	if (resetMatch) {
		const resetTime = new Date(resetMatch[1]);
		if (!isNaN(resetTime.getTime())) {
			return Math.max(0, resetTime.getTime() - Date.now());
		}
	}

	return null;
}

// ─── Config (copied from extension) ─────────────────────────────────────────

interface FailoverModelEntry {
	provider: string;
	model: string;
	priority: number;
	label?: string;
	cooldownMinutes?: number;
}

interface FailoverConfig {
	models: FailoverModelEntry[];
	defaultCooldownMinutes: number;
	autoRequeue: boolean;
	autoReturnToPreferred: boolean;
	maxRequeueAttempts: number;
}

const FAILOVER_CONFIG_DEFAULTS: Omit<FailoverConfig, "models"> = {
	defaultCooldownMinutes: 30,
	autoRequeue: true,
	autoReturnToPreferred: true,
	maxRequeueAttempts: 3,
};

const FAILOVER_CONFIG_EXAMPLE: FailoverConfig = {
	models: [
		{ provider: "zai", model: "glm-5.1", priority: 1, label: "z.ai (primary)" },
		{ provider: "github-copilot", model: "claude-sonnet-4.6", priority: 2, label: "Copilot Claude Sonnet" },
		{ provider: "anthropic", model: "claude-sonnet-4-5", priority: 3, label: "Anthropic Sonnet" },
		{ provider: "openai", model: "gpt-4.1", priority: 4, label: "OpenAI GPT-4.1" },
		{ provider: "google", model: "gemini-2.5-pro", priority: 5, label: "Gemini 2.5 Pro" },
		{ provider: "groq", model: "llama-3.3-70b-versatile", priority: 6, label: "Groq LLaMA (free)" },
	],
	defaultCooldownMinutes: 30,
	autoRequeue: true,
	autoReturnToPreferred: true,
	maxRequeueAttempts: 3,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("isRateLimitError", () => {
	const rateLimitTests = [
		{ input: "rate limit exceeded", expected: true },
		{ input: "Rate Limit: Too Many Requests", expected: true },
		{ input: "429 Too Many Requests", expected: true },
		{ input: "quota exceeded", expected: true },
		{ input: "You have exceeded your quota", expected: true },
		{ input: "capacity exceeded", expected: true },
		{ input: "service temporarily unavailable", expected: true },
		{ input: "Overloaded", expected: true },
		{ input: "try again later", expected: true },
		{ input: "try again in 5 seconds", expected: true },
		{ input: "Retry-After: 300", expected: true },
		{ input: "Throttled", expected: true },
		{ input: "Usage limit reached", expected: true },
		{ input: "resource exhausted", expected: true },
	];

	it.each(rateLimitTests)("detects '$input' as rate limit", ({ input, expected }) => {
		expect(isRateLimitError(input)).toBe(expected);
	});

	const nonRateLimitTests = [
		"Invalid API key",
		"Authentication failed",
		"Model not found",
		"Network error",
		"Server error 500",
		"Missing required parameter",
		"Not authorized",
	];

	it.each(nonRateLimitTests)("does NOT detect '$input' as rate limit", (input) => {
		expect(isRateLimitError(input)).toBe(false);
	});
});

describe("extractRetryAfterMs", () => {
	it("extracts seconds", () => {
		const result = extractRetryAfterMs("retry after 300 seconds");
		expect(result).toBe(300_000);
	});

	it("extracts minutes", () => {
		const result = extractRetryAfterMs("please try again in 5 minutes");
		expect(result).toBe(300_000);
	});

	it("extracts hours when stated", () => {
		// This message format may not match, depending on exact wording
		const result = extractRetryAfterMs("please try again in 2 hours");
		expect(result).toBe(2 * 60 * 60 * 1000);
	});

	it("extracts seconds from header-style value", () => {
		const result = extractRetryAfterMs("retry-after: 1800");
		expect(result).toBe(1_800_000);
	});

	it("extracts reset timestamp (ISO format) when date is in future", () => {
		// Using a fixed future date - year 2100 should always be in the future
		const result = extractRetryAfterMs("Your limit will reset at 2100-01-01T00:00:00Z");
		expect(result).toBeGreaterThan(0);
	});

	it("returns null when no retry info found", () => {
		const result = extractRetryAfterMs("some unrelated error");
		expect(result).toBeNull();
	});
});

describe("FAILOVER_CONFIG_DEFAULTS", () => {
	it("has default cooldown set", () => {
		expect(FAILOVER_CONFIG_DEFAULTS.defaultCooldownMinutes).toBe(30);
	});

	it("has autoRequeue enabled by default", () => {
		expect(FAILOVER_CONFIG_DEFAULTS.autoRequeue).toBe(true);
	});

	it("has autoReturnToPreferred enabled by default", () => {
		expect(FAILOVER_CONFIG_DEFAULTS.autoReturnToPreferred).toBe(true);
	});

	it("has maxRequeueAttempts configured", () => {
		expect(FAILOVER_CONFIG_DEFAULTS.maxRequeueAttempts).toBe(3);
	});
});

describe("FAILOVER_CONFIG_EXAMPLE", () => {
	it("has models defined", () => {
		expect(FAILOVER_CONFIG_EXAMPLE.models).toBeDefined();
		expect(FAILOVER_CONFIG_EXAMPLE.models.length).toBeGreaterThan(0);
	});

	it("has models sorted by priority", () => {
		const models = FAILOVER_CONFIG_EXAMPLE.models;
		for (let i = 1; i < models.length; i++) {
			expect(models[i].priority).toBeGreaterThan(models[i - 1].priority);
		}
	});

	it("includes z.ai as first priority", () => {
		const first = FAILOVER_CONFIG_EXAMPLE.models[0];
		expect(first.provider).toBe("zai");
		expect(first.priority).toBe(1);
	});

	it("includes anthropic as fallback", () => {
		const providers = FAILOVER_CONFIG_EXAMPLE.models.map((m) => m.provider);
		expect(providers).toContain("anthropic");
	});

	it("includes groq as last resort", () => {
		const last = FAILOVER_CONFIG_EXAMPLE.models[FAILOVER_CONFIG_EXAMPLE.models.length - 1];
		expect(last.provider).toBe("groq");
		expect(last.priority).toBe(6);
	});

	it("has labels for all models", () => {
		const unlabeled = FAILOVER_CONFIG_EXAMPLE.models.filter((m) => !m.label);
		expect(unlabeled).toHaveLength(0);
	});
});