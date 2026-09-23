/**
 * Unit tests for the MR review in-memory store. Covers the issue lifecycle,
 * id assignment, and the serialize/load round-trip the extension relies on for
 * persistence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ReviewStore } from "./state.ts";

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

test("clearAnchor drops the position but keeps the approved note queued", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue({ ...sampleInput, endLine: 14 });
	store.setNote(issue.id, "please fix");
	store.updateIssue(issue.id, { clearAnchor: true });
	const after = store.getIssue(issue.id);
	assert.equal(after?.file, undefined);
	assert.equal(after?.startLine, undefined);
	assert.equal(after?.endLine, undefined);
	assert.equal(after?.note, "please fix", "an anchor fix must not discard the approved note");
	assert.deepEqual(store.queued().map((i) => i.id), [issue.id], "issue stays queued for the next post");
});

test("clearAnchor combined with a new position sets the new position", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue({ ...sampleInput, endLine: 14 });
	store.updateIssue(issue.id, { clearAnchor: true, file: "src/b.ts", startLine: 40 });
	const after = store.getIssue(issue.id);
	assert.equal(after?.file, "src/b.ts");
	assert.equal(after?.startLine, 40);
	assert.equal(after?.endLine, undefined, "the stale range end is not carried over");
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

test("clearAnchor alongside a state change applies both", () => {
	const store = new ReviewStore();
	store.start("mr");
	const issue = store.addIssue(sampleInput);
	store.setNote(issue.id, "please fix");
	store.updateIssue(issue.id, { clearAnchor: true, state: "rejected" });
	const after = store.getIssue(issue.id);
	assert.equal(after?.file, undefined);
	assert.equal(after?.state, "rejected");
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
