/**
 * Unit tests for the glab argv builder. The subtle rules: inline vs general is
 * decided by presence of a position, ranges use START:END, and `--unique` is
 * only ever added for general notes (glab rejects it alongside `--file`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildNoteArgs } from "./glab.ts";
import type { Issue } from "./state.ts";

const base: Issue = {
	id: 1,
	severity: "minor",
	summary: "s",
	details: "d",
	state: "commented",
};

test("general note: no --file, adds --unique for idempotent re-runs", () => {
	const args = buildNoteArgs("mr!1", base, "body");
	assert.deepEqual(args, ["mr", "note", "create", "mr!1", "-m", "body", "--unique"]);
});

test("inline single-line note: --file and --line, never --unique", () => {
	const issue: Issue = { ...base, file: "src/a.ts", startLine: 12 };
	const args = buildNoteArgs("mr!1", issue, "body");
	assert.deepEqual(args, ["mr", "note", "create", "mr!1", "--file", "src/a.ts", "--line", "12", "-m", "body"]);
	assert.ok(!args.includes("--unique"), "--unique is incompatible with --file");
});

test("inline range note: uses START:END line syntax", () => {
	const issue: Issue = { ...base, file: "src/a.ts", startLine: 12, endLine: 18 };
	const args = buildNoteArgs("mr!1", issue, "body");
	const line = args[args.indexOf("--line") + 1];
	assert.equal(line, "12:18");
});

test("range collapsing: endLine equal to startLine stays single", () => {
	const issue: Issue = { ...base, file: "src/a.ts", startLine: 12, endLine: 12 };
	const args = buildNoteArgs("mr!1", issue, "body");
	assert.equal(args[args.indexOf("--line") + 1], "12");
});
