/**
 * Unit tests for the MR review session naming policy: name derivation from the
 * free-form MR ref, and the rule for when an existing name may be replaced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { nextSessionName, reviewSessionName } from "./session-name.ts";

test("derives mr-<n>-review from a plain number", () => {
	assert.equal(reviewSessionName("123"), "mr-123-review");
});

test("accepts GitLab-style !123 and #123 refs", () => {
	assert.equal(reviewSessionName("!123"), "mr-123-review");
	assert.equal(reviewSessionName("#123"), "mr-123-review");
});

test("derives no name from a URL, branch, or empty ref", () => {
	assert.equal(reviewSessionName("https://gitlab.example.com/g/p/-/merge_requests/123"), undefined);
	assert.equal(reviewSessionName("feature/x"), undefined);
	assert.equal(reviewSessionName("12a"), undefined);
	assert.equal(reviewSessionName(""), undefined);
});

test("names an unnamed session", () => {
	assert.equal(nextSessionName(undefined, "123"), "mr-123-review");
});

test("skips when the session already has the wanted name", () => {
	assert.equal(nextSessionName("mr-123-review", "123"), undefined);
});

test("replaces a name it generated earlier when the MR changes", () => {
	assert.equal(nextSessionName("mr-111-review", "222"), "mr-222-review");
});

test("keeps a name the user chose", () => {
	assert.equal(nextSessionName("refactor auth", "123"), undefined);
});

test("does not mistake a lookalike user name for its own", () => {
	assert.equal(nextSessionName("mr-fix-review", "123"), undefined);
});

test("leaves the session alone when the ref has no derivable name", () => {
	assert.equal(nextSessionName(undefined, "feature/x"), undefined);
	assert.equal(nextSessionName("mr-111-review", "feature/x"), undefined);
});
