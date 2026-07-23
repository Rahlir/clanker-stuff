/**
 * Unit tests for the MR review formatting helpers (severity colors, location
 * labels, lifecycle icons/labels).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { locationLabel, severityColor, stateView } from "./format.ts";
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

test("locationLabel handles general, file-only, single line, and ranges", () => {
	assert.equal(locationLabel(base), "general");
	assert.equal(locationLabel({ ...base, file: "a.ts" }), "a.ts");
	assert.equal(locationLabel({ ...base, file: "a.ts", startLine: 10 }), "a.ts:10");
	assert.equal(locationLabel({ ...base, file: "a.ts", startLine: 10, endLine: 20 }), "a.ts:10-20");
	assert.equal(
		locationLabel({ ...base, file: "a.ts", startLine: 10, endLine: 10 }),
		"a.ts:10",
		"a single-line range collapses to one number",
	);
});

test("stateView distinguishes commented vs posted", () => {
	assert.equal(stateView(base).label, "open");
	assert.equal(stateView({ ...base, state: "rejected" }).label, "rejected");
	assert.equal(stateView({ ...base, state: "commented" }).label, "commented");
	assert.equal(stateView({ ...base, state: "commented", posted: true }).label, "posted");
});
