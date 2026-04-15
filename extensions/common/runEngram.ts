/**
 * Shared runEngram helper — runs engram CLI commands with consistent error handling.
 * Used by all extensions to avoid duplication.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EngramResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface EngramOptions {
	timeout?: number;
	cwd?: string;
	input?: string;
	maxBuffer?: number;
}

/**
 * Run an engram CLI command and return structured result.
 * Never throws — errors are captured in the return object.
 */
export async function runEngram(
	args: string[],
	options?: EngramOptions,
): Promise<EngramResult> {
	const spawnOpts: Parameters<typeof execFileAsync>[2] = {
		maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
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

/** Parse a UUID from engram output. */
export function parseUuid(output: string): string | null {
	const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
	return match ? match[0] : null;
}
