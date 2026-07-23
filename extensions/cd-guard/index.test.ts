/**
 * cd-guard tests.
 *
 * The corpus drives the pure `analyzeCommand` verdict. cd-guard is cwd-sensitive
 * (it canonicalizes target and working dir via realpathSync), so tests run
 * against a real temp dir. A single smoke test covers the extension wiring,
 * which is what threads `ctx.cwd` into `analyzeCommand`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	BashToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import cdGuard, { analyzeCommand } from "./index.ts";

// Real, canonicalized dir so cd-guard's realpathSync resolves it identically.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cd-guard-")));

interface Case {
	command: string;
	block: boolean;
	note?: string;
}

const cases: Case[] = [
	// no-op: cd resolves back to the working directory.
	{ command: `cd ${cwd} && ls`, block: true },
	{ command: "cd . && rg foo", block: true },
	{ command: 'cd "$PWD" && ls', block: true },
	{ command: "FOO=bar cd .", block: true, note: "env-assignment prefix, still a no-op" },

	// cd elsewhere: no longer guarded (identical to a subshell in an isolated call).
	{ command: "cd /usr && ls", block: false, note: "other dir" },
	{ command: "cd ..", block: false, note: "parent dir" },
	{ command: "cd", block: false, note: "bare cd goes to $HOME, not the cwd" },
	{ command: "cd -", block: false, note: "$OLDPWD, unresolvable" },
	{ command: "cd $SOMEWHERE", block: false, note: "unexpanded var, unresolvable" },
	{ command: "FOO=bar cd /usr", block: false, note: "env prefix, other dir" },

	// Allowed regardless.
	{ command: "(cd . && ls)", block: false, note: "subshell, depth > 0 not inspected" },
	{ command: "(cd /usr && ls)", block: false, note: "subshell escape hatch" },
	{ command: "ls -la", block: false },
	{ command: "echo 'cd /usr'", block: false, note: "quoted, not executed" },
	{ command: "grep cd file.txt", block: false, note: "cd is an argument" },
	{ command: "FOO=bar ls", block: false, note: "env prefix, no cd" },
];

for (const c of cases) {
	test(`${c.block ? "blocks" : "passes"}: ${c.command}`, () => {
		const verdict = analyzeCommand(c.command, cwd);
		assert.equal(verdict.block, c.block, c.note ?? "");
		if (verdict.block) assert.match(verdict.reason, /no-op/);
	});
}

test("wiring: registers a tool_call hook that threads cwd and blocks", async () => {
	let handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult> | undefined;
	cdGuard({
		on: (event: string, h: ExtensionHandler<ToolCallEvent, ToolCallEventResult>) => {
			if (event === "tool_call") handler = h;
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler, "extension must register a tool_call handler");

	const event: BashToolCallEvent = {
		type: "tool_call",
		toolCallId: "t",
		toolName: "bash",
		input: { command: `cd ${cwd} && ls` },
	};
	const ctx = { cwd, hasUI: false } as unknown as ExtensionContext;
	const result = await handler(event, ctx);
	assert.equal(result?.block, true, "cwd must be threaded so the no-op is detected");
});
