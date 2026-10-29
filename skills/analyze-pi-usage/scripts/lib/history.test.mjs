import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beforeDate,
  historyIndex,
  htmlExcerpt,
  latestBefore,
  latestWithoutSidecar,
  leftOutLine,
  listReports,
  loadHistory,
  localDay,
  reportKey,
  sidecarSummary,
} from "./history.mjs";

test("reports sort newest first, variants and undated names included", () => {
  const names = [
    "pi-session-report-2026-10-06.html",
    "notes.txt",
    "pi-session-report.html",
    "pi-session-report-2026-10-13.html",
    "pi-session-report-2026-10-06-opus5.html",
    "pi-session-report-2026-10-13.json",
  ];
  assert.deepEqual(
    listReports(names).map((r) => [r.name, r.key, r.date, r.variant]),
    [
      ["pi-session-report-2026-10-13.html", "2026-10-13", "2026-10-13", null],
      ["pi-session-report-2026-10-06-opus5.html", "2026-10-06-opus5", "2026-10-06", "opus5"],
      ["pi-session-report-2026-10-06.html", "2026-10-06", "2026-10-06", null],
      ["pi-session-report.html", null, null, null],
    ],
  );
  assert.equal(reportKey("notes.html"), null);
});

test("a report builds on earlier days only: same-day and later reports are left out, undated ones kept", () => {
  const reports = listReports([
    "pi-session-report-2026-10-21.html",
    "pi-session-report-2026-10-21-opus5.html",
    "pi-session-report-2026-10-22.html",
    "pi-session-report-2026-10-13.html",
    "pi-session-report.html",
  ]);
  const { earlier, hidden } = beforeDate(reports, "2026-10-21");
  assert.deepEqual(earlier.map((r) => r.name), ["pi-session-report-2026-10-13.html", "pi-session-report.html"]);
  assert.deepEqual(hidden.map((r) => r.name), [
    "pi-session-report-2026-10-22.html",
    "pi-session-report-2026-10-21-opus5.html",
    "pi-session-report-2026-10-21.html",
  ]);
  assert.equal(localDay(new Date(2026, 0, 5, 23, 30)), "2026-01-05");
});

test("a left-out report is described well enough to ask about replacing it, and never summarized", () => {
  const sidecar = { generator: { provider: "keystone", model: "claude-opus-5-5", thinking: "xhigh" }, verdict: "secret" };
  const line = leftOutLine("pi-session-report-2026-10-21.html", { sidecar, writtenAt: "2026-10-21 14:20", replaced: true });
  assert.equal(
    line,
    "left out pi-session-report-2026-10-21.html (written 2026-10-21 14:20 by keystone/claude-opus-5-5 (xhigh)): not an earlier report. " +
      "Publishing this run replaces it: ask the user now, and do not open it.",
  );
  assert.doesNotMatch(line, /secret/);
  // A same-day variant is not the file this run writes, so there is nothing to ask.
  assert.equal(leftOutLine("pi-session-report-2026-10-21-opus5.html"), "left out pi-session-report-2026-10-21-opus5.html: not an earlier report. Do not open it.");
});

