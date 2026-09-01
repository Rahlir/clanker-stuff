/**
 * Unit tests for the shared interactive-UI lock. These pin the guarantees the
 * TUI callers depend on: exclusion while held, release on every exit path
 * (including throws), and no leak that would poison later calls.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { currentUiLockOwner, withUiLock } from "./ui-lock.ts";

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

test("starts unheld and releases after a normal run", async () => {
	assert.equal(currentUiLockOwner(), null);
	const result = await withUiLock("A", async () => {
		assert.equal(currentUiLockOwner(), "A");
		return 42;
	});
	assert.equal(result, 42);
	assert.equal(currentUiLockOwner(), null);
});

test("a second concurrent caller is rejected while the first is open", async () => {
	let release!: () => void;
	const first = withUiLock("A", () => new Promise<string>((r) => (release = () => r("done"))));
	await settle();

	await assert.rejects(
		withUiLock("B", async () => "never"),
		/Cannot open "B".*already showing "A".*executionMode: "sequential"/s,
	);

	release();
	assert.equal(await first, "done");
	assert.equal(currentUiLockOwner(), null);
});

test("a rejected caller does not steal or clear the lock", async () => {
	let release!: () => void;
	const first = withUiLock("A", () => new Promise<void>((r) => (release = r)));
	await settle();

	await assert.rejects(withUiLock("B", async () => undefined));
	assert.equal(currentUiLockOwner(), "A");

	release();
	await first;
});

test("releases when the wrapped call throws", async () => {
	await assert.rejects(
		withUiLock("A", async () => {
			throw new Error("component blew up");
		}),
		/component blew up/,
	);
	assert.equal(currentUiLockOwner(), null);
});

test("releases when the wrapped call throws synchronously", async () => {
	await assert.rejects(
		withUiLock("A", (): Promise<void> => {
			throw new Error("factory blew up");
		}),
		/factory blew up/,
	);
	assert.equal(currentUiLockOwner(), null);
});

test("sequential callers each acquire in turn", async () => {
	const seen: (string | null)[] = [];
	for (const owner of ["A", "B", "C"]) {
		await withUiLock(owner, async () => {
			seen.push(currentUiLockOwner());
		});
	}
	assert.deepEqual(seen, ["A", "B", "C"]);
	assert.equal(currentUiLockOwner(), null);
});
