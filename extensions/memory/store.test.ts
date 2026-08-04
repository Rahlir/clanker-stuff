/**
 * Unit tests for the memory extension's pure core. Covers the store-key
 * encoding contract (it must match pi's session-dir encoding), entry
 * parse/format round-trips, duplicate normalization, and the assembled
 * injection block. A smoke test at the bottom checks that the extension factory
 * registers the tool, the command, and the session hooks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	appendEntry,
	buildInjectedMessage,
	contentDigest,
	encodeRootKey,
	exceedsSizeWarning,
	findDuplicate,
	formatDate,
	formatEntry,
	memoryFileHeader,
	normalizeLesson,
	parseEntries,
	SIZE_WARN_BYTES,
} from "./store.ts";

test("encodeRootKey mirrors pi's session directory encoding", () => {
	// pi: `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
	assert.equal(encodeRootKey("/Users/x/dev/repo"), "--Users-x-dev-repo--");
	assert.equal(encodeRootKey("/"), "----");
	// Windows: the drive colon and each backslash collapse to their own dash.
	assert.equal(encodeRootKey("C:\\dev\\repo"), "--C--dev-repo--");
});

test("formatDate uses local calendar date, zero padded", () => {
	assert.equal(formatDate(new Date(2026, 0, 5, 23, 30)), "2026-01-05");
	assert.equal(formatDate(new Date(2026, 11, 31, 0, 1)), "2026-12-31");
});

test("formatEntry collapses whitespace into a single line", () => {
	assert.equal(formatEntry("  use   glab\n for MRs ", "2026-07-25"), "- 2026-07-25: use glab for MRs");
});

test("parseEntries picks up entries and ignores header prose", () => {
	const content = `${memoryFileHeader()}\n- 2026-07-25: first lesson\nsome note\n- not-a-date: nope\n- 2026-07-26: second lesson\n`;
	const entries = parseEntries(content);
	assert.deepEqual(
		entries.map((e) => e.lesson),
		["first lesson", "second lesson"],
	);
	assert.equal(entries[0].date, "2026-07-25");
	assert.equal(entries[1].line, "- 2026-07-26: second lesson");
});

test("the header alone contains no entries", () => {
	assert.equal(parseEntries(memoryFileHeader()).length, 0);
});

test("appendEntry normalizes trailing whitespace to one newline", () => {
	assert.equal(appendEntry("- 2026-07-25: a\n\n\n", "- 2026-07-26: b"), "- 2026-07-25: a\n- 2026-07-26: b\n");
	assert.equal(appendEntry("", "- 2026-07-26: b"), "- 2026-07-26: b\n");
	assert.equal(appendEntry("   \n", "- 2026-07-26: b"), "- 2026-07-26: b\n");
});

test("the first entry is separated from header prose by a blank line", () => {
	const seeded = appendEntry(memoryFileHeader(), "- 2026-07-25: first");
	assert.ok(seeded.endsWith("\n\n- 2026-07-25: first\n"));
	// Subsequent entries stack directly, no blank lines between them.
	assert.ok(appendEntry(seeded, "- 2026-07-26: second").endsWith("first\n- 2026-07-26: second\n"));
});

test("duplicate detection ignores case, spacing, and trailing punctuation", () => {
	const content = "- 2026-07-25: Use glab for merge requests.\n";
	assert.ok(findDuplicate(content, "use  glab for merge requests"));
	assert.ok(findDuplicate(content, "Use glab for merge requests!"));
	assert.ok(findDuplicate(content, "use glab for merge requests?"));
	assert.equal(findDuplicate(content, "Use glab for issues"), undefined);
	assert.equal(findDuplicate(content, "   "), undefined);
	assert.equal(normalizeLesson("A B.;"), "a b");
});

test("findDuplicate returns the stored line so the tool can echo it", () => {
	const content = "- 2026-07-25: Use glab for merge requests.\n";
	assert.equal(findDuplicate(content, "use glab for merge requests")?.line, "- 2026-07-25: Use glab for merge requests.");
});

test("size warning triggers only above the threshold", () => {
	assert.equal(exceedsSizeWarning("x".repeat(SIZE_WARN_BYTES)), false);
	assert.equal(exceedsSizeWarning("x".repeat(SIZE_WARN_BYTES + 1)), true);
});

test("contentDigest ignores surrounding whitespace and tracks content changes", () => {
	assert.equal(contentDigest("- 2026-07-25: a\n"), contentDigest("\n- 2026-07-25: a  "));
	assert.notEqual(contentDigest("- 2026-07-25: a\n"), contentDigest("- 2026-07-25: b\n"));
});

test("buildInjectedMessage wraps content with the preamble and path", () => {
	const msg = buildInjectedMessage("PREAMBLE", "- 2026-07-25: a\n", { path: "~/mem/memory.md" });
	assert.match(msg, /^PREAMBLE\n\n<project-memory path="~\/mem\/memory\.md">\n- 2026-07-25: a\n<\/project-memory>$/);
	assert.doesNotMatch(msg, /supersedes/);
});

test("a quote in the path cannot break the project-memory tag", () => {
	const msg = buildInjectedMessage("", "- 2026-07-25: a", { path: 'we"ird/memory.md' });
	assert.match(msg, /<project-memory path="we'ird\/memory\.md">/);
});

test("a refreshed injection announces that it supersedes earlier copies", () => {
	const msg = buildInjectedMessage("PREAMBLE", "- 2026-07-25: a", { refreshed: true });
	assert.match(msg, /supersedes any earlier memory block/);
	assert.match(msg, /<project-memory>/);
});

test("extension registers the tool, command, renderer, and session hooks", async () => {
	const { default: memory } = await import("./index.ts");

	const tools: string[] = [];
	const commands: string[] = [];
	const renderers: string[] = [];
	const events: string[] = [];
	const pi = {
		registerTool: (def: { name: string }) => tools.push(def.name),
		registerCommand: (name: string) => commands.push(name),
		registerMessageRenderer: (customType: string) => renderers.push(customType),
		on: (event: string) => events.push(event),
		sendMessage: () => {},
	};

	memory(pi as unknown as Parameters<typeof memory>[0]);

	assert.deepEqual(tools, ["add_memory"]);
	assert.deepEqual(commands, ["edit-memory"]);
	assert.deepEqual(renderers, ["memory"]);
	assert.deepEqual(events.sort(), ["session_compact", "session_start"]);
});
