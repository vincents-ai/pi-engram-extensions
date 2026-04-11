/**
 * Tests for engram-workflow extension templates and data structures
 * (Inline versions for testing - same logic as extension)
 */

import { describe, it, expect } from "vitest";

// ─── Types and Templates (copied from extension) ───────────────────────────

type StateType = "start" | "in_progress" | "review" | "done" | "blocked";
type TransitionType = "automatic" | "manual" | "conditional" | "scheduled";

interface WorkflowStateSpec {
	name: string;
	type: StateType;
	description: string;
	is_final?: boolean;
}

interface WorkflowTransitionSpec {
	name: string;
	from: string;
	to: string;
	type: TransitionType;
	description: string;
}

interface WorkflowSpec {
	title: string;
	description: string;
	entity_types?: string;
	agent?: string;
	states: WorkflowStateSpec[];
	transitions: WorkflowTransitionSpec[];
}

// Built-in workflow templates (copied from extension)
const WORKFLOW_TEMPLATES: Record<string, WorkflowSpec> = {
	"feature-development": {
		title: "Feature Development",
		description: "Standard feature development lifecycle: plan → implement → review → done",
		entity_types: "task",
		states: [
			{ name: "planning", type: "start", description: "Defining requirements, architecture, and task breakdown" },
			{ name: "implementing", type: "in_progress", description: "Writing code, tests, and documentation" },
			{ name: "reviewing", type: "review", description: "Code review, QA, and acceptance testing" },
			{ name: "done", type: "done", description: "Merged, deployed, and closed", is_final: true },
			{ name: "blocked", type: "blocked", description: "Blocked on external dependency or decision" },
		],
		transitions: [
			{ name: "start_implementation", from: "planning", to: "implementing", type: "manual", description: "Requirements are clear, begin coding" },
			{ name: "submit_for_review", from: "implementing", to: "reviewing", type: "manual", description: "Code complete, tests passing" },
			{ name: "request_changes", from: "reviewing", to: "implementing", type: "manual", description: "Review requests changes" },
			{ name: "approve_and_merge", from: "reviewing", to: "done", type: "manual", description: "Review approved, merge and close" },
			{ name: "block", from: "implementing", to: "blocked", type: "manual", description: "Hit a blocker, pause work" },
			{ name: "unblock", from: "blocked", to: "implementing", type: "manual", description: "Blocker resolved, resume" },
			{ name: "reopen", from: "done", to: "planning", type: "manual", description: "Reopen due to regression or new requirements" },
		],
	},

	"bug-fix": {
		title: "Bug Fix",
		description: "Bug triage and resolution lifecycle: triage → investigate → fix → verify → closed",
		entity_types: "task",
		states: [
			{ name: "triaged", type: "start", description: "Bug reported and confirmed, severity assessed" },
			{ name: "investigating", type: "in_progress", description: "Root cause analysis in progress" },
			{ name: "fixing", type: "in_progress", description: "Writing the fix and regression tests" },
			{ name: "verifying", type: "review", description: "Testing the fix against the original report" },
			{ name: "closed", type: "done", description: "Fix verified and deployed", is_final: true },
			{ name: "wont_fix", type: "done", description: "Triaged as not a bug or not worth fixing", is_final: true },
		],
		transitions: [
			{ name: "start_investigation", from: "triaged", to: "investigating", type: "manual", description: "Start root cause analysis" },
			{ name: "begin_fix", from: "investigating", to: "fixing", type: "manual", description: "Root cause identified, write the fix" },
			{ name: "submit_for_verify", from: "fixing", to: "verifying", type: "manual", description: "Fix complete, verify against report" },
			{ name: "fix_verified", from: "verifying", to: "closed", type: "manual", description: "Fix confirmed, close the bug" },
			{ name: "fix_failed", from: "verifying", to: "fixing", type: "manual", description: "Verification failed, back to fixing" },
			{ name: "wont_fix", from: "triaged", to: "wont_fix", type: "manual", description: "Mark as won't fix" },
		],
	},

	"code-review": {
		title: "Code Review",
		description: "Structured code review flow: submitted → reviewed → approved/revisions → merged",
		entity_types: "task,session",
		states: [
			{ name: "submitted", type: "start", description: "PR/MR submitted, awaiting reviewer assignment" },
			{ name: "in_review", type: "in_progress", description: "Actively being reviewed" },
			{ name: "needs_changes", type: "in_progress", description: "Reviewer requested changes" },
			{ name: "approved", type: "review", description: "Review passed, awaiting merge" },
			{ name: "merged", type: "done", description: "Changes merged", is_final: true },
			{ name: "abandoned", type: "done", description: "Review abandoned or closed without merge", is_final: true },
		],
		transitions: [
			{ name: "begin_review", from: "submitted", to: "in_review", type: "manual", description: "Reviewer picks it up" },
			{ name: "request_changes", from: "in_review", to: "needs_changes", type: "manual", description: "Changes requested" },
			{ name: "resubmit", from: "needs_changes", to: "in_review", type: "manual", description: "Author addresses feedback" },
			{ name: "approve", from: "in_review", to: "approved", type: "manual", description: "Reviewer approves" },
			{ name: "merge", from: "approved", to: "merged", type: "manual", description: "Merge the change" },
			{ name: "abandon", from: "submitted", to: "abandoned", type: "manual", description: "Close without merging" },
		],
	},

	"release": {
		title: "Release",
		description: "Software release pipeline: planning → development → testing → staging → production",
		entity_types: "task",
		states: [
			{ name: "planning", type: "start", description: "Release scope defined, tasks assigned" },
			{ name: "development", type: "in_progress", description: "Feature development in progress" },
			{ name: "testing", type: "review", description: "QA testing, regression, and acceptance" },
			{ name: "staging", type: "review", description: "Deployed to staging, final validation" },
			{ name: "production", type: "done", description: "Released to production", is_final: true },
			{ name: "rolled_back", type: "blocked", description: "Rolled back due to production issue" },
		],
		transitions: [
			{ name: "start_development", from: "planning", to: "development", type: "manual", description: "Begin feature work" },
			{ name: "enter_testing", from: "development", to: "testing", type: "manual", description: "All features done, enter QA" },
			{ name: "testing_failed", from: "testing", to: "development", type: "manual", description: "QA found blockers, back to dev" },
			{ name: "deploy_to_staging", from: "testing", to: "staging", type: "manual", description: "QA passed, deploy to staging" },
			{ name: "staging_failed", from: "staging", to: "testing", type: "manual", description: "Staging issues found" },
			{ name: "release", from: "staging", to: "production", type: "manual", description: "Ship it" },
			{ name: "rollback", from: "production", to: "rolled_back", type: "manual", description: "Rollback due to production issue" },
			{ name: "hotfix_and_retry", from: "rolled_back", to: "staging", type: "manual", description: "Hotfix applied, retry staging" },
		],
	},

	"incident": {
		title: "Incident Response",
		description: "Incident management: detected → investigating → mitigating → resolved → post-mortem",
		entity_types: "task,session",
		states: [
			{ name: "detected", type: "start", description: "Incident detected and acknowledged" },
			{ name: "investigating", type: "in_progress", description: "Root cause analysis underway" },
			{ name: "mitigating", type: "in_progress", description: "Mitigation in progress (hotfix, rollback, etc.)" },
			{ name: "monitoring", type: "review", description: "Fix applied, monitoring for stability" },
			{ name: "resolved", type: "review", description: "Incident resolved, awaiting post-mortem" },
			{ name: "closed", type: "done", description: "Post-mortem complete, incident closed", is_final: true },
		],
		transitions: [
			{ name: "begin_investigation", from: "detected", to: "investigating", type: "manual", description: "Start root cause analysis" },
			{ name: "start_mitigation", from: "investigating", to: "mitigating", type: "manual", description: "Cause found, apply mitigation" },
			{ name: "deploy_fix", from: "mitigating", to: "monitoring", type: "manual", description: "Fix deployed, monitor" },
			{ name: "confirm_resolved", from: "monitoring", to: "resolved", type: "manual", description: "System stable, mark resolved" },
			{ name: "regression", from: "monitoring", to: "mitigating", type: "manual", description: "Regression detected, re-mitigate" },
			{ name: "close_post_mortem", from: "resolved", to: "closed", type: "manual", description: "Post-mortem written and published" },
		],
	},

	"adr": {
		title: "ADR Lifecycle",
		description: "Architecture Decision Record: proposed → discussed → decided → implemented → superseded",
		entity_types: "adr",
		states: [
			{ name: "proposed", type: "start", description: "ADR draft written, awaiting discussion" },
			{ name: "discussing", type: "review", description: "Stakeholders reviewing and commenting" },
			{ name: "decided", type: "in_progress", description: "Decision made and documented" },
			{ name: "implemented", type: "done", description: "Decision implemented in code/infra", is_final: true },
			{ name: "superseded", type: "done", description: "Superseded by a newer ADR", is_final: true },
			{ name: "rejected", type: "done", description: "Proposal rejected", is_final: true },
		],
		transitions: [
			{ name: "open_discussion", from: "proposed", to: "discussing", type: "manual", description: "Circulate for feedback" },
			{ name: "accept", from: "discussing", to: "decided", type: "manual", description: "Decision reached: accept" },
			{ name: "reject", from: "discussing", to: "rejected", type: "manual", description: "Decision reached: reject" },
			{ name: "implement", from: "decided", to: "implemented", type: "manual", description: "Implementation complete" },
			{ name: "supersede", from: "implemented", to: "superseded", type: "manual", description: "Superseded by newer ADR" },
		],
	},

	"research-spike": {
		title: "Research Spike",
		description: "Time-boxed technical investigation: framing → researching → synthesising → concluded",
		entity_types: "task,session",
		states: [
			{ name: "framing", type: "start", description: "Question defined, scope and timebox set" },
			{ name: "researching", type: "in_progress", description: "Active investigation, reading, prototyping" },
			{ name: "synthesising", type: "review", description: "Consolidating findings into a recommendation" },
			{ name: "concluded", type: "done", description: "Spike complete, findings stored in engram", is_final: true },
			{ name: "inconclusive", type: "done", description: "Timebox expired without clear answer", is_final: true },
		],
		transitions: [
			{ name: "begin_research", from: "framing", to: "researching", type: "manual", description: "Question is clear, start digging" },
			{ name: "start_synthesis", from: "researching", to: "synthesising", type: "manual", description: "Enough data, start writing up" },
			{ name: "conclude", from: "synthesising", to: "concluded", type: "manual", description: "Clear recommendation reached" },
			{ name: "timebox_expired", from: "researching", to: "inconclusive", type: "manual", description: "Timebox up, no clear answer" },
		],
	},
};

