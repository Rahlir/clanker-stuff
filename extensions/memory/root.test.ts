/**
 * Tests for project-root resolution, the one piece of the extension that is
 * both git-dependent and easy to get wrong. Real repos in a temp dir, because
 * the behavior being pinned down is git's (`--show-superproject-working-tree`
 * and `--git-common-dir` return different shapes per checkout kind).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveProjectRoot } from "./index.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "test");
	writeFileSync(join(dir, "file.txt"), "hi\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
	return dir;
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "memory-root-")));

test("outside a repo the root is the directory itself", () => {
	const plain = join(scratch, "plain");
	mkdirSync(plain, { recursive: true });
	// A parent repo would be picked up, so assert only that we stay put.
	assert.equal(resolveProjectRoot(plain), realpathSync(plain));
});

test("a subdirectory resolves to the repository root", () => {
	const repo = initRepo(join(scratch, "repo"));
	const deep = join(repo, "a", "b");
	mkdirSync(deep, { recursive: true });
	assert.equal(resolveProjectRoot(deep), repo);
});

test("a linked worktree collapses onto the main checkout", () => {
	const repo = initRepo(join(scratch, "wt-main"));
	const worktree = join(scratch, "wt-linked");
	git(repo, "worktree", "add", "-q", worktree, "-b", "feature");
	const deep = join(worktree, "nested");
	mkdirSync(deep, { recursive: true });

	assert.equal(resolveProjectRoot(worktree), repo);
	assert.equal(resolveProjectRoot(deep), repo);
});

test("a submodule resolves to the superproject, not the submodule", () => {
	const sub = initRepo(join(scratch, "sub"));
	const superproject = initRepo(join(scratch, "super"));
	execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"], {
		cwd: superproject,
		stdio: "ignore",
	});
	git(superproject, "commit", "-qm", "add submodule");

	assert.equal(resolveProjectRoot(join(superproject, "sub")), superproject);
});
