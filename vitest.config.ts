import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__tests__/**/*.test.ts"],
		exclude: ["node_modules"],
		environment: "node",
	},
	coverage: {
		provider: "v8",
		reporter: ["text", "json", "html"],
		reportsDirectory: ".coverage",
		skipEmpty: true,
	},
});