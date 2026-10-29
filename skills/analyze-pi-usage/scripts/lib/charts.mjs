// Charts and fact-driven blocks for the report, drawn from `piss facts --json`.
// Pure: data in, HTML/SVG strings out. Colors come from CSS classes defined in
// assets/report-shell.html, so the theme toggle restyles charts without a
// re-render and every number on a chart is the corpus's number.

import { hours, int, money } from "../../../pi-sessions/scripts/lib/format.mjs";
import { carriedAnchor, KIND_LABEL, OUTCOMES, outcomeCounts, reportLabel } from "./publish.mjs";

const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const round1 = (n) => Math.round(n * 10) / 10;
const plural = (n, word) => `${int(n)} ${word}${n === 1 ? "" : "s"}`;
const h = (seconds) => (seconds ?? 0) / 3600;
// Whole dollars from $10 up: chart labels need to scan, not reconcile.
const usd = (n) => (Math.abs(n ?? 0) >= 10 ? money(n).replace(/\.\d\d$/, "") : money(n));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad2 = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayLabel = (day) => {
  const [, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};

/** Every local calendar day the window touches, so quiet days show as gaps. */
export function windowDays(window) {
  const out = [];
  const end = new Date(new Date(window.until).getTime() - 1);
  const d = new Date(window.since);
  d.setHours(0, 0, 0, 0);
  while (d <= end) {
    out.push(localDay(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Round an axis maximum up to a readable step. */
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= value) return m * pow;
  return 10 * pow;
}

/** "keystone/claude-opus-5-5" -> { name: "Opus 5.5", provider: "keystone" }. */
export function modelLabel(id) {
  const [provider, model] = id.includes("/") ? [id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)] : [null, id];
  const words = [];
  for (const part of model.replace(/^claude-/, "").split("-")) {
    if (/^\d+(\.\d+)?$/.test(part) && /^\d/.test(words.at(-1) ?? "")) words[words.length - 1] += `.${part}`;
    else words.push(part === "gpt" ? "GPT" : /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1));
  }
  return { name: words.join(" ").replace("GPT ", "GPT-"), provider: provider === "?" ? null : provider };
}

/** Last path segment, or the last two when the last one is generic. */
export function repoLabel(path) {
  const parts = String(path ?? "").split("/").filter(Boolean);
  const last = parts.at(-1) ?? "?";
  return ["sessions", "agent", "src", "app"].includes(last) && parts.length > 1 ? `${parts.at(-2)}/${last}` : last;
}

function svg(width, height, body, label) {
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${body}</svg>`;
}

function legend(items) {
  return `<ul class="legend">${items.map(([cls, text]) => `<li><span class="key ${cls}"></span>${esc(text)}</li>`).join("")}</ul>`;
}

function figure(name, title, note, inner) {
  return (
    `<figure class="chart chart-${name}"><figcaption><span class="fig-num"></span>` +
    `<span class="fig-title">${esc(title)}</span>${note ? `<span class="fig-note">${esc(note)}</span>` : ""}</figcaption>${inner}</figure>`
  );
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

function stackedColumns(rows, { unitLabel, labelFor, tickFor, shade, title, costLabels }) {
  const W = 760;
  const H = 260;
  const left = 34;
  const right = 8;
  const top = costLabels ? 24 : 12;
  const bottom = 28;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const max = niceMax(Math.max(...rows.map((r) => h(r.user_s) + h(r.agent_s)), 0.5));
  const step = plotW / Math.max(rows.length, 1);
  const barW = Math.max(2, Math.min(step * 0.72, 38));
  const y = (v) => top + plotH - (v / max) * plotH;
  const parts = [];
  for (const t of [0.25, 0.5, 0.75, 1]) {
    const v = max * t;
    parts.push(
      `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>`,
      `<text class="axis" x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${round1(v)}${unitLabel}</text>`,
    );
  }
  rows.forEach((r, i) => {
    const x = left + i * step;
    if (shade?.(r)) parts.push(`<rect class="shade" x="${x}" y="${top}" width="${step}" height="${plotH}"/>`);
  });
  parts.push(`<line class="baseline" x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}"/>`);
  rows.forEach((r, i) => {
    const cx = left + i * step + step / 2;
    const you = h(r.user_s);
    const agent = h(r.agent_s);
    const tip = `${labelFor(r)}: you ${hours(r.user_s)}, agent ${hours(r.agent_s)}, ${money(r.cost)}, ${plural(r.sessions, "session")}, ${plural(r.prompts, "prompt")}`;
    const bars = [];
    if (you > 0) bars.push(`<rect class="s-you" x="${cx - barW / 2}" y="${y(you)}" width="${barW}" height="${y(0) - y(you)}" rx="1.5"/>`);
    if (agent > 0) {
      bars.push(`<rect class="s-agent" x="${cx - barW / 2}" y="${y(you + agent)}" width="${barW}" height="${y(you) - y(you + agent)}" rx="1.5"/>`);
    }
    if (costLabels && r.cost > 0) {
      bars.push(`<text class="value" x="${cx}" y="${y(you + agent) - 6}" text-anchor="middle">${esc(usd(r.cost))}</text>`);
    }
    parts.push(`<g class="col"><title>${esc(tip)}</title><rect class="hit" x="${cx - step / 2}" y="${top}" width="${step}" height="${plotH}"/>${bars.join("")}</g>`);
    const tick = tickFor(r, i);
    if (tick) parts.push(`<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(tick)}</text>`);
  });
  return svg(W, H, parts.join(""), title);
}

