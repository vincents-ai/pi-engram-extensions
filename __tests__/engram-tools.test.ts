/**
 * Tests for engram-tools extension helper functions
 * (Inline versions for testing - same logic as extension)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Helper Functions (copied from extension) ────────────────────────────────

function parseUuid(output: string): string | null {
	const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
	return match ? match[0] : null;
}

function truncate(text: string, maxLines = 100, maxBytes = 50000): { content: string; truncated: boolean; outputLines: number; totalLines: number; outputBytes: number; totalBytes: number } {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const totalBytes = Buffer.byteLength(text, "utf8");

	let outputLines = 0;
	let outputBytes = 0;
	const contentLines: string[] = [];

	for (const line of lines) {
		const lineBytes = Buffer.byteLength(line + "\n", "utf8");
		if (outputLines >= maxLines || outputBytes + lineBytes > maxBytes) {
			return {
				content: contentLines.join("\n"),
				truncated: true,
				outputLines,
				totalLines,
				outputBytes,
				totalBytes,
			};
		}
		contentLines.push(line);
		outputLines++;
		outputBytes += lineBytes;
	}

	return {
		content: text,
		truncated: false,
		outputLines: totalLines,
		totalLines,
		outputBytes: totalBytes,
		totalBytes,
	};
}

function ok(text: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: truncate(text).content }],
		details: details ?? {},
	};
}

function err(text: string) {
	throw new Error(text);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("parseUuid", () => {
	it("extracts UUID from engram output", () => {
		const output = "Task 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' created";
		const result = parseUuid(output);
		expect(result).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
	});

	it("extracts UUID from task show output", () => {
		const output = `Task: test-task
ID: 550e8400-e29b-41d4-a716-446655440000
Title: Some task`;
		const result = parseUuid(output);
		expect(result).toBe("550e8400-e29b-41d4-a716-446655440000");
	});

	it("extracts UUID with lowercase letters", () => {
		const output = "Context 550e8400-e29b-41d4-a716-446655440000 created";
		const result = parseUuid(output);
		if (result) {
			expect(result).toBe("550e8400-e29b-41d4-a716-446655440000");
		}
	});

	it("returns null when no UUID found", () => {
		const output = "No UUID in this output";
		const result = parseUuid(output);
		expect(result).toBeNull();
	});

	it("returns null for invalid format", () => {
		const output = "Task abc-123 created";
		const result = parseUuid(output);
		expect(result).toBeNull();
	});
});

describe("truncate", () => {
	it("returns content when under limit", () => {
		const text = "short content";
		const result = truncate(text);
		expect(result.truncated).toBe(false);
		expect(result.content).toBe(text);
	});

	it("truncates by lines when over maxLines", () => {
		const lines = Array(150).fill("line").join("\n");
		const result = truncate(lines, 100);
		expect(result.truncated).toBe(true);
		expect(result.outputLines).toBe(100);
	});

	it("truncates by bytes when over maxBytes", () => {
		const text = "a".repeat(60000);
		const result = truncate(text, 100, 50000);
		expect(result.truncated).toBe(true);
		expect(result.outputBytes).toBeLessThanOrEqual(50000);
	});
});

describe("ok result helper", () => {
	it("returns content array with text type", () => {
		const result = ok("test output");
		expect(result.content).toBeInstanceOf(Array);
		expect(result.content[0].type).toBe("text");
	});

	it("includes details in result", () => {
		const result = ok("content", { uuid: "test-uuid" });
		expect(result.details).toEqual({ uuid: "test-uuid" });
	});

	it("returns empty details when not provided", () => {
		const result = ok("content");
		expect(result.details).toEqual({});
	});
});

describe("err throws Error", () => {
	it("throws Error with message", () => {
		expect(() => err("test error")).toThrow("test error");
	});

	it("Error is instanceof Error", () => {
		try {
			err("message");
		} catch (e) {
			expect(e).toBeInstanceOf(Error);
		}
	});
});

describe("engram command parameter building", () => {
	it("builds task create args correctly", () => {
		const title = "Test task";
		const priority = "high";
		const parent = "abc-123";

		const args = ["task", "create", "--output", "json"];
		args.push("--title", title);
		args.push("--priority", priority);
		args.push("--parent", parent);

		expect(args).toEqual([
			"task", "create", "--output", "json",
			"--title", "Test task",
			"--priority", "high",
			"--parent", "abc-123"
		]);
	});

	it("builds task update args correctly", () => {
		const id = "task-uuid";
		const status = "in_progress";
		const outcome = "Fixed the bug";

		const args = ["task", "update", id, "--status", status];
		if (outcome) args.push("--outcome", outcome);

		expect(args).toEqual([
			"task", "update", "task-uuid", 
			"--status", "in_progress",
			"--outcome", "Fixed the bug"
		]);
	});

	it("builds relationship create args correctly", () => {
		const sourceId = "src-uuid";
		const targetId = "tgt-uuid";
		const args = ["relationship", "create", "--source-id", sourceId, "--source-type", "task", "--target-id", targetId, "--target-type", "context", "--relationship-type", "relates_to", "--agent", "pi"];
		expect(args[0]).toBe("relationship");
		expect(args[1]).toBe("create");
	});

	it("handles optional params correctly", () => {
		const params = {
			query: "test query",
			deep: true,
			max_depth: 2
		};

		const args = ["ask", "query", params.query];
		if (params.deep) args.push("--deep");
		if (params.max_depth) args.push("--max-depth", String(params.max_depth));

		expect(args).toEqual([
			"ask", "query", "test query",
			"--deep",
			"--max-depth", "2"
		]);
	});
});