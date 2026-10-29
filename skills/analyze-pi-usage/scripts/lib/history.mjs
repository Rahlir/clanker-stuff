// Reading earlier usage reports: their sidecar JSON when present, else a text
// excerpt of the HTML. Pure apart from what the CLI passes in.

import { htmlToText } from "./publish.mjs";

const NAME = /^pi-session-report(?:-(\d{4}-\d{2}-\d{2}))?(?:-(.+?))?\.html$/;

/**
 * What earlier recommendations are qualified with: the file name between
 * "pi-session-report-" and ".html" (2026-10-13, 2026-10-06-opus5), so two
 * reports from one day keep distinct ids. Undated names have none.
 */
export function reportKey(name) {
  const m = NAME.exec(name);
  return m?.[1] ? name.slice("pi-session-report-".length, -".html".length) : null;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** The local calendar day, YYYY-MM-DD: the default report date. */
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * Reports a report dated `date` may build on: those from earlier days, plus
 * undated old ones. A report from the same day is the one being replaced,
 * not an earlier one, so render.mjs and history.mjs both leave it out.
 */
export function beforeDate(reports, date) {
  const earlier = reports.filter((r) => !r.date || r.date < date);
  return { earlier, hidden: reports.filter((r) => !earlier.includes(r)) };
}

/** Report files, newest first; undated names sort last. */
export function listReports(names) {
  return names
    .map((name) => {
      const m = NAME.exec(name);
      return m ? { name, key: reportKey(name), date: m[1] ?? null, variant: m[2] ?? null } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.name.localeCompare(b.name));
}

/**
 * Earlier reports that have a sidecar, read through the given functions so
 * tests can pass a fake directory. An unreadable sidecar is a problem to
 * report, not a reason to stop: its ids simply do not resolve.
 */
export function loadHistory(names, readSidecar) {
  const entries = [];
  const problems = [];
  for (const r of listReports(names)) {
    if (!r.key) continue;
    let sidecar;
    try {
      sidecar = readSidecar(r.name.replace(/\.html$/, ".json"));
    } catch (err) {
      problems.push(`${r.name}: sidecar unreadable (${err.message})`);
      continue;
    }
    if (sidecar === undefined) continue;
    if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) {
      problems.push(`${r.name}: sidecar is not a JSON object`);
      continue;
    }
    entries.push({ ...r, sidecar });
  }
  return { entries, problems };
}

/** Every earlier recommendation, by its qualified id "2026-10-13#some-id". */
export function historyIndex(entries) {
  const index = new Map();
  for (const e of entries) {
    const recs = Array.isArray(e.sidecar.recommendations) ? e.sidecar.recommendations : [];
    for (const r of recs) {
      if (!r?.id) continue;
      index.set(`${e.key}#${r.id}`, {
        id: `${e.key}#${r.id}`,
        key: e.key,
        date: e.date,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        total: recs.length,
        backfilled: Boolean(e.sidecar.backfilled),
      });
    }
  }
  return index;
}

/**
 * The line history.mjs prints for a report it leaves out. It says enough to
 * ask the user about replacing it (when it was written, by which model), so
 * the agent has no reason to open the report and read its findings.
 */
export function leftOutLine(name, { sidecar, writtenAt, replaced = false } = {}) {
  const g = sidecar?.generator ?? {};
  const model = [g.provider, g.model].filter(Boolean).join("/");
  const details = [
    writtenAt ? `written ${writtenAt}` : null,
    model ? `by ${model}${g.thinking ? ` (${g.thinking})` : ""}` : null,
  ].filter(Boolean);
  return (
    `left out ${name}${details.length ? ` (${details.join(" ")})` : ""}: not an earlier report. ` +
    (replaced ? "Publishing this run replaces it: ask the user now, and do not open it." : "Do not open it.")
  );
}

/**
 * The name of the newest earlier report when no report of its day has a
 * sidecar, else null. Coverage would otherwise be checked against an older
 * report without a word. `reports` comes from listReports (newest first).
 */
export function latestWithoutSidecar(reports, entries) {
  const newest = reports.find((r) => r.date);
  if (!newest || entries.some((e) => e.date === newest.date)) return null;
  return newest.name;
}

/** The latest report dated before `date`, preferring the plain name over a same-day variant. */
export function latestBefore(entries, date) {
  return (
    entries
      .filter((e) => e.date && e.date < date)
      .sort((a, b) => b.date.localeCompare(a.date) || Number(Boolean(a.variant)) - Number(Boolean(b.variant)))[0] ?? null
  );
}

/** A sidecar as a few lines: who made it, the verdict, every recommendation with its id, and what it followed up. */
export function sidecarSummary(sc, key = sc.date) {
  const g = sc.generator ?? {};
  const lines = [
    `generated by ${[g.provider, g.model].filter(Boolean).join("/") || "unknown"}${g.thinking ? ` (${g.thinking})` : ""}; ` +
      `window ${String(sc.window?.since ?? "?").slice(0, 10)} to ${String(sc.window?.until ?? "?").slice(0, 10)}` +
      (sc.backfilled ? "; backfilled from the HTML" : ""),
    `verdict: ${sc.verdict ?? "-"}`,
  ];
  for (const r of Array.isArray(sc.recommendations) ? sc.recommendations : []) {
    const from = r?.previous ? `, from ${r.previous}` : "";
    lines.push(`${String(r?.kind ?? "?").padEnd(5)} ${key}#${r?.id} [${r?.status}${from}] ${r?.title}: ${r?.summary}`);
  }
  for (const c of Array.isArray(sc.carried) ? sc.carried : []) {
    lines.push(`followed up ${c?.ref}: ${c?.outcome}`);
  }
  if (Array.isArray(sc.community) && sc.community.length) {
    lines.push(`community: ${sc.community.map((c) => `${c?.ring} ${c?.name}`).join(", ")}`);
  }
  return lines;
}

const RECOMMENDATION_HEADING = /quick|win|big|go big|horizon|community|recommend|next|enhanc/i;

/**
 * What an HTML-only report recommended: its heading outline, then the text of
 * sections whose heading looks like recommendations, each cut at `cap`.
 */
export function htmlExcerpt(html, { cap = 2500 } = {}) {
  const headings = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    level: Number(m[1]),
    text: htmlToText(m[2]).replace(/\s+/g, " "),
    index: m.index,
    end: m.index + m[0].length,
  }));
  const lines = [`outline: ${headings.filter((h) => h.level <= 2).map((h) => h.text).join(" | ").slice(0, 900)}`];
  const tops = headings.filter((h) => h.level === 2);
  tops.forEach((h, i) => {
    if (!RECOMMENDATION_HEADING.test(h.text)) return;
    const text = htmlToText(html.slice(h.end, tops[i + 1]?.index ?? html.length));
    lines.push(`-- ${h.text}`, text.length > cap ? `${text.slice(0, cap)} … (+${text.length - cap} chars)` : text);
  });
  return lines;
}
