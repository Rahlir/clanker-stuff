/**
 * Unit tests for the MR review in-memory store. Covers the issue lifecycle,
 * id assignment, and the serialize/load round-trip the extension relies on for
 * persistence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewStore, validateAnchor } from "./state.ts";

const sampleInput = {
	severity: "major" as const,
	summary: "unchecked null",
	details: "may throw",
	file: "src/a.ts",
	startLine: 10,
};

test("starts empty and reports no active review", () => {
	const store = new ReviewStore();
	assert.equal(store.hasReview(), false);
	assert.equal(store.activeMr, null);
});

test("assigns stable auto-increment ids", () => {
	const store = new ReviewStore();
	store.start("mr!1");
	const a = store.addIssue(sampleInput);
	const b = store.addIssue({ ...sampleInput, summary: "second" });
	assert.equal(a.id, 1);
	assert.equal(b.id, 2);
	assert.equal(a.state, "open");
});

test("setNote moves an issue to commented; markPosted flags it", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	store.setNote(issue.id, "please fix");
	assert.equal(store.getIssue(issue.id)?.state, "commented");
	assert.deepEqual(store.queued().map((i) => i.id), [issue.id]);

	store.markPosted(issue.id);
	assert.equal(store.getIssue(issue.id)?.posted, true);
	assert.deepEqual(store.queued(), [], "posted issues drop out of the queue");
});

test("rejecting clears any drafted note", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	store.setNote(issue.id, "draft");
	store.markRejected(issue.id);
	const after = store.getIssue(issue.id);
	assert.equal(after?.state, "rejected");
	assert.equal(after?.note, undefined);
});

test("reopening clears note and posted flag", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	store.setNote(issue.id, "draft");
	store.markPosted(issue.id);
	store.updateIssue(issue.id, { state: "open" });
	const after = store.getIssue(issue.id);
	assert.equal(after?.state, "open");
	assert.equal(after?.note, undefined);
	assert.equal(after?.posted, undefined);
});

test("postAsGeneral keeps the position and the approved note queued", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue({ ...sampleInput, endLine: 14 });
	store.setNote(issue.id, "please fix");
	store.updateIssue(issue.id, { postAsGeneral: true });
	const after = store.getIssue(issue.id);
	assert.equal(after?.postAsGeneral, true);
	assert.equal(after?.file, "src/a.ts", "the position survives so the body can name it");
	assert.equal(after?.startLine, 10);
	assert.equal(after?.endLine, 14);
	assert.equal(after?.note, "please fix", "an anchor fix must not discard the approved note");
	assert.deepEqual(store.queued().map((i) => i.id), [issue.id], "issue stays queued for the next post");
});

test("postAsGeneral combined with a corrected path keeps the new path", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue({ ...sampleInput, endLine: 14 });
	store.updateIssue(issue.id, { postAsGeneral: true, file: "src/b.ts" });
	const after = store.getIssue(issue.id);
	assert.equal(after?.file, "src/b.ts");
	assert.equal(after?.postAsGeneral, true);
});

test("repointing at a new line re-enables inline posting", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	store.updateIssue(issue.id, { postAsGeneral: true });
	store.updateIssue(issue.id, { startLine: 40 });
	assert.equal(store.getIssue(issue.id)?.postAsGeneral, undefined);
});

test("an explicit postAsGeneral wins over a startLine in the same call", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	store.updateIssue(issue.id, { postAsGeneral: true, startLine: 40 });
	const after = store.getIssue(issue.id);
	assert.equal(after?.postAsGeneral, true);
	assert.equal(after?.startLine, 40);
});

test("an empty file takes the path back off an issue", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue({ severity: "minor", summary: "s", details: "d", file: "src/a.ts" });
	store.updateIssue(issue.id, { file: "  " });
	assert.equal(store.getIssue(issue.id)?.file, undefined);
});

test("repointing an anchor keeps the note and the commented state", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	store.setNote(issue.id, "please fix");
	store.updateIssue(issue.id, { startLine: 42 });
	const after = store.getIssue(issue.id);
	assert.equal(after?.startLine, 42);
	assert.equal(after?.state, "commented");
	assert.equal(after?.note, "please fix");
});

test("a new startLine alone drops a stale endLine", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue({ ...sampleInput, startLine: 88, endLine: 95 });
	store.updateIssue(issue.id, { startLine: 40 });
	const after = store.getIssue(issue.id);
	assert.equal(after?.startLine, 40);
	assert.equal(after?.endLine, undefined, "keeping 95 would post the range 40:95");
});

test("a restated range survives a repoint", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue({ ...sampleInput, startLine: 88, endLine: 95 });
	store.updateIssue(issue.id, { startLine: 40, endLine: 46 });
	const after = store.getIssue(issue.id);
	assert.equal(after?.startLine, 40);
	assert.equal(after?.endLine, 46);
});

test("extending the range end alone leaves the start alone", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue({ ...sampleInput, startLine: 88 });
	store.updateIssue(issue.id, { endLine: 92 });
	const after = store.getIssue(issue.id);
	assert.equal(after?.startLine, 88);
	assert.equal(after?.endLine, 92);
});

test("postAsGeneral alongside a state change applies both", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	store.setNote(issue.id, "please fix");
	store.updateIssue(issue.id, { postAsGeneral: true, state: "rejected" });
	const after = store.getIssue(issue.id);
	assert.equal(after?.postAsGeneral, true);
	assert.equal(after?.state, "rejected");
});

test("validateAnchor accepts complete, file-only, and absent anchors", () => {
	assert.equal(validateAnchor({}), undefined);
	assert.equal(validateAnchor({ file: "a.ts" }), undefined, "a file alone is a file-scoped finding");
	assert.equal(validateAnchor({ file: "a.ts", startLine: 10 }), undefined);
	assert.equal(validateAnchor({ file: "a.ts", startLine: 10, endLine: 10 }), undefined);
	assert.equal(validateAnchor({ file: "a.ts", startLine: 10, endLine: 20 }), undefined);
});

test("validateAnchor rejects line info that cannot be anchored", () => {
	assert.match(validateAnchor({ file: "a.ts", endLine: 20 }) ?? "", /endLine requires startLine/);
	assert.match(validateAnchor({ endLine: 20 }) ?? "", /endLine requires startLine/);
	assert.match(validateAnchor({ startLine: 10 }) ?? "", /startLine requires file/);
	assert.match(validateAnchor({ file: "   ", startLine: 10 }) ?? "", /startLine requires file/);
	assert.match(validateAnchor({ file: "a.ts", startLine: 20, endLine: 10 }) ?? "", /must not be before/);
	assert.match(validateAnchor({ file: "a.ts", startLine: 0 }) ?? "", /positive integer/);
	assert.match(validateAnchor({ file: "a.ts", startLine: 1.5 }) ?? "", /positive integer/);
});

test("updateIssue validates the merged anchor, not the incoming fields", () => {
	const store = new ReviewStore();
	store.start("mr");
	const anchored = store.addIssue(sampleInput);
	assert.equal(store.updateIssue(anchored.id, { endLine: 14 }).ok, true, "an existing startLine makes this valid");

	const general = store.addIssue({ severity: "minor", summary: "s", details: "d" });
	const outcome = store.updateIssue(general.id, { endLine: 14 });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.ok === false && outcome.reason, "invalid-anchor");
});

test("a rejected update leaves the issue untouched", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	const outcome = store.updateIssue(issue.id, { summary: "new summary", startLine: 20, endLine: 10 });
	assert.equal(outcome.ok, false);
	const after = store.getIssue(issue.id);
	assert.equal(after?.summary, "unchecked null", "no field is applied when the anchor is invalid");
	assert.equal(after?.startLine, 10);
});

test("updateIssue reports a missing issue apart from a bad anchor", () => {
	const store = new ReviewStore();
	store.start("mr");
	const outcome = store.updateIssue(99, { summary: "x" });
	assert.equal(outcome.ok === false && outcome.reason, "not-found");
});

test("counts reflect each lifecycle state", () => {
	const store = new ReviewStore();
	store.start("mr");
	const open = store.addIssue(sampleInput);
	const commented = store.addIssue(sampleInput);
	const rejected = store.addIssue(sampleInput);
	store.setNote(commented.id, "note");
	store.markRejected(rejected.id);
	assert.deepEqual(store.counts(), {
		total: 3,
		open: 1,
		commented: 1,
		rejected: 1,
		posted: 0,
	});
	void open;
});

test("serialize snapshot is decoupled from later edits", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	const snapshot = store.serialize();
	store.setNote(issue.id, "changed after snapshot");
	assert.equal(snapshot.issues[0].state, "open", "snapshot must not mutate");
});

test("load rehydrates and continues ids past the max", () => {
	const store = new ReviewStore();
	store.load({
		mr: "mr!9",
		issues: [{ ...sampleInput, id: 5, state: "open", details: "x", summary: "s" }],
		nextId: 3,
	});
	assert.equal(store.activeMr, "mr!9");
	const next = store.addIssue(sampleInput);
	assert.equal(next.id, 6, "nextId is bumped past the highest existing id");
});
