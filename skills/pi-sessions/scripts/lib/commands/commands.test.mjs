import assert from "node:assert/strict";
import { test } from "node:test";
import { takeCorpusFlag } from "../config.mjs";
import { previousWindow, resolveWindow, window } from "../query.mjs";
import { canonicalKey, parseCsv, parseJiraCsv, rejectedJiraKeys } from "./outcomes.mjs";
import { displayText } from "./prompts.mjs";
import { pageRows, statementProblem, uniqueNames } from "./sql.mjs";

process.env.TZ = "UTC";

test("parseCsv handles quotes, escaped quotes, commas and CRLF", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n'), [
    ["a", "b"],
    ["x, y", 'say "hi"'],
  ]);
  assert.deepEqual(parseCsv("k,v\nA-1,"), [
    ["k", "v"],
    ["A-1", ""],
  ]);
});

test("parseJiraCsv keys rows by header and undoes the CLI's bracket escaping", () => {
  const rows = parseJiraCsv(
    "KEY,TYPE,STATUS,RESOLUTION,UPDATED,SUMMARY\nHSCTR-9211,Story,In Progress,,2026-10-15 19:42:27,[core[] Settle codelist policy\nnot a row\n",
  );
  assert.deepEqual(rows, [
    {
      key: "HSCTR-9211",
      type: "Story",
      status: "In Progress",
      resolution: "",
      updated: "2026-10-15 19:42:27",
      summary: "[core] Settle codelist policy",
    },
  ]);
});

test("rejected keys are read from Jira errors in canonical form", () => {
  const err = "Error:\n  - An issue with key 'HSCTR-0' does not exist for field 'key'.\n  - The issue key 'ABC-12' for field 'key' is invalid.";
  assert.deepEqual(rejectedJiraKeys(err), ["HSCTR-0", "ABC-12"]);
  assert.equal(canonicalKey("HSCTR-0000"), "HSCTR-0");
  assert.equal(canonicalKey("HSCTR-0042"), "HSCTR-42");
  assert.equal(canonicalKey("HSCTR-9211"), "HSCTR-9211");
});

test("prompt display collapses exact template and skill invocations only", () => {
  const base = { skill: null, template: null, template_match: null, args: null, text: "free text" };
  assert.equal(displayText(base), "free text");
  assert.equal(displayText({ ...base, template: "review", template_match: "full", args: "naming" }), "/review: naming");
  assert.equal(displayText({ ...base, template: "mr-review", template_match: "pattern", args: "35" }), "/mr-review: 35");
  assert.equal(displayText({ ...base, skill: "jira", template_match: "full" }), "/skill:jira");
  assert.match(displayText({ ...base, template: "pickup", template_match: "prefix" }), /older template text[\s\S]*free text/);
});