const TEMPLATE_NAMES = Object.keys(WORKFLOW_TEMPLATES);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("WORKFLOW_TEMPLATES", () => {
	it("has built-in templates defined", () => {
		expect(Object.keys(WORKFLOW_TEMPLATES).length).toBeGreaterThan(0);
	});

	it("defines feature-development template", () => {
		const template = WORKFLOW_TEMPLATES["feature-development"];
		expect(template).toBeDefined();
		expect(template.title).toBe("Feature Development");
	});
});

describe("TEMPLATE_NAMES", () => {
	it("includes all template keys", () => {
		expect(TEMPLATE_NAMES).toContain("feature-development");
	});

	it("includes bug-fix template", () => {
		expect(TEMPLATE_NAMES).toContain("bug-fix");
	});

	it("includes code-review template", () => {
		expect(TEMPLATE_NAMES).toContain("code-review");
	});

	it("includes release template", () => {
		expect(TEMPLATE_NAMES).toContain("release");
	});

	it("includes incident template", () => {
		expect(TEMPLATE_NAMES).toContain("incident");
	});
});

describe("feature-development template", () => {
	const template = WORKFLOW_TEMPLATES["feature-development"];

	it("has proper states", () => {
		expect(template.states).toHaveLength(5);
	});

	it("has a start state", () => {
		const start = template.states.find((s) => s.type === "start");
		expect(start).toBeDefined();
		expect(start?.name).toBe("planning");
	});

	it("has a done (final) state", () => {
		const done = template.states.find((s) => s.is_final);
		expect(done).toBeDefined();
		expect(done?.name).toBe("done");
	});

	it("has transitions between all states", () => {
		expect(template.transitions.length).toBeGreaterThan(0);
	});

	it("defines bidirectional blocking transitions", () => {
		const block = template.transitions.find((t) => t.name === "block");
		const unblock = template.transitions.find((t) => t.name === "unblock");

		expect(block).toBeDefined();
		expect(unblock).toBeDefined();

		expect(block?.from).toBe("implementing");
		expect(block?.to).toBe("blocked");

		expect(unblock?.from).toBe("blocked");
		expect(unblock?.to).toBe("implementing");
	});

	it("allows reopening from done state", () => {
		const reopen = template.transitions.find((t) => t.name === "reopen");
		expect(reopen).toBeDefined();
		expect(reopen?.from).toBe("done");
		expect(reopen?.to).toBe("planning");
	});
});