/** Active hours per local day, you below the agent, weekends shaded. */
export function daily(facts) {
  const byDay = new Map((facts.days ?? []).map((d) => [d.day, d]));
  const rows = windowDays(facts.window).map((day) => ({ day, user_s: 0, agent_s: 0, cost: 0, sessions: 0, prompts: 0, ...byDay.get(day) }));
  const weekday = (day) => new Date(`${day}T12:00:00`).getDay();
  const peak = [...rows].sort((a, b) => b.user_s + b.agent_s - (a.user_s + a.agent_s))[0];
  const quiet = rows.filter((r) => r.user_s + r.agent_s === 0).length;
  const note = peak && peak.user_s + peak.agent_s > 0
    ? `peak ${dayLabel(peak.day)} (${hours(peak.user_s + peak.agent_s)}); ${quiet} of ${rows.length} days without activity`
    : "no activity";
  const chart = stackedColumns(rows, {
    unitLabel: "h",
    title: `Active hours per day, ${note}`,
    labelFor: (r) => `${WEEKDAYS[weekday(r.day)]} ${dayLabel(r.day)}`,
    // Mondays, plus the first day unless a Monday follows within two days.
    tickFor: (r, i) => (weekday(r.day) === 1 || (i === 0 && ![0, 6].includes(weekday(r.day))) ? dayLabel(r.day) : null),
    shade: (r) => [0, 6].includes(weekday(r.day)),
  });
  return figure("daily", "Active hours per day", note, chart + legend([["s-you", "you"], ["s-agent", "agent"], ["shade", "weekend"]]));
}

/** Active hours and spend per week (weeks start on Monday). */
export function weekly(facts) {
  const rows = facts.weeks ?? [];
  const chart = stackedColumns(rows, {
    unitLabel: "h",
    title: "Active hours and spend per week",
    labelFor: (r) => `Week of ${dayLabel(r.week)}`,
    tickFor: (r) => dayLabel(r.week),
    costLabels: true,
  });
  return figure("weekly", "Active hours and spend per week", "labels show corrected spend", chart + legend([["s-you", "you"], ["s-agent", "agent"]]));
}

// ---------------------------------------------------------------------------
// Ranked bars
// ---------------------------------------------------------------------------

// Ranked bars are HTML, not SVG: their labels keep the page's type size in a
// half-width column, where a scaled SVG would shrink them below legibility.
function rankedBars(rows, { segments, total, label, sub, value, more }) {
  const max = Math.max(...rows.map(total), 1e-9);
  const items = rows.map((r) => {
    const segs = segments
      .map(([cls, get, name]) => {
        const v = get(r);
        if (!(v > 0)) return "";
        return `<span class="seg ${cls}" style="width:${((100 * v) / max).toFixed(2)}%" title="${esc(`${name}: ${value(r, get)}`)}"></span>`;
      })
      .join("");
    return (
      `<div class="bar-label" title="${esc(label(r))}">${esc(label(r))}${sub(r) ? `<span class="sub">${esc(sub(r))}</span>` : ""}</div>` +
      `<div class="bar-track" role="img" aria-label="${esc(`${label(r)}: ${value(r)}`)}">${segs}</div>` +
      `<div class="bar-value">${esc(value(r))}</div>`
    );
  });
  return `<div class="bars">${items.join("")}</div>${more ? `<p class="fig-more">${esc(more)}</p>` : ""}`;
}

