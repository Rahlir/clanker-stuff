// Checks a report must pass before it is published, and the sidecar JSON
// written next to it. Pure: the CLI (scripts/render.mjs) does the I/O.

// A session ref: local creation time, or Sx and the id's start when the
// session's creation time is unreadable (see pi-sessions' assignRefs).
export const SESSION_REF = /^S(?:\d{6}-\d{4}|x[0-9a-z-]{1,8})[a-z0-9]*$/;
const REF = SESSION_REF;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// An earlier recommendation: report key (a date, maybe with a variant), then its id.
export const EARLIER = /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)*#[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS = { quick: "rec", big: "bet" };
const STATUSES = ["new", "repeat", "follow-up"];
const RINGS = ["try", "look", "watch", "pass"];
// `unclear` exists so that following up every item never forces a guess.
export const OUTCOMES = {
  adopted: "adopted",
  partly: "partly adopted",
  "not-adopted": "not adopted",
  dropped: "dropped",
  superseded: "superseded",
  unclear: "unclear",
};

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  hellip: "\u2026",
  middot: "\u00b7",
  bull: "\u2022",
  times: "\u00d7",
  minus: "\u2212",
  rarr: "\u2192",
  larr: "\u2190",
  colon: ":",
  tab: "\t",
  newline: "\n",
};