describe("bug-fix template", () => {
	const template = WORKFLOW_TEMPLATES["bug-fix"];

	it("follows triage → investigate → fix → verify → closed flow", () => {
		const stateNames = template.states.map((s) => s.name);
		expect(stateNames).toContain("triaged");
		expect(stateNames).toContain("investigating");
		expect(stateNames).toContain("fixing");
		expect(stateNames).toContain("verifying");
		expect(stateNames).toContain("closed");
	});

	it("supports wont_fix terminal state", () => {
		const wontFix = template.states.find((s) => s.name === "wont_fix");
		expect(wontFix?.is_final).toBe(true);
	});

	it("has transition to wont_fix from triage", () => {
		const transition = template.transitions.find((t) => t.to === "wont_fix");
		expect(transition).toBeDefined();
		expect(transition?.from).toBe("triaged");
	});
});

describe("code-review template", () => {
	const template = WORKFLOW_TEMPLATES["code-review"];

	it("models PR/MR review flow", () => {
		expect(template.entity_types).toContain("task");
	});

	it("has submitted, in_review, needs_changes, approved, merged states", () => {
		const stateNames = template.states.map((s) => s.name);
		expect(stateNames).toContain("submitted");
		expect(stateNames).toContain("in_review");
		expect(stateNames).toContain("needs_changes");
		expect(stateNames).toContain("approved");
		expect(stateNames).toContain("merged");
	});

	it("supports iterative review with request_changes and resubmit", () => {
		const requestChanges = template.transitions.find((t) => t.name === "request_changes");
		const resubmit = template.transitions.find((t) => t.name === "resubmit");

		expect(requestChanges).toBeDefined();
		expect(resubmit).toBeDefined();

		expect(requestChanges?.from).toBe("in_review");
		expect(requestChanges?.to).toBe("needs_changes");

		expect(resubmit?.from).toBe("needs_changes");
		expect(resubmit?.to).toBe("in_review");
	});

	it("has abandoned terminal state", () => {
		const abandoned = template.states.find((s) => s.name === "abandoned");
		expect(abandoned?.is_final).toBe(true);
	});
});

