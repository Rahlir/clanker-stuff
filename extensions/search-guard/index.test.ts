/**
 * search-guard tests.
 *
 * The corpus below drives the pure `analyzeCommand` verdict: that is where all
 * the interesting behavior lives (tokenizer edge cases, flag clustering,
 * wrappers, `--`). A single smoke test covers the extension wiring, since the
 * hook itself is a few lines of glue over `analyzeCommand`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
	BashToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import searchGuard, { analyzeCommand } from "./index.ts";

interface Case {
	command: string;
	block: boolean;
	note?: string;
}

const cases: Case[] = [
	// rg short -r/-R IS --replace: the dangerous, silently-corrupting case.
	{ command: "rg -r foo src", block: true, note: "rg -r is --replace, not recursive" },
	{ command: "rg -rn foo src", block: true },
	{ command: "rg -rln foo", block: true },
	{ command: "rg -R foo", block: true },
	// grep recursive: blocked in favor of rg.
	{ command: "grep -r foo .", block: true },
	{ command: "grep -R foo .", block: true },
	{ command: "grep -rn foo .", block: true },
	{ command: "grep --recursive foo .", block: true },
	// Wrapper prefixes still resolve to the rg/grep invocation.
	{ command: "sudo rg -r foo /etc", block: true, note: "wrapper before rg" },
	{ command: "xargs rg -r foo", block: true },
	// Later pipeline / list segments are inspected too.
	{ command: "true && rg -rn foo", block: true },
	{ command: "cat x | grep -R foo", block: true },

	// Legitimate usage passes.
	{ command: "rg -n foo src", block: false },
	{ command: "rg -l foo", block: false },
	{ command: "rg --replace bar foo src", block: false, note: "long form is the escape hatch" },
	{ command: "grep foo file.txt", block: false },
	{ command: "cat x | grep foo", block: false },
	// -r consumed as a value, not a flag: `-e -r` makes -r the pattern.
	{ command: "rg -e -r src", block: false, note: "-r is the -e value" },
	{ command: "rg -e foo -A r", block: false },
	// After `--`, `-r` is a positional arg.
	{ command: "rg -F -- -r src", block: false },
	// Quoted text is data, never an invocation.
	{ command: "echo 'rg -r foo'", block: false, note: "quoted, not executed" },
];

for (const c of cases) {
	test(`${c.block ? "blocks" : "passes"}: ${c.command}`, () => {
		const verdict = analyzeCommand(c.command);
		assert.equal(verdict.block, c.block, c.note ?? "");
		if (verdict.block) assert.ok(verdict.reason.length > 0, "a block must carry a reason");
	});
}

test("wiring: registers a tool_call hook that blocks bad flags", async () => {
	let handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult> | undefined;
	searchGuard({
		on: (event: string, h: ExtensionHandler<ToolCallEvent, ToolCallEventResult>) => {
			if (event === "tool_call") handler = h;
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler, "extension must register a tool_call handler");

	const event: BashToolCallEvent = {
		type: "tool_call",
		toolCallId: "t",
		toolName: "bash",
		input: { command: "rg -r foo" },
	};
	const ctx = { cwd: process.cwd(), hasUI: false } as unknown as ExtensionContext;
	const result = await handler(event, ctx);
	assert.equal(result?.block, true);
});