/** Spend per model, split into main agent, reviewers, and the rest. */
export function models(facts, { limit = 8 } = {}) {
  const all = (facts.models ?? []).filter((m) => m.total > 0.005);
  const rows = all.slice(0, limit);
  const totalCost = facts.overview?.cost?.total ?? all.reduce((s, m) => s + m.total, 0);
  const rest = all.slice(limit);
  const segments = [
    ["s-main", (m) => m.main, "main agent"],
    ["s-reviews", (m) => m.reviews, "code_review"],
    ["s-other", (m) => m.other + m.tools, "summaries and other"],
  ];
  const chart = rankedBars(rows, {
    segments,
    total: (m) => m.total,
    label: (m) => modelLabel(m.model).name,
    sub: (m) => modelLabel(m.model).provider,
    value: (m, get) => (get ? money(get(m)) : `${usd(m.total)} · ${Math.round((100 * m.total) / (totalCost || 1))}%`),
    more: rest.length ? `+${rest.length} more models, ${money(rest.reduce((s, m) => s + m.total, 0))} together` : null,
  });
  return figure(
    "models",
    "Spend per model",
    `${usd(totalCost)} corrected`,
    chart + legend([["s-main", "main agent"], ["s-reviews", "code_review reviewers"], ["s-other", "summaries, other"]]),
  );
}