test("history loads the sidecars it can, indexes their ids, and finds the latest earlier report", () => {
  const files = {
    "pi-session-report-2026-10-13.json": { date: "2026-10-13", recommendations: [{ id: "a", kind: "quick", title: "A", summary: "do a" }] },
    "pi-session-report-2026-10-06.json": { date: "2026-10-06", backfilled: true, recommendations: [{ id: "b", kind: "big", title: "B", summary: "do b" }] },
    "pi-session-report-2026-10-06-opus5.json": { date: "2026-10-06", recommendations: [{ id: "b", kind: "quick", title: "B2", summary: "do b2" }] },
    "pi-session-report-2026-09-30.json": [],
  };
  const names = [...Object.keys(files).map((n) => n.replace(".json", ".html")), "pi-session-report-2026-09-26.html", "pi-session-report-2026-09-20.html"];
  const { entries, problems } = loadHistory(names, (name) => {
    if (name.includes("09-20")) throw new Error("bad JSON");
    return files[name];
  });
  assert.deepEqual(entries.map((e) => e.key), ["2026-10-13", "2026-10-06-opus5", "2026-10-06"]);
  assert.deepEqual(problems, [
    "pi-session-report-2026-09-30.html: sidecar is not a JSON object",
    "pi-session-report-2026-09-20.html: sidecar unreadable (bad JSON)",
  ]);

  const index = historyIndex(entries);
  assert.deepEqual([...index.keys()], ["2026-10-13#a", "2026-10-06-opus5#b", "2026-10-06#b"]);
  assert.deepEqual(index.get("2026-10-06#b"), {
    id: "2026-10-06#b",
    key: "2026-10-06",
    date: "2026-10-06",
    kind: "big",
    title: "B",
    summary: "do b",
    total: 1,
    backfilled: true,
  });
  assert.equal(latestBefore(entries, "2026-10-21").key, "2026-10-13");
  assert.equal(latestBefore(entries, "2026-10-13").key, "2026-10-06");
  assert.equal(latestBefore(entries, "2026-10-06"), null);

  // The newest day must have a sidecar, or coverage would quietly fall back to an older report.
  const reports = listReports(["pi-session-report-2026-10-20.html", ...names]);
  assert.equal(latestWithoutSidecar(reports, entries), "pi-session-report-2026-10-20.html");
  assert.equal(latestWithoutSidecar(listReports(names), entries), null);
});

test("a sidecar summary lists each recommendation with the id the next report links to", () => {
  const lines = sidecarSummary({
    date: "2026-10-13",
    generator: { provider: "keystone", model: "claude-opus-5-5", thinking: "xhigh" },
    window: { since: "2026-09-13T10:00:00.000Z", until: "2026-10-13T10:00:00.000Z" },
    verdict: "You decide.",
    recommendations: [
      { id: "quick-a", kind: "quick", title: "A", summary: "do a", status: "new", previous: null },
      { id: "big-b", kind: "big", title: "B", summary: "do b", status: "follow-up", previous: "2026-09-30#big-x" },
    ],
    carried: [{ ref: "2026-09-30#big-x", outcome: "partly" }],
    community: [{ name: "pi-subagents", ring: "look" }],
  });
  assert.deepEqual(lines, [
    "generated by keystone/claude-opus-5-5 (xhigh); window 2026-09-13 to 2026-10-13",
    "verdict: You decide.",
    "quick 2026-10-13#quick-a [new] A: do a",
    "big   2026-10-13#big-b [follow-up, from 2026-09-30#big-x] B: do b",
    "followed up 2026-09-30#big-x: partly",
    "community: look pi-subagents",
  ]);
  const variant = sidecarSummary({ date: "2026-10-06", backfilled: true, recommendations: [{ id: "x", kind: "quick", title: "X", summary: "s", status: "new" }] }, "2026-10-06-opus5");
  assert.match(variant[0], /; backfilled from the HTML$/);
  assert.equal(variant[2], "quick 2026-10-06-opus5#x [new] X: s");
});

test("an HTML-only report yields its outline and its recommendation sections", () => {
  const html = `<h1>Title</h1><h2>1 Overview</h2><p>numbers</p><h2>5 Quick wins</h2><h3>One</h3><p>Do the thing.</p>
    <h2>6 Big picture</h2><p>${"x".repeat(50)}</p><footer>end</footer>`;
  assert.deepEqual(htmlExcerpt(html, { cap: 20 }), [
    "outline: Title | 1 Overview | 5 Quick wins | 6 Big picture",
    "-- 5 Quick wins",
    "One\nDo the thing.",
    "-- 6 Big picture",
    `${"x".repeat(20)} … (+34 chars)`,
  ]);
});