test("windows may not end after a historical corpus, and default to its end", () => {
  const historical = { meta: { since: "2026-01-01T00:00:00.000Z", until: "2026-02-01T00:00:00.000Z", built_at: "2026-10-20T00:00:00.000Z" } };
  const w = resolveWindow(historical, {}, { defaultSince: "7d" });
  assert.deepEqual([w.S, w.U], ["2026-01-25T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]);
  assert.throws(() => resolveWindow(historical, { since: "2026-01-10", until: "2026-03-01" }), /after the corpus/);

  const current = { meta: { since: "2026-01-01T00:00:00.000Z", until: "2026-10-20T00:00:00.000Z", built_at: "2026-10-20T00:00:00.500Z" } };
  assert.ok(resolveWindow(current, { since: "2026-10-01" }).until > new Date("2026-10-20T00:00:00.000Z"));
});

test("--until built and relative starts give every command the same window", () => {
  const current = { meta: { since: "2026-07-01T00:00:00.000Z", until: "2026-10-21T12:02:00.000Z", built_at: "2026-10-21T12:02:05.000Z" } };
  const w = resolveWindow(current, { since: "30d", until: "built" });
  assert.deepEqual([w.S, w.U], ["2026-09-21T12:02:00.000Z", "2026-10-21T12:02:00.000Z"]);
  const explicit = resolveWindow(current, { since: "7d", until: "2026-10-01T00:00:00Z" });
  assert.deepEqual([explicit.S, explicit.U], ["2026-09-24T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
  const historical = { meta: { since: "2026-01-01T00:00:00.000Z", until: "2026-02-01T00:00:00.000Z", built_at: "2026-10-20T00:00:00.000Z" } };
  assert.equal(resolveWindow(historical, { since: "7d", until: "built" }).U, "2026-02-01T00:00:00.000Z");
  // A build to "now" that took over a minute is still open-ended: the flag, not timing, decides.
  const slow = { meta: { ...current.meta, built_at: "2026-10-21T12:04:00.000Z", open_ended: "1" } };
  assert.ok(resolveWindow(slow, { since: "2026-10-01" }).until > new Date("2026-10-22T00:00:00.000Z"));
  const pinned = { meta: { ...current.meta, open_ended: "0" } };
  assert.throws(() => resolveWindow(pinned, { since: "2026-10-01", until: "now" }), /after the corpus/);
});

test("--corpus is taken from anywhere in the arguments", () => {
  const before = process.env.PISS_CORPUS;
  try {
    assert.deepEqual(takeCorpusFlag(["facts", "--corpus", "/run/c.db", "--since", "30d"]), ["facts", "--since", "30d"]);
    assert.equal(process.env.PISS_CORPUS, "/run/c.db");
    assert.deepEqual(takeCorpusFlag(["--corpus=/run/d.db", "sql", "SELECT 1"]), ["sql", "SELECT 1"]);
    assert.equal(process.env.PISS_CORPUS, "/run/d.db");
  } finally {
    if (before === undefined) delete process.env.PISS_CORPUS;
    else process.env.PISS_CORPUS = before;
  }
});

test("an hourly bucket belongs to the window containing its start", () => {
  const until = new Date("2026-10-02T00:00:00Z");
  assert.equal(window(new Date("2026-10-01T19:40:00Z"), until).H, "2026-10-01T20:00:00.000Z");
  assert.equal(window(new Date("2026-10-01T19:00:00Z"), until).H, "2026-10-01T19:00:00.000Z");
});

test("windows may not start before the corpus", () => {
  const corpus = { meta: { since: "2026-07-22T17:00:00.000Z" } };
  const w = resolveWindow(corpus, { since: "2026-09-01", until: "2026-10-01" });
  assert.equal(w.days, 30);
  assert.throws(() => resolveWindow(corpus, { since: "2026-07-01" }), /before the corpus.*piss build --since 2026-07-01/);
  assert.throws(() => previousWindow(corpus, resolveWindow(corpus, { since: "2026-08-01", until: "2026-09-01" })), /--compare needs/);
  assert.throws(() => resolveWindow(corpus, { since: "2026-09-02", until: "2026-09-01" }), /before --until/);
});

test("piss sql takes one read-only statement, whatever hides in quotes and comments", () => {
  for (const ok of [
    "SELECT 1",
    "  -- note\n/* why */ with x as (select 1) select * from x;  -- done",
    "SELECT ';DROP TABLE prompts' AS s, \"a;b\", [c;d] FROM t",
    "select 'it''s; fine'",
    "PRAGMA table_info(prompts)",
    "EXPLAIN QUERY PLAN SELECT 1",
  ]) {
    assert.equal(statementProblem(ok), null, ok);
  }
  assert.match(statementProblem("VACUUM INTO '/tmp/x.db'"), /read-only queries: start with SELECT.*not VACUUM/);
  assert.match(statementProblem("/* hi */ attach 'x.db' as y"), /not ATTACH/);
  assert.equal(statementProblem("SELECT 1; DROP TABLE prompts"), "run one statement at a time");
  assert.equal(statementProblem("SELECT 1;;"), "run one statement at a time");
  assert.equal(statementProblem("  -- only a comment"), "the query is empty");
});

test("piss sql pages rows and caps every value and the page size", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ i, text: "x".repeat(i === 3 ? 50 : 5) }));
  const page = pageRows(rows, { offset: 2, limit: 3, maxCell: 20 });
  assert.deepEqual(
    page.page.map((r) => r.i),
    [2, 3, 4],
  );
  assert.equal(page.page[1].text, `${"x".repeat(20)}… (+30 chars; --max-cell for more)`);
  assert.equal(page.total, 10);
  const budget = pageRows(rows, { maxChars: 50 });
  assert.equal(budget.page.length, 2, "the page stops before passing --max-chars");
  assert.equal(budget.full, true);
  assert.equal(pageRows(rows, { maxChars: 1 }).page.length, 1, "a page always holds one row");
});

test("piss sql keeps columns that share a name and prints blobs as their size", () => {
  assert.deepEqual(uniqueNames(["model", "n", "model", "model"]), ["model", "n", "model (2)", "model (3)"]);
  const { page } = pageRows([{ data: new Uint8Array(100_000), n: 1 }]);
  assert.deepEqual(page, [{ data: "(blob, 100000 bytes)", n: 1 }]);
});
