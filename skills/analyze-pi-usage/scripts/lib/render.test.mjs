import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FACTS, HISTORY } from "./fixtures.mjs";
import { historyIndex } from "./history.mjs";
import { resolveCarried } from "./publish.mjs";
import { createHash } from "node:crypto";
import { colophon, contentSecurityPolicy, renderReport } from "./render.mjs";
import { REQUIRED_SECTIONS } from "./spec.mjs";

process.env.TZ = "UTC";

const shell = readFileSync(new URL("../../assets/report-shell.html", import.meta.url), "utf8");
const refInfo = { "S261013-1258": { name: "usage report", meta: "Oct 13", prompt: "/analyze-pi-usage" } };

const render = (body, extra = {}) => renderReport({ shell, body, facts: FACTS, refInfo, title: "t", seed: "s", ...extra });

const BODY = `<header class="hero"><h1>Title</h1><!--chart:kpis--></header>
<section id="overview" data-label="Overview"><h2>One</h2><!--chart:daily--><p>Cost $& and $' stay literal [[S261013-1258]]</p></section>
<section id="works" data-label="What works"><h2>Two</h2></section>`;

test("a valid body renders with numbered sections, charts, refs and slots filled", () => {
  const r = render(BODY);
  assert.deepEqual(r.errors, []);
  assert.equal(r.sections, 2);
  assert.deepEqual(r.charts, ["kpis", "daily"]);
  assert.deepEqual(r.refs, ["S261013-1258"]);
  assert.match(r.html, /<a href="#overview"><span class="n">01<\/span><span class="t">Overview<\/span><\/a>/);
  assert.match(r.html, /<p class="eyebrow"><span class="num">02<\/span><span>What works<\/span><\/p>/);
  assert.match(r.html, /<p class="kicker"><span>pi field notes<\/span>/);
  assert.match(r.html, /<svg class="topo"/);
  assert.match(r.html, /data-ref="S261013-1258"/);
  assert.match(r.html, /Cost \$& and \$' stay literal/);
  assert.doesNotMatch(r.html, /<!--slot:|<!--chart:|\[\[/);
});

test("problems a report must not ship with are errors", () => {
  const r = render(
    `<section id="a"><h2>x</h2></section><section id="b" data-label="B"></section><section id="b" data-label="B2"></section>
     <!--chart:pie--> [[S999999-9999]] [[not a ref]]`,
  );
  assert.deepEqual(r.errors, [
    'the body must start with <header class="hero">',
    'every <section> needs id and data-label: <section id="a">',
    'duplicate section id "b"',
    'unknown chart "pie" (known: daily, weekly, models, repos, heatmap, kpis, carried)',
    "unknown session ref S999999-9999",
    "malformed session ref [[not a ref]]",
  ]);
});

test("a body without a required section is refused", () => {
  const r = render(BODY, { requiredSections: ["overview", "community", "works"] });
  assert.deepEqual(r.errors, ['missing required section "community"']);
});

test("the example body follows the spec: every required section, in order, known charts, well-formed refs", () => {
  const body = readFileSync(new URL("../../assets/example-body.html", import.meta.url), "utf8");
  const findings = JSON.parse(readFileSync(new URL("../../assets/example-findings.json", import.meta.url), "utf8"));
  const refs = Object.fromEntries([...body.matchAll(/\[\[(S[^\]]+)\]\]/g)].map((m) => [m[1], { name: "x", meta: "", prompt: "" }]));
  for (const c of findings.carried) for (const m of c.evidence.matchAll(/\[\[(S[^\]]+)\]\]/g)) refs[m[1]] = { name: "x", meta: "", prompt: "" };
  for (const c of findings.carried) for (const ref of c.refs) refs[ref] = { name: "x", meta: "", prompt: "" };
  const { carried, reportInfo } = resolveCarried(findings, historyIndex(HISTORY));
  const r = render(body, { refInfo: refs, reportInfo, carried, requiredSections: REQUIRED_SECTIONS.map((s) => s.id) });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.reportRefs, ["2026-10-13#decisions-captured-as-you-make-them"]);
  const ids = [...body.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, REQUIRED_SECTIONS.map((s) => s.id));
});

