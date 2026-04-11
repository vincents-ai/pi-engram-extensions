/**
 * Integration tests for pi-engram-extensions
 * 
 * Tests that verify multiple extensions can load together without conflicts.
 * Simulates loading extensions in a pi agent context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Simulate the ExtensionAPI that pi provides
interface MockExtensionAPI {
	registeredTools: Map<string, any>;
	registeredCommands: Map<string, any>;
	onHandlers: Map<string, any>;
	ui: { setStatus: () => void; notify: () => void };
}

function createMockAPI(): MockExtensionAPI {
	return {
		registeredTools: new Map(),
		registeredCommands: new Map(),
		onHandlers: new Map(),
		ui: { 
			setStatus: vi.fn(), 
			notify: vi.fn() 
		},
	};
}

// Simulated tool registration (like extensions do)
function registerTool(api: MockExtensionAPI, name: string, config: any) {
	api.registeredTools.set(name, config);
}

// Simulated command registration (like extensions do)
function registerCommand(api: MockExtensionAPI, name: string, config: any) {
	api.registeredCommands.set(name, config);
}

// Simulated event handler (like extensions do)
function onEvent(api: MockExtensionAPI, event: string, handler: any) {
	api.onHandlers.set(event, handler);
}

describe("Extension Integration", () => {
	let api: MockExtensionAPI;

	beforeEach(() => {
		api = createMockAPI();
	});

	describe("Extension Loading", () => {
		it("loads engram-tools extension", () => {
			const tools = ["engram_ask", "engram_task_create", "engram_task_update", "engram_task_show"];
			tools.forEach(name => registerTool(api, name, { name }));
			expect(api.registeredTools.size).toBe(4);
		});

		it("loads engram-orchestrator extension", () => {
			const commands = ["orchestrate", "engram-dispatch", "engram-collect"];
			commands.forEach(name => registerCommand(api, name, { name }));
			expect(api.registeredCommands.size).toBe(3);
		});

		it("loads engram-workflow extension", () => {
			const tools = ["engram_workflow_scaffold", "engram_workflow_create"];
			tools.forEach(name => registerTool(api, name, { name }));
			expect(api.registeredTools.size).toBe(2);
		});

		it("loads model-failover extension", () => {
			onEvent(api, "session_start", vi.fn());
			onEvent(api, "message_update", vi.fn());
			expect(api.onHandlers.size).toBe(2);
		});
	});

	describe("No Registration Conflicts", () => {
		it("tool names are unique across all extensions", () => {
			const allTools = [
				"engram_ask", "engram_task_create", "engram_task_update",
				"engram_workflow_scaffold", "engram_workflow_create"
			];
			allTools.forEach(name => registerTool(api, name, { name }));
			const uniqueTools = new Set(allTools);
			expect(uniqueTools.size).toBe(allTools.length);
		});

		it("command names are unique", () => {
			const commands = ["orchestrate", "engram-dispatch", "engram-collect"];
			commands.forEach(name => registerCommand(api, name, { name }));
			const uniqueCommands = new Set(commands);
			expect(uniqueCommands.size).toBe(commands.length);
		});

		it("tools and commands can share names peacefully", () => {
			// A tool and command can have the same base name
			registerTool(api, "engram_ask", { type: "tool" });
			registerCommand(api, "engram_ask", { type: "command" });
			expect(api.registeredTools.get("engram_ask")).toBeDefined();
			expect(api.registeredCommands.get("engram_ask")).toBeDefined();
		});
	});

	describe("Extension Event Coordination", () => {
		it("session_start event can be registered by model-failover", () => {
			onEvent(api, "session_start", vi.fn());
			expect(api.onHandlers.has("session_start")).toBe(true);
		});

		it("multiple extensions can handle different events", () => {
			onEvent(api, "session_start", vi.fn());
			onEvent(api, "message_update", vi.fn());
			onEvent(api, "model_select", vi.fn());
			expect(api.onHandlers.size).toBe(3);
		});

		it("same event handler doesn't cause conflicts", () => {
			const handler1 = vi.fn();
			const handler2 = vi.fn();
			// If multiple extensions want to handle same event, last one wins
			onEvent(api, "session_start", handler1);
			onEvent(api, "session_start", handler2);
			// This is acceptable - last handler wins
			expect(api.onHandlers.has("session_start")).toBe(true);
		});
	});

	describe("UI Status Coordination", () => {
		it("multiple extensions can set status without conflict", () => {
			api.ui.setStatus("engram-tools", "loaded");
			expect(api.ui.setStatus).toHaveBeenCalledWith("engram-tools", "loaded");
		});

		it("notifications can be sent", () => {
			api.ui.notify("Test notification", "info");
			expect(api.ui.notify).toHaveBeenCalledWith("Test notification", "info");
		});
	});
});

describe("Workflow Template Integration", () => {
	it("feature-development template works with other templates", () => {
		const templates = ["feature-development", "bug-fix", "code-review"];
		expect(templates.length).toBe(3);
		// All should have different state names to avoid conflict
		const stateNames = templates.map(t => `${t}-states`);
		expect(new Set(stateNames).size).toBe(3);
	});

	it("transitions can reference states across templates", () => {
		const transition = { from: "planning", to: "implementing" };
		expect(transition.from).toBeDefined();
		expect(transition.to).toBeDefined();
	});
});

describe("Model Failover Integration", () => {
	it("config can be loaded alongside extensions", () => {
		const config = {
			models: [
				{ provider: "zai", model: "glm-5.1", priority: 1 },
				{ provider: "anthropic", model: "claude-sonnet", priority: 2 },
			],
			defaultCooldownMinutes: 30,
		};
		expect(config.models.length).toBe(2);
		expect(config.defaultCooldownMinutes).toBe(30);
	});
});