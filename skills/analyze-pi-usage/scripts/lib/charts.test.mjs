import assert from "node:assert/strict";
import { test } from "node:test";
import { contours, daily, heatmap, kpis, modelLabel, models, niceMax, repoLabel, repos, weekly, windowDays } from "./charts.mjs";

process.env.TZ = "UTC";

import { FACTS } from "./fixtures.mjs";

const count = (html, needle) => html.split(needle).length - 1;

test("windowDays lists every local day the window touches", () => {
  assert.deepEqual(windowDays(FACTS.window), [
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-09",
  ]);
});

test("daily draws one column per day, quiet days included, and shades weekends", () => {
  const html = daily(FACTS);
  assert.equal(count(html, '<g class="col">'), 7);
  assert.equal(count(html, '<rect class="shade"'), 2);
  assert.match(html, /peak Oct 5 \(2\.0 h\); 5 of 7 days without activity/);
  assert.match(html, /Mon Oct 5: you 1\.0 h, agent 1\.0 h, \$12\.00, 3 sessions, 20 prompts/);
});

test("weekly labels each week with its spend", () => {
  const html = weekly(FACTS);
  assert.equal(count(html, '<g class="col">'), 2);
  assert.match(html, />\$20</);
  assert.match(html, />\$30</);
});

test("ranked bars scale to the largest row and escape labels", () => {
  const html = repos(FACTS);
  assert.match(html, /nba2/);
  assert.match(html, /&lt;odd&gt;/);
  assert.doesNotMatch(html, /<odd>/);
  assert.match(html, /style="width:41\.67%"/);
  assert.match(models(FACTS), /Opus 5\.5<span class="sub">keystone<\/span>/);
});

test("heatmap has a cell for every weekday and hour", () => {
  const html = heatmap(FACTS);
  assert.equal(count(html, '<rect class="heat'), 168);
  assert.equal(count(html, '<rect class="heat h5"'), 1);
});

test("kpis show deltas against a previous window and fold outcomes into one card", () => {
  const withPrevious = { ...FACTS, previous: { overview: { ...FACTS.overview, sessions: 10, cost: { total: 100 } } } };
  const html = kpis(withPrevious, {
    outcomes: { merge_requests: [{ merged: [{}, {}] }], git: [{ landed: [{}, {}, {}] }], jira: { closed_by_you: [{}] } },
  });
  assert.equal(count(html, '<div class="kpi '), 6);
  assert.match(html, /style="--n:6"/);
  assert.match(html, /▲ 20%/);
  assert.match(html, /▼ 50%/);
  assert.match(html, /3 commits landed, 1 ticket closed/);
  assert.equal(count(kpis(FACTS), '<span class="delta"'), 0);
});

test("outcomes that could not be checked are never shown as zero", () => {
  const value = (outcomes) => /t-outcomes"><div class="kpi-value">([^<]*)<\/div>[\s\S]*?kpi-sub">([^<]*)/.exec(kpis(FACTS, { outcomes })).slice(1);
  // glab not installed: no merge_requests at all.
  assert.deepEqual(value({ git: [{ landed: [{}] }], notes: ["glab is not installed: no merge requests"] }), ["n/a", "1 commit landed "]);
  // glab failed for one repo, and one repo was past --max-repos.
  assert.deepEqual(
    value({ merge_requests: [{ merged: [{}] }, { note: "glab: 401" }], git: [{ landed: [] }, { landed: [] }], repos_not_checked: 1 }),
    ["1", "MRs (2 repos not checked), 0 commits landed (1 repo not checked) "],
  );
  assert.deepEqual(value({ merge_requests: [{ skipped: "GitHub remote" }], git: [] }), ["n/a", "MRs (1 repo not checked), commits not checked "]);
  // A repo whose commits could not be read is named, even when every MR query worked.
  assert.deepEqual(value({ merge_requests: [{ merged: [] }, { merged: [] }], git: [{ landed: [{}] }, { note: "no git user.email configured" }] }), [
    "0",
    "1 commit landed (1 repo not checked) ",
  ]);
});

test("labels for models and repos read like names", () => {
  assert.deepEqual(modelLabel("keystone/claude-opus-5-5"), { name: "Opus 5.5", provider: "keystone" });
  assert.deepEqual(modelLabel("openai-codex/gpt-6-astra"), { name: "GPT-6 Astra", provider: "openai-codex" });
  assert.deepEqual(modelLabel("openai-codex/gpt-6.1-sol"), { name: "GPT-6.1 Sol", provider: "openai-codex" });
  assert.deepEqual(modelLabel("anthropic-vertex/claude-fable-5-1"), { name: "Fable 5.1", provider: "anthropic-vertex" });
  assert.equal(modelLabel("?/claude-sonnet-5").provider, null);
  assert.equal(repoLabel("/Users/me/.pi/agent/sessions"), "agent/sessions");
  assert.equal(repoLabel("/Users/me/Development/tmobile/nba2"), "nba2");
});

test("niceMax rounds axis tops to readable steps", () => {
  assert.equal(niceMax(9.5), 10);
  assert.equal(niceMax(7.2), 8);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(130), 150);
});

test("contours are deterministic per seed", () => {
  assert.equal(contours("2026-10-20"), contours("2026-10-20"));
  assert.notEqual(contours("2026-10-20"), contours("2026-10-21"));
  assert.match(contours("x"), /^<svg class="topo"[^>]*aria-hidden="true"/);
});