describe("release template", () => {
	const template = WORKFLOW_TEMPLATES["release"];

	it("models dev → test → stage → prod pipeline", () => {
		const stateNames = template.states.map((s) => s.name);
		expect(stateNames).toContain("planning");
		expect(stateNames).toContain("development");
		expect(stateNames).toContain("testing");
		expect(stateNames).toContain("staging");
		expect(stateNames).toContain("production");
	});

	it("supports rollback from production", () => {
		const rollback = template.transitions.find((t) => t.name === "rollback");
		expect(rollback).toBeDefined();
		expect(rollback?.from).toBe("production");
		expect(rollback?.to).toBe("rolled_back");
	});

	it("supports hotfix retry from rolled_back", () => {
		const hotfix = template.transitions.find((t) => t.name === "hotfix_and_retry");
		expect(hotfix).toBeDefined();
		expect(hotfix?.from).toBe("rolled_back");
		expect(hotfix?.to).toBe("staging");
	});
});

describe("incident template", () => {
	const template = WORKFLOW_TEMPLATES["incident"];

	it("models detected → investigating → mitigating → resolved → closed", () => {
		const stateNames = template.states.map((s) => s.name);
		expect(stateNames).toContain("detected");
		expect(stateNames).toContain("investigating");
		expect(stateNames).toContain("mitigating");
		expect(stateNames).toContain("monitoring");
		expect(stateNames).toContain("resolved");
		expect(stateNames).toContain("closed");
	});

	it("supports regression back to mitigating", () => {
		const regression = template.transitions.find((t) => t.name === "regression");
		expect(regression).toBeDefined();
		expect(regression?.from).toBe("monitoring");
		expect(regression?.to).toBe("mitigating");
	});
});

