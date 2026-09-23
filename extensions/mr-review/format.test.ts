/**
 * Unit tests for the MR review formatting helpers (severity colors, location
 * labels, lifecycle icons/labels, and the posted body assembly).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { composeBody, locationLabel, severityColor, stateView } from "./format.ts";
import type { Issue } from "./state.ts";

const base: Issue = {
	id: 1,
	severity: "minor",
	summary: "s",
	details: "d",
	state: "open",
};

test("severityColor maps each severity", () => {
	assert.equal(severityColor("critical"), "error");
	assert.equal(severityColor("major"), "warning");
	assert.equal(severityColor("minor"), "muted");
});

test("locationLabel handles general, single line, and ranges", () => {
	assert.equal(locationLabel(base), "general");
	assert.equal(locationLabel({ ...base, file: "a.ts", startLine: 10 }), "a.ts:10");
	assert.equal(locationLabel({ ...base, file: "a.ts", startLine: 10, endLine: 20 }), "a.ts:10-20");
	assert.equal(
		locationLabel({ ...base, file: "a.ts", startLine: 10, endLine: 10 }),
		"a.ts:10",
		"a single-line range collapses to one number",
	);
});

test("locationLabel marks a positioned issue that still posts general", () => {
	assert.equal(locationLabel({ ...base, file: "a.ts" }), "a.ts (general)", "a file alone cannot be anchored");
	assert.equal(locationLabel({ ...base, file: "a.ts", startLine: 10, postAsGeneral: true }), "a.ts:10 (general)");
});

test("composeBody leaves an inline note alone", () => {
	const issue: Issue = { ...base, file: "a.ts", startLine: 10, note: "please fix" };
	assert.equal(composeBody(issue), "please fix");
});

test("composeBody prefixes the position when the note posts general", () => {
	assert.equal(
		composeBody({ ...base, file: "a.ts", startLine: 10, endLine: 20, postAsGeneral: true, note: "please fix" }),
		"**`a.ts:10-20`**\n\nplease fix",
	);
	assert.equal(
		composeBody({ ...base, file: "a.ts", note: "please fix" }),
		"**`a.ts`**\n\nplease fix",
		"a file-scoped note still names its file",
	);
});

test("composeBody adds nothing when there is no position to lose", () => {
	assert.equal(composeBody({ ...base, note: "please fix" }), "please fix");
});

test("stateView distinguishes commented vs posted", () => {
	assert.equal(stateView(base).label, "open");
	assert.equal(stateView({ ...base, state: "rejected" }).label, "rejected");
	assert.equal(stateView({ ...base, state: "commented" }).label, "commented");
	assert.equal(stateView({ ...base, state: "commented", posted: true }).label, "posted");
});