test("report refs become chips that link to the followed-up card, which quotes the earlier wording", () => {
  const findings = {
    carried: [
      {
        ref: "2026-10-13#give-investigations-an-exit",
        outcome: "not-adopted",
        evidence: "Still missing <here>, see [[S261013-1258]].",
        effect: null,
        refs: ["S261013-1258"],
      },
      { ref: "2026-10-13#quick-short-squash", outcome: "adopted", evidence: "Done.", effect: "No more corrections.", refs: ["S261013-1258"] },
    ],
  };
  const { carried, reportInfo } = resolveCarried(findings, historyIndex(HISTORY));
  const body = `<header class="hero"><h1>T</h1></header><section id="since-last" data-label="Since the last report"><h2>x</h2><!--chart:carried--></section>
    <section id="quick-wins" data-label="Quick wins"><h2>y</h2><p>A follow-up to [[R:2026-10-13#give-investigations-an-exit]].</p></section>`;
  const r = render(body, { reportInfo, carried });
  assert.deepEqual(r.errors, []);
  assert.match(r.html, /<span class="ref report" tabindex="0" role="button" data-ref="R:2026-10-13#give-investigations-an-exit" data-anchor="carried-2026-10-13-give-investigations-an-exit">13 Oct report<\/span>/);
  assert.match(r.html, /<article class="carry" id="carried-2026-10-13-give-investigations-an-exit" data-outcome="not-adopted">/);
  assert.match(r.html, /<span class="carry-from">quick win<\/span><span class="carry-outcome">not adopted<\/span>/);
  assert.match(r.html, /<p class="carried-from"><span>13 Oct report<\/span><span>2 of 3 recommendations<\/span><\/p>/);
  const [, first, second] = r.html.split('<article class="carry"');
  assert.doesNotMatch(first.split("</article>")[0], /class="evidence"/, "a session cited inline is not listed again");
  assert.match(second.split("</article>")[0], /<p class="evidence"><span class="ref"[^>]*data-ref="S261013-1258"/);
  assert.match(r.html, /<p class="carry-original">Every investigation ends with its follow-ups/);
  assert.match(r.html, /Still missing &lt;here&gt;, see <span class="ref" tabindex="0" role="button" data-ref="S261013-1258">/);
  assert.match(r.html, /<p class="carry-effect">No more corrections\.<\/p>/);
  assert.match(r.html, /"R:2026-10-13#give-investigations-an-exit":\{"name":"Give investigations an exit","meta":"quick win, now not adopted"/);

  const bad = render(`${body}<p>[[R:2026-10-13#quick-model-ring]] [[R:last week]]</p>`, { reportInfo, carried });
  assert.deepEqual(bad.errors, ["report ref [[R:2026-10-13#quick-model-ring]] is not followed up in findings.carried", "malformed report ref [[R:last week]]"]);
  assert.match(render(body.replace(/<p>A follow-up[^<]*<\/p>/, "")).html, /class="carried-empty"/);
});

test("followed-up cards are grouped by report, newest first, each group counted against its report", () => {
  const older = { key: "2026-10-06", date: "2026-10-06", sidecar: { recommendations: [{ id: "x", kind: "big", title: "X", summary: "s" }, { id: "y" }] } };
  const findings = {
    carried: [
      { ref: "2026-10-06#x", outcome: "adopted", evidence: "Built.", refs: [] },
      { ref: "2026-10-13#quick-short-squash", outcome: "adopted", evidence: "Done.", refs: [] },
    ],
  };
  const { carried } = resolveCarried(findings, historyIndex([...HISTORY, older]));
  const body = `<header class="hero"><h1>T</h1></header><section id="since-last" data-label="Since the last report"><h2>x</h2><!--chart:carried--></section>`;
  const labels = [...render(body, { carried }).html.matchAll(/<p class="carried-from"><span>([^<]+)<\/span><span>([^<]+)<\/span>/g)].map((m) => `${m[1]}: ${m[2]}`);
  assert.deepEqual(labels, ["13 Oct report: 1 of 3 recommendations", "6 Oct report: 1 of 2 recommendations"]);
});

test("the page allows only the shell's own scripts, by hash, and loads nothing from outside", () => {
  const csp = contentSecurityPolicy(shell);
  const scripts = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  assert.equal(scripts.length, 2);
  assert.equal(csp, `default-src 'none'; script-src ${scripts.join(" ")}; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`);
  const r = render(BODY);
  assert.ok(r.html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`));
  // The hashes come from the shell, so a script that reached the body is not
  // allowed to run (lintBody rejects it too).
  const injected = render(BODY.replace("<h2>Two</h2>", "<h2>Two</h2><script>x()</script>"));
  assert.ok(injected.html.includes(`content="${csp}"`));
});

test("slot markers in the body stay text, and Sx refs from unreadable creation times are citable", () => {
  const r = render(BODY.replace("<h2>Two</h2>", "<h2>Two</h2><p><!--slot:footer--> [[Sx0199aaaa]]</p>"), {
    refInfo: { ...refInfo, Sx0199aaaa: { name: "x", meta: "", prompt: "" } },
    colophon: "FOOTER",
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.html.split("FOOTER").length - 1, 1, "the footer goes into the shell's slot only");
  assert.match(r.html, /data-ref="Sx0199aaaa"/);
});

test("quoted earlier wording keeps its refs as text, and em dashes drawn from data are reported", () => {
  const index = historyIndex([
    { key: "2026-10-13", date: "2026-10-13", sidecar: { recommendations: [{ id: "a", kind: "quick", title: "Fix it \u2014 now", summary: "As in [[S260101-0101]]." }] } },
  ]);
  const { carried } = resolveCarried({ carried: [{ ref: "2026-10-13#a", outcome: "adopted", evidence: "Done.", refs: [] }] }, index);
  const body = `<header class="hero"><h1>T</h1></header><section id="since-last" data-label="Since"><h2>x</h2><!--chart:carried--></section>`;
  const r = render(body, { carried });
  assert.deepEqual(r.errors, ["1 em dash in text drawn into the page (an earlier report's sidecar or a label)"]);
  assert.match(r.html, /As in &#91;&#91;S260101-0101\]\]\./);
});

test("ref data embedded in the page cannot close its script tag", () => {
  const r = render(BODY, { refInfo: { "S261013-1258": { name: "</script><b>x</b>", meta: "", prompt: "" } } });
  assert.match(r.html, /\\u003c\/script>\\u003cb>x\\u003c\/b>/);
  assert.equal(r.html.split("</script>").length - 1, shell.split("</script>").length - 1);
});

test("the colophon names the generator and the corpus coverage", () => {
  const html = colophon({
    generatedAt: "2026-10-20 22:00",
    model: "keystone/claude-opus-5-5",
    thinking: "xhigh",
    corpus: { built_at: "2026-10-20T20:00:00Z", pi_version: "1.3.0", warnings: ["2 malformed lines skipped"] },
  });
  assert.match(html, /keystone\/claude-opus-5-5<\/strong>, thinking <strong>xhigh/);
  assert.match(html, /coverage WARN: 2 malformed lines skipped/);
});