/** Active time per repo, you and agent. */
export function repos(facts, { limit = 8 } = {}) {
  const all = (facts.repos ?? []).filter((r) => r.user_s + r.agent_s > 0);
  const rows = all.slice(0, limit);
  const rest = all.slice(limit);
  const chart = rankedBars(rows, {
    segments: [
      ["s-you", (r) => h(r.user_s), "you"],
      ["s-agent", (r) => h(r.agent_s), "agent"],
    ],
    total: (r) => h(r.user_s) + h(r.agent_s),
    label: (r) => repoLabel(r.repo),
    sub: () => null,
    value: (r, get) => (get ? `${round1(get(r))} h` : `${hours(r.user_s + r.agent_s)} · ${usd(r.cost)}`),
    more: rest.length ? `+${rest.length} more repos, ${hours(rest.reduce((s, r) => s + r.user_s + r.agent_s, 0))} together` : null,
  });
  return figure("repos", "Where the time went", "active hours per repo, with spend", chart + legend([["s-you", "you"], ["s-agent", "agent"]]));
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

/** Active time by local weekday and hour, Monday first. */
export function heatmap(facts) {
  const cells = new Map();
  for (const c of facts.heatmap ?? []) cells.set(`${c.weekday}:${c.hour}`, (c.user_s ?? 0) + (c.agent_s ?? 0));
  const max = Math.max(...cells.values(), 0);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const cellW = 27;
  const cellH = 22;
  const left = 44;
  const top = 22;
  const W = left + 24 * cellW + 4;
  const H = top + 7 * cellH + 6;
  const parts = [];
  for (let hr = 0; hr < 24; hr += 3) {
    parts.push(`<text class="axis" x="${left + hr * cellW + cellW / 2}" y="${top - 8}" text-anchor="middle">${pad2(hr)}</text>`);
  }
  order.forEach((wd, row) => {
    parts.push(`<text class="axis" x="${left - 8}" y="${top + row * cellH + cellH / 2 + 4}" text-anchor="end">${WEEKDAYS[wd]}</text>`);
    for (let hr = 0; hr < 24; hr++) {
      const v = cells.get(`${wd}:${hr}`) ?? 0;
      const level = v === 0 ? 0 : Math.min(5, 1 + Math.floor((4 * v) / (max || 1)));
      parts.push(
        `<rect class="heat h${level}" x="${left + hr * cellW + 1.5}" y="${top + row * cellH + 1.5}" width="${cellW - 3}" height="${cellH - 3}" rx="3">` +
          `<title>${WEEKDAYS[wd]} ${pad2(hr)}:00: ${hours(v)}</title></rect>`,
      );
    }
  });
  const scale = `<div class="heat-scale"><span>less</span>${[0, 1, 2, 3, 4, 5].map((l) => `<i class="heat-key h${l}"></i>`).join("")}<span>more</span></div>`;
  return figure("heatmap", "When you work with pi", "active time by local weekday and hour", svg(W, H, parts.join(""), "Active time by weekday and hour") + scale);
}

// ---------------------------------------------------------------------------
// Fact blocks
// ---------------------------------------------------------------------------

function spark(values) {
  const W = 120;
  const H = 26;
  const max = Math.max(...values, 1e-9);
  const step = W / Math.max(values.length, 1);
  const bars = values
    .map((v, i) => {
      const bh = Math.max(v > 0 ? 2 : 0, (v / max) * (H - 2));
      return `<rect x="${i * step + 1}" y="${H - bh}" width="${Math.max(step - 2, 1)}" height="${bh}" rx="1"/>`;
    })
    .join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">${bars}</svg>`;
}

function delta(now, before, fmt) {
  if (before == null || !(before > 0)) return "";
  const pct = Math.round(((now - before) / before) * 100);
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "▶";
  return `<span class="delta" title="previous window: ${esc(fmt(before))}">${arrow} ${Math.abs(pct)}%</span>`;
}

/**
 * The headline numbers as cards, each with a weekly sparkline and, when the
 * facts include a previous window (`piss facts --compare`), the change.
 * `outcomes` (from `piss outcomes --json`) adds merged MRs and closed tickets.
 */
export function kpis(facts, { outcomes } = {}) {
  const o = facts.overview;
  const p = facts.previous?.overview;
  const weeks = facts.weeks ?? [];
  const card = (tone, label, value, sub, sparkValues, d = "") =>
    `<div class="kpi ${tone}"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div>` +
    `<div class="kpi-sub">${sub} ${d}</div>${sparkValues ? spark(sparkValues) : ""}</div>`;
  const cards = [
    card("t-sessions", "sessions active", int(o.sessions), `${int(o.sessions_started)} started`, weeks.map((w) => w.sessions), delta(o.sessions, p?.sessions, int)),
    card("t-you", "your time", hours(o.user_s), "typing, reading, deciding", weeks.map((w) => w.user_s), delta(o.user_s, p?.user_s, hours)),
    card("t-agent", "agent time", hours(o.agent_s), "turns and tool runs", weeks.map((w) => w.agent_s), delta(o.agent_s, p?.agent_s, hours)),
    card("t-spend", "spend", usd(o.cost.total), `${usd(o.cost.reviews)} on reviewers`, weeks.map((w) => w.cost), delta(o.cost.total, p?.cost?.total, money)),
    card("t-prompts", "prompts", int(o.prompts), `${int(o.template_prompts)} via templates`, weeks.map((w) => w.prompts), delta(o.prompts, p?.prompts, int)),
  ];
  if (outcomes) {
    const oc = outcomeCounts(outcomes);
    const unchecked = (n) => (n ? ` (${plural(n, "repo")} not checked)` : "");
    const sub = [
      oc.mrs_repos_not_checked ? `MRs${unchecked(oc.mrs_repos_not_checked)}` : null,
      oc.commits_landed == null
        ? "commits not checked"
        : `${plural(oc.commits_landed, "commit")} landed${unchecked(oc.commit_repos_not_checked)}`,
      oc.tickets_closed_by_you == null ? null : `${plural(oc.tickets_closed_by_you, "ticket")} closed`,
    ]
      .filter(Boolean)
      .join(", ");
    cards.push(card("t-outcomes", "MRs merged", oc.mrs_merged == null ? "n/a" : int(oc.mrs_merged), sub, null));
  }
  return `<div class="kpis" style="--n:${cards.length}">${cards.join("")}</div>`;
}

/** The hero's first line: window, sessions and repos. */
export function kicker(facts) {
  const since = new Date(facts.window.since);
  const until = new Date(new Date(facts.window.until).getTime() - 1);
  const fmt = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return (
    `<span>pi field notes</span><span>${fmt(since)} to ${fmt(until)} ${until.getFullYear()}</span>` +
    `<span>${int(facts.overview.sessions)} sessions</span><span>${int(facts.overview.repos)} repos</span>`
  );
}

// An earlier report's wording is quoted as written: a [[S...]] marker in it
// named a session of that report's corpus, so it stays text, not a chip.
const quoted = (text) => esc(text).replaceAll("[[", "&#91;&#91;");

function carryCard(c) {
  // Sessions already cited in the text are not listed again under it.
  const inline = new Set(
    [c.evidence, c.effect].flatMap((t) => (typeof t === "string" ? [...t.matchAll(/\[\[(S[^\]\n]+)\]\]/g)].map((m) => m[1]) : [])),
  );
  const refs = (c.refs ?? []).filter((r) => !inline.has(r)).map((r) => `[[${r}]]`).join(" ");
  return (
    `<article class="carry" id="${carriedAnchor(c.id)}" data-outcome="${esc(c.outcome)}">` +
    `<p class="carry-head"><span class="carry-from">${KIND_LABEL[c.kind] ?? "recommendation"}</span>` +
    `<span class="carry-outcome">${esc(OUTCOMES[c.outcome] ?? c.outcome)}</span></p>` +
    `<h3>${quoted(c.title)}</h3><p class="carry-original">${quoted(c.summary)}</p>` +
    `<p class="carry-what">${esc(c.evidence)}</p>` +
    (c.effect ? `<p class="carry-effect">${esc(c.effect)}</p>` : "") +
    (refs ? `<p class="evidence">${refs}</p>` : "") +
    "</article>"
  );
}

