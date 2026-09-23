/**
 * Unit tests for the glab argv builder and the failure classifier. The subtle
 * rules: `--file` is never passed without `--line`, ranges use START:END,
 * `--unique` is only ever added for general notes (glab rejects it alongside
 * `--file`), and a rejected anchor must never be reported as a retryable
 * failure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildNoteArgs, classifyPostError } from "./glab.ts";
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

// glab accepts --file without --line and calls it a file-level comment, but it
// anchors the note to the first line of the first hunk instead, pinning the
// comment to unrelated code.
test("a file without a line posts general, never --file alone", () => {
	const args = buildNoteArgs("mr!1", { ...base, file: "src/a.ts" }, "body");
	assert.ok(!args.includes("--file"));
	assert.ok(args.includes("--unique"));
});

test("a demoted issue posts general even though it keeps its position", () => {
	const issue: Issue = { ...base, file: "src/a.ts", startLine: 12, postAsGeneral: true };
	const args = buildNoteArgs("mr!1", issue, "body");
	assert.deepEqual(args, ["mr", "note", "create", "mr!1", "-m", "body", "--unique"]);
});

// Literal strings glab and GitLab emit for an unusable position. Retrying any of
// these with the same argv fails identically, so they must not be reported as
// retryable.
const ANCHOR_ERRORS = [
	"line 88 not found in diff for src/a.ts",
	"old line 7 not found in diff for src/a.ts",
	"new line 42 not found in diff",
	'invalid line range "18:12": end must be >= start',
	'invalid line number "abc"',
	"line number must be positive, got -3",
	'POST https://gitlab.example.com/api/v4/projects/1/merge_requests/2/discussions: 400 {message: ["Note {line_code} must be a valid line code"]}',
	'POST https://gitlab.example.com/api/v4/projects/1/merge_requests/2/discussions: 400 {message: ["Line code is missing"]}',
	'400 {message: ["Position is incomplete"]}',
];

for (const detail of ANCHOR_ERRORS) {
	test(`classifies as line-anchor failure: ${detail.slice(0, 48)}`, () => {
		assert.equal(classifyPostError(detail), "anchor-line");
	});
}

// A file outside the diff needs different advice: no line number can rescue it.
test("classifies a missing file apart from a missing line", () => {
	assert.equal(classifyPostError('file "src/a.ts" not found in MR diff'), "anchor-file");
});

const OTHER_ERRORS = [
	"Post https://gitlab.example.com: dial tcp: i/o timeout",
	"401 Unauthorized",
	"note 12 not found in merge request !3",
	"failed to list MR diff versions: context deadline exceeded",
	"empty note body",
];

for (const detail of OTHER_ERRORS) {
	test(`classifies as retryable failure: ${detail.slice(0, 48)}`, () => {
		assert.equal(classifyPostError(detail), "other");
	});
}
