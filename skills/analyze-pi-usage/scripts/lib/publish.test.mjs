import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FACTS, HISTORY } from "./fixtures.mjs";
import { historyIndex } from "./history.mjs";
import {
  checkHistory,
  checkOutcomes,
  crossCheck,
  findingsRefs,
  htmlToText,
  lintBody,
  outcomeCounts,
  reportLabel,
  resolveCarried,
  sidecar,
  validateFindings,
} from "./publish.mjs";
import { HERO_CHARTS, REQUIRED_SECTIONS } from "./spec.mjs";

const asset = (name) => readFileSync(new URL(`../../assets/${name}`, import.meta.url), "utf8");
const BODY = asset("example-body.html");
const FINDINGS = JSON.parse(asset("example-findings.json"));
const REQUIRED = REQUIRED_SECTIONS.map((s) => s.id);
const clone = (x) => JSON.parse(JSON.stringify(x));

test("the example body and findings pass every check", () => {
  assert.deepEqual(lintBody(BODY, REQUIRED_SECTIONS, { heroCharts: HERO_CHARTS }), []);
  assert.deepEqual(validateFindings(FINDINGS), []);
  assert.deepEqual(crossCheck(BODY, FINDINGS), []);
  assert.deepEqual(checkHistory(FINDINGS, historyIndex(HISTORY), HISTORY[0]), []);
  assert.deepEqual(findingsRefs(FINDINGS), [
    "S260915-1710",
    "S260925-1922",
    "S261014-2102",
    "S261014-1601",
    "S260923-1531",
    "S261020-1930",
    "S261008-2331",
  ]);
});

test("validateFindings checks every followed-up item", () => {
  const bad = clone(FINDINGS);
  bad.carried[0].outcome = "maybe";
  bad.carried[0].note = "x";
  bad.carried[1].ref = "13 Oct idea";
  bad.carried[1].evidence = " ";
  bad.carried[2].ref = bad.carried[0].ref;
  bad.carried[2].refs = ["S1"];
  bad.carried[2].effect = "Faster \u2014 much.";
  assert.deepEqual(validateFindings(bad), [
    'findings.carried[0]: unknown key "note"',
    "findings.carried[0].outcome must be adopted, partly, not-adopted, dropped, superseded, unclear",
    "findings.carried[1].ref must be an earlier recommendation id such as 2026-10-13#some-id",
    "findings.carried[1].evidence must say what happened and how you know",
    'findings.carried[2].ref "2026-10-13#quick-short-squash" is followed up twice',
    "findings.carried[2].refs must be session refs",
    'findings.carried[2]: em dash in "Faster \u2014 much."',
  ]);
  const none = clone(FINDINGS);
  delete none.carried;
  none.recommendations[3].status = "new";
  none.recommendations[3].previous = null;
  assert.deepEqual(validateFindings(none), []);
});

test("checkHistory: earlier ids must exist, follow-ups must be carried, the last report fully covered", () => {
  const index = historyIndex(HISTORY);
  const bad = clone(FINDINGS);
  bad.carried.pop();
  bad.carried[0].ref = "2026-10-13#made-up";
  bad.recommendations[0].status = "repeat";
  bad.recommendations[0].previous = "2026-10-06#never-said";
  assert.deepEqual(checkHistory(bad, index, HISTORY[0]), [
    'findings.carried: no earlier report recommended "2026-10-13#made-up" (history.mjs prints every id)',
    'recommendation "quick-session-per-ticket": previous "2026-10-06#never-said" is not an earlier recommendation',
    'recommendation "big-design-memory": its previous "2026-10-13#decisions-captured-as-you-make-them" must also be followed up in findings.carried',
    "findings.carried must follow up every recommendation of the 2026-10-13 report; missing 2026-10-13#quick-short-squash, 2026-10-13#decisions-captured-as-you-make-them",
  ]);
  assert.deepEqual(checkHistory({ ...FINDINGS, carried: [] }, new Map(), null).length, 1);
});

test("resolveCarried joins each item with the earlier wording and builds the chip data", () => {
  const { carried, reportInfo } = resolveCarried(FINDINGS, historyIndex(HISTORY));
  assert.equal(carried.length, 3);
  assert.deepEqual(carried[0], {
    id: "2026-10-13#quick-short-squash",
    key: "2026-10-13",
    date: "2026-10-13",
    kind: "quick",
    title: "Make squash messages short by default",
    summary: "Cap the squash body at 6 lines.",
    total: 3,
    backfilled: true,
    outcome: "adopted",
    evidence: FINDINGS.carried[0].evidence,
    effect: FINDINGS.carried[0].effect,
    refs: ["S261020-1930"],
  });
  assert.deepEqual(reportInfo["2026-10-13#decisions-captured-as-you-make-them"], {
    label: "13 Oct report",
    anchor: "carried-2026-10-13-decisions-captured-as-you-make-them",
    name: "Decisions captured as you make them",
    meta: "big idea, now not adopted",
    prompt: "Propose memory lines or ADR amendments from your rulings at the end of a design session.",
  });
  assert.deepEqual([reportLabel("2026-10-06"), reportLabel("2026-10-06-opus5"), reportLabel("odd")], ["6 Oct", "6 Oct (opus5)", "odd"]);
});