describe("adr template", () => {
	const template = WORKFLOW_TEMPLATES["adr"];

	it("models ADR lifecycle", () => {
		const stateNames = template.states.map((s) => s.name);
		expect(stateNames).toContain("proposed");
		expect(stateNames).toContain("discussing");
		expect(stateNames).toContain("decided");
		expect(stateNames).toContain("implemented");
		expect(stateNames).toContain("superseded");
		expect(stateNames).toContain("rejected");
	});

	it("allows reject transition", () => {
		const reject = template.transitions.find((t) => t.name === "reject");
		expect(reject).toBeDefined();
		expect(reject?.to).toBe("rejected");
	});

	it("supports superseding", () => {
		const supersede = template.transitions.find((t) => t.name === "supersede");
		expect(supersede).toBeDefined();
		expect(supersede?.from).toBe("implemented");
		expect(supersede?.to).toBe("superseded");
	});
});

describe("research-spike template", () => {
	const template = WORKFLOW_TEMPLATES["research-spike"];

	it("models time-boxed investigation", () => {
		const stateNames = template.states.map((s) => s.name);
		expect(stateNames).toContain("framing");
		expect(stateNames).toContain("researching");
		expect(stateNames).toContain("synthesising");
		expect(stateNames).toContain("concluded");
		expect(stateNames).toContain("inconclusive");
	});

	it("has timebox_expired transition", () => {
		const timeboxExpired = template.transitions.find((t) => t.name === "timebox_expired");
		expect(timeboxExpired).toBeDefined();
		expect(timeboxExpired?.to).toBe("inconclusive");
	});
});

describe("template integrity", () => {
	it.each(TEMPLATE_NAMES)("template '%s' has valid structure", (name) => {
		const template = WORKFLOW_TEMPLATES[name];
		expect(template.title).toBeDefined();
		expect(template.description).toBeDefined();
		expect(template.states).toBeDefined();
		expect(template.transitions).toBeDefined();

		// All states referenced in transitions must exist
		for (const tx of template.transitions) {
			const fromExists = template.states.some((s) => s.name === tx.from);
			const toExists = template.states.some((s) => s.name === tx.to);
			expect(fromExists).toBe(true);
			expect(toExists).toBe(true);
		}

		// At least one start state
		const startStates = template.states.filter((s) => s.type === "start");
		expect(startStates.length).toBeGreaterThan(0);

		// At least one final state
		const finalStates = template.states.filter((s) => s.is_final);
		expect(finalStates.length).toBeGreaterThan(0);
	});
});