// Browsers decode numeric references without the closing ";" too.
const decodeEntities = (text) =>
  text.replace(/&(?:#(\d+);?|#x([0-9a-f]+);?|([a-z]+);)/gi, (m, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? m;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

const BLOCK_TAG =
  /<\/?(?:br|hr|p|div|li|ul|ol|dl|dt|dd|h[1-6]|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|main|blockquote|figure|figcaption|pre|cite)\b[^>]*>/gi;

/**
 * Visible text of an HTML fragment: no styles, scripts or comments, entities
 * decoded. Block tags break lines; inline tags (em, code, a) vanish without a
 * space, as in the browser, so "<em>builder</em>," reads "builder,".
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(BLOCK_TAG, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const flat = (text) => String(text).replace(/\s+/g, " ").trim();
const countClass = (body, tag, cls) => (body.match(new RegExp(`<${tag}\\b[^>]*\\sclass="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`, "g")) ?? []).length;

// Markup that can run code or load another document when the report is
// opened. The body is written by an agent that has just read web pages, so a
// prompt-injected body must not get past the renderer.
// The page's CSP (render.mjs) is what actually stops such markup; these checks
// tell the agent early, in words. Browsers also split attributes on "/" and
// right after a closing quote, and a quoted value may hold ">".
const UNSAFE_TAGS = /<\s*(iframe|frame|frameset|object|embed|applet|link|meta|base|form)\b/gi;
const TAG = /<[a-z][a-z0-9-]*(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const HANDLER = /[\s/"'](on[a-z]+|srcdoc|formaction)\s*=/i;
const URL_ATTR = /[\s/"'](?:href|src|xlink:href|action|formaction|background|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function unsafeUrl(value) {
  // Browsers ignore whitespace and control characters inside a scheme.
  const url = value.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
  if (url.startsWith("javascript:") || url.startsWith("vbscript:")) return true;
  return url.startsWith("data:") && !/^data:image\/(png|jpe?g|gif|webp)[;,]/.test(url);
}

const chartIn = (html, name) => new RegExp(`<!--\\s*chart:${name}\\s*-->`).test(html);

/**
 * Problems in the body itself: em dashes in any form (the user's hard rule),
 * scripts, styles and other active markup (the shell owns those), sections
 * without an <h2>, and required sections out of spec order or missing their
 * charts. `requiredSections` holds spec entries ({ id, charts }) or bare ids.
 */
export function lintBody(body, requiredSections = [], { heroCharts = [] } = {}) {
  const errors = [];
  const spec = requiredSections.map((s) => (typeof s === "string" ? { id: s } : s));
  const required = spec.map((s) => s.id);
  const dashes = (body.match(/\u2014|&mdash;|&#0*8212(?![0-9]);?|&#x0*2014(?![0-9a-f]);?/gi) ?? []).length;
  if (dashes) {
    const text = flat(htmlToText(body));
    const at = text.indexOf("\u2014");
    const near = at >= 0 ? `, first near "${text.slice(Math.max(0, at - 40), at + 40)}"` : "";
    errors.push(`${dashes} em dash${dashes === 1 ? "" : "es"} in the body${near}; rewrite without them`);
  }
  if (/<(script|style)\b/i.test(body)) errors.push("the body must not contain <script> or <style>; the shell provides both");
  if (/<!--\s*slot:/i.test(body)) errors.push("the body must not contain <!--slot:...--> markers; the shell owns them");
  const unsafe = new Set([...body.matchAll(UNSAFE_TAGS)].map((m) => `<${m[1].toLowerCase()}>`));
  for (const tag of body.match(TAG) ?? []) {
    // Attribute names are read with the values blanked out, so a value that
    // merely mentions "onclick=" is not a handler.
    const handler = HANDLER.exec(tag.replace(/"[^"]*"|'[^']*'/g, '""'));
    if (handler) unsafe.add(`${handler[1].toLowerCase()}= attribute`);
    for (const m of tag.matchAll(URL_ATTR)) {
      if (unsafeUrl(decodeEntities(m[1] ?? m[2] ?? m[3]))) unsafe.add("javascript:, vbscript: or non-image data: link");
    }
  }
  if (unsafe.size) errors.push(`the body must not contain active markup: ${[...unsafe].join(", ")}`);

  const sections = [...body.matchAll(/<section\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((m, i, all) => ({
    id: m[1],
    html: body.slice(m.index, all[i + 1]?.index ?? body.length),
  }));
  for (const s of sections) if (!/<h2\b/i.test(s.html)) errors.push(`section "${s.id}" needs an <h2> that states its finding`);
  for (const { id, charts = [] } of spec) {
    const s = sections.find((x) => x.id === id);
    const missing = s ? charts.filter((name) => !chartIn(s.html, name)) : [];
    if (missing.length) errors.push(`section "${id}" needs ${missing.map((n) => `<!--chart:${n}-->`).join(", ")}`);
  }
  const hero = /<header\b[^>]*class="hero"[\s\S]*?<\/header>/.exec(body)?.[0] ?? "";
  const heroMissing = heroCharts.filter((name) => !chartIn(hero, name));
  if (heroMissing.length) errors.push(`the hero needs ${heroMissing.map((n) => `<!--chart:${n}-->`).join(", ")}`);
  const carried = (body.match(/<!--\s*chart:carried\s*-->/g) ?? []).length;
  if (carried > 1) errors.push(`<!--chart:carried--> appears ${carried} times; it belongs in the since-last section once`);

  const order = sections.map((s) => s.id).filter((id) => required.includes(id));
  const expected = required.filter((id) => order.includes(id));
  if (order.join() !== expected.join()) errors.push(`required sections out of order: found ${order.join(", ")}; expected ${expected.join(", ")}`);
  return errors;
}

/** Problems in findings.json (see SKILL.md for the format). */
export function validateFindings(findings) {
  const errors = [];
  if (!findings || typeof findings !== "object" || Array.isArray(findings)) return ["findings.json must be a JSON object"];
  for (const key of Object.keys(findings)) {
    if (!["verdict", "recommendations", "carried", "community"].includes(key)) errors.push(`findings: unknown key "${key}"`);
  }
  if (typeof findings.verdict !== "string" || !findings.verdict.trim()) errors.push("findings.verdict must be the verdict sentence");

  const recs = Array.isArray(findings.recommendations) ? findings.recommendations : null;
  if (!recs) errors.push("findings.recommendations must be an array");
  const ids = new Set();
  for (const [i, r] of (recs ?? []).entries()) {
    const at = `findings.recommendations[${i}]`;
    for (const key of Object.keys(r ?? {})) {
      if (!["id", "kind", "title", "summary", "refs", "status", "previous"].includes(key)) errors.push(`${at}: unknown key "${key}"`);
    }
    if (!SLUG.test(r?.id ?? "")) errors.push(`${at}.id must be a lowercase slug`);
    else if (ids.has(r.id)) errors.push(`${at}.id "${r.id}" is used twice`);
    ids.add(r?.id);
    if (!KINDS[r?.kind]) errors.push(`${at}.kind must be quick or big`);
    if (typeof r?.title !== "string" || !r.title.trim()) errors.push(`${at}.title is required`);
    if (typeof r?.summary !== "string" || !r.summary.trim()) errors.push(`${at}.summary is required`);
    if (!Array.isArray(r?.refs) || !r.refs.length) errors.push(`${at}.refs must list the sessions it rests on`);
    else for (const ref of r.refs) if (!REF.test(ref)) errors.push(`${at}.refs: "${ref}" is not a session ref`);
    if (!STATUSES.includes(r?.status)) errors.push(`${at}.status must be ${STATUSES.join(", ")}`);
    if (r?.previous != null && !EARLIER.test(r.previous)) errors.push(`${at}.previous must look like 2026-10-13#some-id`);
    if (["repeat", "follow-up"].includes(r?.status) && !r?.previous) errors.push(`${at}: a ${r.status} must name the previous recommendation`);
  }
  for (const kind of Object.keys(KINDS)) {
    if (recs && !recs.some((r) => r?.kind === kind)) errors.push(`findings.recommendations needs at least one "${kind}" item`);
  }

  const carried = findings.carried ?? [];
  if (!Array.isArray(carried)) errors.push("findings.carried must be an array");
  const followed = new Set();
  for (const [i, c] of (Array.isArray(carried) ? carried : []).entries()) {
    const at = `findings.carried[${i}]`;
    for (const key of Object.keys(c ?? {})) if (!["ref", "outcome", "evidence", "effect", "refs"].includes(key)) errors.push(`${at}: unknown key "${key}"`);
    if (!EARLIER.test(c?.ref ?? "")) errors.push(`${at}.ref must be an earlier recommendation id such as 2026-10-13#some-id`);
    else if (followed.has(c.ref)) errors.push(`${at}.ref "${c.ref}" is followed up twice`);
    followed.add(c?.ref);
    if (!OUTCOMES[c?.outcome]) errors.push(`${at}.outcome must be ${Object.keys(OUTCOMES).join(", ")}`);
    if (typeof c?.evidence !== "string" || !c.evidence.trim()) errors.push(`${at}.evidence must say what happened and how you know`);
    if (c?.effect != null && typeof c.effect !== "string") errors.push(`${at}.effect must be text or null`);
    if (c?.refs != null && (!Array.isArray(c.refs) || c.refs.some((ref) => !REF.test(ref)))) errors.push(`${at}.refs must be session refs`);
    for (const text of [c?.evidence, c?.effect]) {
      if (typeof text === "string" && text.includes("\u2014")) errors.push(`${at}: em dash in "${text.slice(0, 60)}"`);
    }
  }

  const community = Array.isArray(findings.community) ? findings.community : null;
  if (!community || !community.length) errors.push("findings.community must list the community finds");
  for (const [i, c] of (community ?? []).entries()) {
    const at = `findings.community[${i}]`;
    for (const key of Object.keys(c ?? {})) if (!["name", "url", "ring"].includes(key)) errors.push(`${at}: unknown key "${key}"`);
    if (typeof c?.name !== "string" || !c.name.trim()) errors.push(`${at}.name is required`);
    if (!/^https?:\/\//.test(c?.url ?? "")) errors.push(`${at}.url must be an http(s) link`);
    if (!RINGS.includes(c?.ring)) errors.push(`${at}.ring must be ${RINGS.join(", ")}`);
  }
  for (const text of [findings.verdict, ...(recs ?? []).flatMap((r) => [r?.title, r?.summary])]) {
    if (typeof text === "string" && text.includes("\u2014")) errors.push(`findings: em dash in "${text.slice(0, 60)}"`);
  }
  return errors;
}

/** findings.json and the body must describe the same report. Tolerates malformed findings. */
export function crossCheck(body, findings) {
  const errors = [];
  if (!findings || typeof findings !== "object") return errors;
  // Malformed parts were already reported by validateFindings; skip them here.
  const recs = Array.isArray(findings.recommendations) ? findings.recommendations : [];
  const community = Array.isArray(findings.community) ? findings.community : null;
  const text = flat(htmlToText(body));
  if (typeof findings.verdict === "string" && findings.verdict && !text.includes(flat(findings.verdict))) {
    errors.push("findings.verdict does not appear in the body (put it in the verdict card's .line)");
  }
  for (const r of recs) {
    if (typeof r?.title === "string" && r.title && !text.includes(flat(r.title))) errors.push(`recommendation "${r.title}" is not in the body`);
  }
  for (const c of community ?? []) {
    if (typeof c?.name === "string" && c.name && !text.includes(flat(c.name))) errors.push(`community find "${c.name}" is not in the body`);
  }
  for (const [kind, cls] of Array.isArray(findings.recommendations) ? Object.entries(KINDS) : []) {
    const inFindings = recs.filter((r) => r?.kind === kind).length;
    const inBody = countClass(body, "article", cls);
    if (inFindings !== inBody) {
      errors.push(`${inBody} <article class="${cls}"> cards in the body but ${inFindings} "${kind}" recommendations in findings.json`);
    }
  }
  const finds = countClass(body, "article", "find");
  if (community && finds !== community.length) {
    errors.push(`${finds} <article class="find"> cards in the body but ${community.length} community finds in findings.json`);
  }
  return errors;
}

/**
 * findings.json against the earlier reports' sidecars: every followed-up id
 * exists, every repeat or follow-up names an id that is followed up here, and
 * the latest earlier report has every one of its recommendations followed up.
 * `index` is history.mjs's historyIndex, `latest` its latestBefore.
 */
export function checkHistory(findings, index, latest) {
  const errors = [];
  if (!findings || typeof findings !== "object") return errors;
  const carried = new Set((Array.isArray(findings.carried) ? findings.carried : []).map((c) => c?.ref));
  for (const ref of carried) {
    if (ref && EARLIER.test(ref) && !index.has(ref)) errors.push(`findings.carried: no earlier report recommended "${ref}" (history.mjs prints every id)`);
  }
  for (const r of Array.isArray(findings.recommendations) ? findings.recommendations : []) {
    if (!r?.previous || !EARLIER.test(r.previous)) continue;
    if (!index.has(r.previous)) errors.push(`recommendation "${r.id}": previous "${r.previous}" is not an earlier recommendation`);
    else if (!carried.has(r.previous)) errors.push(`recommendation "${r.id}": its previous "${r.previous}" must also be followed up in findings.carried`);
  }
  if (latest) {
    const missing = (Array.isArray(latest.sidecar.recommendations) ? latest.sidecar.recommendations : [])
      .map((r) => `${latest.key}#${r?.id}`)
      .filter((id) => !carried.has(id));
    if (missing.length) errors.push(`findings.carried must follow up every recommendation of the ${latest.key} report; missing ${missing.join(", ")}`);
  }
  return errors;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-13" -> "13 Oct"; a variant key keeps its suffix: "6 Oct (opus5)". */
export function reportLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:-(.+))?$/.exec(key ?? "");
  if (!m) return key ?? "?";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${m[4] ? ` (${m[4]})` : ""}`;
}

export const KIND_LABEL = { quick: "quick win", big: "big idea" };

/** The element id of a followed-up item, which its [[R:...]] chips link to. */
export const carriedAnchor = (id) => `carried-${id.replace(/[^a-z0-9-]/gi, "-")}`;

/**
 * The followed-up items joined with the earlier report's own wording, and the
 * hover data for [[R:...]] chips. Items whose id does not resolve are left out
 * (checkHistory reports them).
 */
export function resolveCarried(findings, index) {
  const carried = [];
  const reportInfo = {};
  for (const c of Array.isArray(findings?.carried) ? findings.carried : []) {
    const earlier = index.get(c?.ref);
    if (!earlier) continue;
    const item = { ...earlier, outcome: c.outcome, evidence: c.evidence, effect: c.effect ?? null, refs: c.refs ?? [] };
    carried.push(item);
    const kind = KIND_LABEL[earlier.kind] ?? "recommendation";
    // The chip names only the source; the prose around it names the recommendation.
    reportInfo[earlier.id] = {
      label: `${reportLabel(earlier.key)} report`,
      anchor: carriedAnchor(earlier.id),
      name: earlier.title,
      meta: `${kind}, now ${OUTCOMES[c.outcome] ?? c.outcome}`,
      prompt: earlier.summary,
    };
  }
  return { carried, reportInfo };
}

/** Session refs findings.json relies on: `refs` lists, and [[S...]] markers in followed-up text, which the page renders. */
export function findingsRefs(findings) {
  const carried = Array.isArray(findings.carried) ? findings.carried : [];
  const recs = Array.isArray(findings.recommendations) ? findings.recommendations : [];
  const listed = [...recs, ...carried].flatMap((r) => (Array.isArray(r?.refs) ? r.refs : []));
  const inline = carried.flatMap((c) =>
    [c?.evidence, c?.effect].flatMap((text) => (typeof text === "string" ? [...text.matchAll(/\[\[(S[^\]\n]+)\]\]/g)].map((m) => m[1]) : [])),
  );
  return [...new Set([...listed, ...inline])];
}

/** outcomes.json must cover the report's window, or its counts describe other days. */
export function checkOutcomes(outcomes, window) {
  if (!outcomes) return [];
  const same = (a, b) => Date.parse(a) === Date.parse(b);
  if (!outcomes.window || !same(outcomes.window.since, window.since) || !same(outcomes.window.until, window.until)) {
    return [
      `outcomes.json covers ${outcomes.window?.since ?? "?"} to ${outcomes.window?.until ?? "?"}, the report ${window.since} to ${window.until}: ` +
        "rerun piss outcomes with the report's --corpus, --since and --until",
    ];
  }
  return [];
}

/**
 * Counts from `piss outcomes --json`, for the KPI card and the sidecar. A
 * repo whose MRs or commits could not be read (glab failed, a GitHub remote,
 * no git email, past --max-repos) is counted as not checked, never as zero;
 * a count is null when nothing could be checked at all.
 */
export function outcomeCounts(outcomes) {
  if (!outcomes) return null;
  const beyond = outcomes.repos_not_checked ?? 0;
  const tally = (list, key) => {
    if (!Array.isArray(list)) return { count: null, unchecked: null };
    const checked = list.filter((x) => Array.isArray(x?.[key]));
    return { count: checked.length ? checked.reduce((s, x) => s + x[key].length, 0) : null, unchecked: list.length - checked.length + beyond };
  };
  const mrs = tally(outcomes.merge_requests, "merged");
  const commits = tally(outcomes.git, "landed");
  return {
    mrs_merged: mrs.count,
    mrs_repos_not_checked: mrs.unchecked,
    commits_landed: commits.count,
    commit_repos_not_checked: commits.unchecked,
    tickets_closed_by_you: outcomes.jira?.closed_by_you?.length ?? null,
    tickets_assigned_resolved: outcomes.jira?.assigned_resolved?.length ?? null,
    tickets_created_by_you: outcomes.jira?.created_by_you?.length ?? null,
    // Per-repo notes say which repo could not be read and why; the Method
    // section needs them next to the general ones.
    notes: [
      ...(Array.isArray(outcomes.notes) ? outcomes.notes : []),
      ...[...(outcomes.git ?? []), ...(outcomes.merge_requests ?? [])]
        .filter((x) => x?.note || x?.skipped)
        .map((x) => `${x.repo}: ${x.note ?? `skipped (${x.skipped})`}`),
    ],
  };
}

/**
 * The machine-readable record written next to the report. history.mjs reads
 * it to track recommendations across reports; `facts` keeps the headline
 * numbers so a later report can cite them without parsing HTML.
 */
export function sidecar({ date, generatedAt, generator, facts, outcomes, findings, refs, reportFile }) {
  return {
    schema: 1,
    date,
    report: reportFile,
    generated_at: generatedAt,
    generator,
    window: { since: facts.window.since, until: facts.window.until },
    corpus: {
      built_at: facts.corpus?.built_at ?? null,
      since: facts.corpus?.since ?? null,
      pi_version: facts.corpus?.pi_version ?? null,
      excluded_session: facts.corpus?.excluded_session || null,
      warnings: facts.corpus?.warnings ?? [],
    },
    verdict: findings.verdict,
    recommendations: findings.recommendations,
    carried: findings.carried ?? [],
    community: findings.community,
    facts: {
      overview: facts.overview,
      models: (facts.models ?? []).slice(0, 10).map((m) => ({ model: m.model, turns: m.turns, cost: m.total })),
      repos: (facts.repos ?? []).slice(0, 10).map((r) => ({ repo: r.repo, sessions: r.sessions, user_s: r.user_s, agent_s: r.agent_s, cost: r.cost })),
      tags: facts.tags ?? [],
    },
    outcomes: outcomeCounts(outcomes),
    refs,
  };
}