test("lintBody rejects em dashes, scripts and styles, and required sections out of order", () => {
  const errors = lintBody(
    `<section id="works"><h2>W</h2><p>fast \u2014 and done</p><style>x{}</style></section><section id="overview"><h2>O</h2></section>`,
    ["overview", "works"],
  );
  assert.deepEqual(errors, [
    '1 em dash in the body, first near "W fast \u2014 and done O"; rewrite without them',
    "the body must not contain <script> or <style>; the shell provides both",
    "required sections out of order: found works, overview; expected overview, works",
  ]);
  assert.deepEqual(
    lintBody('<section id="overview"><h2>a</h2></section><section id="extra"><h2>b</h2></section><section id="works"><h2>c</h2></section>', [
      "overview",
      "works",
    ]),
    [],
  );
});

test("lintBody catches em dashes written as entities and markup that could run code", () => {
  const body = (inner) => `<section id="a"><h2>A</h2>${inner}</section>`;
  assert.match(lintBody(body("<p>x &mdash; y &#8212; z &#x2014;</p>"))[0], /^3 em dashes in the body, first near "A x \u2014 y/);
  assert.deepEqual(
    lintBody(
      body(
        '<img src=x onerror="alert(1)"><a href=" jav&#x09;ascript:alert(1)">a</a><a href="&#106;avascript:x">b</a>' +
          '<iframe src="https://e.com"></iframe><img src="data:image/svg+xml;base64,AA"><META http-equiv=refresh>',
      ),
    ),
    ["the body must not contain active markup: <iframe>, <meta>, onerror= attribute, javascript:, vbscript: or non-image data: link"],
  );
  assert.deepEqual(
    lintBody(body('<a href="https://pi.dev/packages/x">ok</a><img src="data:image/png;base64,AA"><p>one-off, on=off, ondemand</p>')),
    [],
  );
});

test("lintBody sees attributes the way browsers split them, without flagging values that only mention them", () => {
  const body = (inner) => `<section id="a"><h2>A</h2>${inner}</section>`;
  for (const payload of [
    '<img src="x"onerror=alert(1)>',
    "<svg/onload=alert(1)>",
    '<img alt=">" onerror=alert(1) src=x>',
    '<a/href="javascript:alert(1)">x</a>',
    '<a href="&#106avascript:alert(1)">x</a>',
    '<a href="jav&#97script:alert(1)">x</a>',
  ]) {
    assert.match(lintBody(body(payload)).join("\n"), /active markup/, payload);
  }
  assert.deepEqual(lintBody(body('<a title="see onboarding=done" href="https://pi.dev">ok</a>')), []);
  assert.match(lintBody(body("<p>a &#8212 b &#x2014 c</p>"))[0], /^2 em dashes/);
  assert.deepEqual(lintBody(body("<p>&#82120;</p>")), [], "a longer number is another character");
  assert.deepEqual(lintBody(body("<p><!--slot:footer--></p>")), ["the body must not contain <!--slot:...--> markers; the shell owns them"]);
});

test("text extraction drops inline tags without a space, so punctuation stays attached", () => {
  assert.equal(htmlToText("<p>A <em>builder</em>, not a <code>coder</code>.</p><p>Next</p>"), "A builder, not a coder.\nNext");
  const findings = clone(FINDINGS);
  const body = BODY.replace(FINDINGS.verdict, "<em>X</em>, then Y.");
  findings.verdict = "X, then Y.";
  assert.deepEqual(crossCheck(body, findings), []);
  assert.deepEqual(findingsRefs({ recommendations: {}, carried: "x" }), []);
});

test("lintBody requires an <h2> per section and the charts the spec puts in each", () => {
  const spec = [{ id: "overview", charts: ["daily", "repos"] }, { id: "since-last", charts: ["carried"] }];
  const errors = lintBody(
    '<header class="hero"><h1>T</h1></header><section id="overview"><h2>O</h2><!--chart:daily--></section>' +
      '<section id="since-last"><p>no heading</p></section><section id="x"><h2>X</h2><!--chart:carried--><!--chart:carried--></section>',
    spec,
    { heroCharts: ["kpis"] },
  );
  assert.deepEqual(errors, [
    'section "since-last" needs an <h2> that states its finding',
    'section "overview" needs <!--chart:repos-->',
    'section "since-last" needs <!--chart:carried-->',
    "the hero needs <!--chart:kpis-->",
    "<!--chart:carried--> appears 2 times; it belongs in the since-last section once",
  ]);
});

test("validateFindings names every problem in the format", () => {
  const bad = clone(FINDINGS);
  bad.extra = true;
  bad.recommendations[0].id = "Not A Slug";
  bad.recommendations[1].status = "repeat";
  bad.recommendations[2].refs = [];
  bad.recommendations[2].kind = "quick";
  bad.recommendations[3].previous = "last month";
  bad.recommendations[3].kind = "quick";
  bad.community[0].ring = "maybe";
  bad.community[1].url = "pi.dev/packages/x";
  bad.verdict = "Fast \u2014 and done.";
  assert.deepEqual(validateFindings(bad), [
    'findings: unknown key "extra"',
    "findings.recommendations[0].id must be a lowercase slug",
    "findings.recommendations[1]: a repeat must name the previous recommendation",
    "findings.recommendations[2].refs must list the sessions it rests on",
    "findings.recommendations[3].previous must look like 2026-10-13#some-id",
    'findings.recommendations needs at least one "big" item',
    "findings.community[0].ring must be try, look, watch, pass",
    "findings.community[1].url must be an http(s) link",
    'findings: em dash in "Fast \u2014 and done."',
  ]);
  assert.deepEqual(validateFindings([]), ["findings.json must be a JSON object"]);
});

test("crossCheck keeps findings.json and the body describing the same report", () => {
  const drifted = clone(FINDINGS);
  drifted.verdict = "Something else.";
  drifted.recommendations.pop();
  drifted.recommendations[0].title = "A title the body never mentions";
  drifted.community.push({ name: "pi-extra", url: "https://pi.dev/packages/pi-extra", ring: "look" });
  assert.deepEqual(crossCheck(BODY, drifted), [
    "findings.verdict does not appear in the body (put it in the verdict card's .line)",
    'recommendation "A title the body never mentions" is not in the body',
    'community find "pi-extra" is not in the body',
    '2 <article class="bet"> cards in the body but 1 "big" recommendations in findings.json',
    '4 <article class="find"> cards in the body but 5 community finds in findings.json',
  ]);
  assert.deepEqual(crossCheck(BODY, null), []);
  // Malformed parts are validateFindings' to report; crossCheck must not throw on them.
  assert.deepEqual(crossCheck(BODY, { verdict: 42, recommendations: {}, community: "x" }), []);
  assert.deepEqual(crossCheck(BODY.replaceAll('class="rec"', 'class="card rec"'), FINDINGS), []);
});

test("outcomes.json must cover the report's window", () => {
  const window = { since: "2026-09-26T10:12:00.000Z", until: "2026-10-26T10:12:00.000Z" };
  assert.deepEqual(checkOutcomes(null, window), []);
  assert.deepEqual(checkOutcomes({ window: { ...window } }, window), []);
  assert.match(checkOutcomes({ window: { since: "2026-10-19T10:12:00.000Z", until: window.until } }, window)[0], /^outcomes\.json covers 2026-10-19/);
  assert.equal(checkOutcomes({}, window).length, 1);
});

test("htmlToText keeps visible text only", () => {
  assert.equal(htmlToText("<style>p{}</style><h2>Quick &amp; easy</h2><p>a&nbsp;b &#8212; &lt;c&gt;</p>"), "Quick & easy\na b \u2014 <c>");
});

test("the sidecar records the window, verdict, recommendations and headline numbers", () => {
  const outcomes = { merge_requests: [{ merged: [{}, {}] }], git: [{ landed: [{}] }], jira: { closed_by_you: [{}], created_by_you: [] } };
  const record = sidecar({
    date: "2026-10-20",
    generatedAt: "2026-10-20T20:00:00.000Z",
    generator: { provider: "keystone", model: "claude-opus-5-5", thinking: "xhigh" },
    facts: {
      ...FACTS,
      corpus: { built_at: "2026-10-20T19:00:00.000Z", since: "2026-08-21T00:00:00.000Z", pi_version: "1.3.0", excluded_session: "S261020-2001", warnings: [] },
    },
    outcomes,
    findings: FINDINGS,
    refs: ["S260915-1710"],
    reportFile: "pi-session-report-2026-10-20.html",
  });
  assert.equal(record.schema, 1);
  assert.deepEqual(record.window, { since: FACTS.window.since, until: FACTS.window.until });
  assert.equal(record.verdict, FINDINGS.verdict);
  assert.equal(record.recommendations.length, 4);
  assert.deepEqual(record.carried, FINDINGS.carried);
  assert.equal(record.corpus.excluded_session, "S261020-2001");
  assert.deepEqual(record.facts.models[0], { model: "keystone/claude-opus-5-5", turns: 300, cost: 36 });
  assert.deepEqual(record.outcomes, outcomeCounts(outcomes));
  assert.deepEqual(outcomeCounts(outcomes), {
    mrs_merged: 2,
    mrs_repos_not_checked: 0,
    commits_landed: 1,
    commit_repos_not_checked: 0,
    tickets_closed_by_you: 1,
    tickets_assigned_resolved: null,
    tickets_created_by_you: 0,
    notes: [],
  });
});