/**
 * "Since the last report": each followed-up recommendation with the earlier
 * report's own title and summary, quoted from its sidecar so the wording
 * cannot drift, then what happened to it. Cards are grouped by report, newest
 * first, under a count ("6 Oct report, 2 of 16"), so an older report's items
 * read as a deliberate selection. `carried` comes from publish.mjs's
 * resolveCarried.
 */
export function carried(facts, { carried: items = [] } = {}) {
  if (!items.length) return '<p class="carried-empty">No earlier report recorded its recommendations, so there is nothing to follow up yet.</p>';
  const groups = new Map();
  for (const c of items) groups.set(c.key, [...(groups.get(c.key) ?? []), c]);
  return [...groups.values()]
    .sort((a, b) => b[0].key.localeCompare(a[0].key))
    .map((group) => {
      const { key, total } = group[0];
      const count = total ? `${group.length} of ${total} recommendations` : `${group.length} recommendations`;
      return (
        `<div class="carried-set"><p class="carried-from"><span>${esc(reportLabel(key))} report</span><span>${count}</span></p>` +
        `<div class="carried">${group.map(carryCard).join("")}</div></div>`
      );
    })
    .join("");
}

export const CHARTS = { daily, weekly, models, repos, heatmap, kpis, carried, kicker };

// ---------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------

/**
 * A topographic contour map unique to each report, seeded by its date: a few
 * peaks, iso-lines of their summed height. Decorative only (aria-hidden).
 */
export function contours(seed, { width = 1200, height = 520, levels = 14 } = {}) {
  let s = [...String(seed)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 2166136261);
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const peaks = Array.from({ length: 7 }, (_, i) => ({
    x: width * (0.3 + rand() * 0.75),
    y: height * (rand() * 1.1 - 0.1),
    r: i < 3 ? 160 + rand() * 180 : 60 + rand() * 90,
    a: i < 3 ? 0.7 + rand() * 0.5 : 0.25 + rand() * 0.3,
  }));
  // Low-frequency waves bend the rings into ridges and valleys; without them
  // the iso-lines are concentric circles.
  const waves = Array.from({ length: 5 }, () => ({
    fx: (0.6 + rand() * 1.6) / 300,
    fy: (0.6 + rand() * 1.6) / 300,
    px: rand() * Math.PI * 2,
    py: rand() * Math.PI * 2,
    a: 0.08 + rand() * 0.1,
  }));
  const field = (x, y) =>
    peaks.reduce((sum, p) => sum + p.a * Math.exp(-(((x - p.x) ** 2 + (y - p.y) ** 2) / (2 * p.r * p.r))), 0) +
    waves.reduce((sum, w) => sum + w.a * Math.sin(x * w.fx + w.px) * Math.sin(y * w.fy + w.py), 0);
  const step = 14;
  const cols = Math.ceil(width / step) + 1;
  const rows = Math.ceil(height / step) + 1;
  const grid = Array.from({ length: rows }, (_, j) => Array.from({ length: cols }, (_, i) => field(i * step, j * step)));
  const flat = grid.flat();
  const max = Math.max(...flat);
  const min = Math.min(...flat);
  const segs = [];
  for (let l = 1; l <= levels; l++) {
    const iso = min + ((max - min) * l) / (levels + 1);
    const d = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        // Marching squares on one cell: corners tl, tr, br, bl.
        const v = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
        const code = v.reduce((c, val, k) => c | ((val > iso ? 1 : 0) << k), 0);
        if (code === 0 || code === 15) continue;
        const x = i * step;
        const y = j * step;
        const lerp = (a, b) => (iso - a) / (b - a);
        const edge = [
          [x + step * lerp(v[0], v[1]), y],
          [x + step, y + step * lerp(v[1], v[2])],
          [x + step * lerp(v[3], v[2]), y + step],
          [x, y + step * lerp(v[0], v[3])],
        ];
        const pairs = {
          1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]], 7: [[3, 2]],
          8: [[2, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]],
        }[code];
        for (const [a, b] of pairs) d.push(`M${edge[a][0].toFixed(1)} ${edge[a][1].toFixed(1)}L${edge[b][0].toFixed(1)} ${edge[b][1].toFixed(1)}`);
      }
    }
    segs.push(`<path class="${l % 5 === 0 ? "index" : ""}" d="${d.join("")}"/>`);
  }
  return `<svg class="topo" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${segs.join("")}</svg>`;
}
