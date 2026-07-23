/**
 * Unit tests for the shared shell-approximate tokenizer. These pin the
 * guarantees the guard extensions depend on (quotes, command boundaries,
 * subshell depth, redirections, heredoc bodies).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { basename, segmentize, tokenize, type Tok } from "./shell-tokens.ts";

const texts = (toks: Tok[]): string[] => toks.map((t) => t.text);
const segTexts = (toks: Tok[]): string[][] => segmentize(toks).map(texts);

test("basename takes the last path component", () => {
	assert.equal(basename("/usr/bin/rg"), "rg");
	assert.equal(basename("rg"), "rg");
	assert.equal(basename("./grep"), "grep");
});

test("splits plain words", () => {
	assert.deepEqual(texts(tokenize("rg -n foo src")), ["rg", "-n", "foo", "src"]);
});

test("keeps quoted regions as one token and marks them quoted", () => {
	const toks = tokenize("echo 'rg -r foo'");
	assert.deepEqual(texts(toks), ["echo", "rg -r foo"]);
	assert.equal(toks[1].quoted, true);
	assert.equal(toks[0].quoted, false);
});

test("strips double quotes but records the token as quoted", () => {
	const toks = tokenize('cd "$PWD"');
	assert.deepEqual(texts(toks), ["cd", "$PWD"]);
	assert.equal(toks[1].quoted, true);
});

test("marks the first word of each pipeline segment as cmdPos", () => {
	const toks = tokenize("cat x | grep foo");
	const cmds = toks.filter((t) => t.cmdPos).map((t) => t.text);
	assert.deepEqual(cmds, ["cat", "grep"]);
});

test("tracks subshell depth for (...) and $(...)", () => {
	const toks = tokenize("(cd /usr && ls)");
	const cd = toks.find((t) => t.text === "cd");
	assert.ok(cd && cd.depth > 0, "cd inside a subshell has depth > 0");

	const top = tokenize("cd /usr");
	assert.equal(top.find((t) => t.text === "cd")?.depth, 0);
});

test("classifies redirections and their targets", () => {
	const toks = tokenize("rg foo > out.txt");
	const redir = toks.find((t) => t.redir);
	assert.equal(redir?.redir, "file");

	const dup = tokenize("cmd 2>&1");
	assert.ok(dup.some((t) => t.redir === "dup"));
});

test("segmentize splits on && ; | into command lists", () => {
	assert.deepEqual(segTexts(tokenize("cd foo && ls; echo hi | wc -l")), [
		["cd", "foo"],
		["ls"],
		["echo", "hi"],
		["wc", "-l"],
	]);
});

test("does not treat heredoc bodies as commands", () => {
	const toks = tokenize("cat <<EOF\nrg -r foo\nEOF");
	// The body line is data, so the `rg`/`-r` inside it must not surface as a
	// cmdPos token that the search guard would inspect.
	assert.ok(!toks.some((t) => t.cmdPos && t.text === "rg"));
});
