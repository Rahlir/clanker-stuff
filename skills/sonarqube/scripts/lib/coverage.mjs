// Coverage gaps: per-project and per-file measures from the public measures
// API, exact lines from api/sources/lines. That endpoint is internal (it
// backs the Sonar UI), so lineCoverage degrades to null instead of failing.

import { SonarError } from "./client.mjs";
import { decodeEntities } from "./rules.mjs";

// "New code" is what quality gates judge; "overall" is the whole branch.
export const NEW_CODE = {
  overall: false,
  coverage: "new_coverage",
  lines: "new_lines_to_cover",
  uncoveredLines: "new_uncovered_lines",
  conditions: "new_conditions_to_cover",
  uncoveredConditions: "new_uncovered_conditions",
};
export const OVERALL = {
  overall: true,
  coverage: "coverage",
  lines: "lines_to_cover",
  uncoveredLines: "uncovered_lines",
  conditions: "conditions_to_cover",
  uncoveredConditions: "uncovered_conditions",
};

const metricKeys = (m) => [m.coverage, m.lines, m.uncoveredLines, m.conditions, m.uncoveredConditions].join(",");
const PAGE = 500;
// Sonar stops paging at 10,000 results; past that, report truncation rather
// than claim complete counts.
const MAX_SCANNED = 10_000;

// New-code values sit under `period`, overall ones under `value`. Missing
// metrics stay null: Sonar omits new-code measures when there is no new code.
function readMeasures(measures, m) {
  const byMetric = new Map((measures ?? []).map((x) => [x.metric, x.period?.value ?? x.value]));
  const num = (k) => (byMetric.has(k) && byMetric.get(k) != null ? Number(byMetric.get(k)) : null);
  return {
    coverage: num(m.coverage),
    lines: num(m.lines),
    uncoveredLines: num(m.uncoveredLines),
    conditions: num(m.conditions),
    uncoveredConditions: num(m.uncoveredConditions),
  };
}

export async function projectCoverage(client, projectKey, scopeParams, m) {
  const res = await client.get("/api/measures/component", { component: projectKey, metricKeys: metricKeys(m), ...scopeParams });
  // Missing measures legitimately mean "no new code", so only a missing
  // component (a broken answer) must fail rather than read as clean.
  if (!Array.isArray(res?.component?.measures))
    throw new SonarError(`${client.instance.name}: api/measures/component returned an unexpected response for ${projectKey}`);
  return readMeasures(res.component.measures, m);
}

// Files with uncovered lines or conditions, most uncovered lines first, as
// { gaps, scanned, total, truncated }. Every file is scanned because Sonar's
// server-side sort by these metrics is not reliable on every edition.
// `totalLines` (physical lines) lets lineCoverage tell a complete answer.
export async function fileGaps(client, projectKey, scopeParams, m) {
  const files = [];
  let total = 0;
  for (let p = 1; ; p++) {
    const res = await client.get("/api/measures/component_tree", {
      component: projectKey,
      qualifiers: "FIL",
      metricKeys: `${metricKeys(m)},lines`,
      ps: PAGE,
      p,
      ...scopeParams,
    });
    if (!Array.isArray(res?.components))
      throw new SonarError(`${client.instance.name}: api/measures/component_tree returned an unexpected response`);
    total = res.paging?.total ?? files.length + res.components.length;
    for (const c of res.components) {
      const physical = c.measures?.find((x) => x.metric === "lines")?.value;
      files.push({ key: c.key, sonarPath: c.path, totalLines: physical == null ? null : Number(physical), ...readMeasures(c.measures, m) });
    }
    if (res.components.length === 0 || files.length >= total || files.length >= MAX_SCANNED) break;
  }
  const gaps = files
    .filter((f) => (f.uncoveredLines ?? 0) + (f.uncoveredConditions ?? 0) > 0)
    .sort((a, b) => (b.uncoveredLines ?? 0) - (a.uncoveredLines ?? 0) || (b.uncoveredConditions ?? 0) - (a.uncoveredConditions ?? 0));
  return { gaps, scanned: files.length, total, truncated: files.length < total };
}

// Exact gaps in one file, as analyzed: { uncovered: [{ line, code }],
// partial: [{ line, covered, total, code }] }. `newOnly` keeps lines Sonar
// counts as new code. Returns null when the internal endpoint is unavailable
// or answers in an unexpected shape.
export async function lineCoverage(client, fileKey, scopeParams, { newOnly, totalLines = null }) {
  const sources = [];
  // Sonar returns the whole file in one answer today; follow-up ranges only
  // guard against a server-side window cutting long files short.
  for (let from = 1, round = 0; round < 50; round++) {
    const res = await client.get("/api/sources/lines", { key: fileKey, from, ...scopeParams }, { optional: true });
    if (!Array.isArray(res?.sources)) return null;
    // Lines before `from` would be repeats from a server that ignored it.
    const fresh = res.sources.filter((s) => typeof s.line === "number" && s.line >= from);
    sources.push(...fresh);
    const last = fresh.at(-1)?.line ?? 0;
    if (!totalLines || last >= totalLines) break;
    // Stopped short of the file's end (verified live: a complete answer ends
    // exactly at the `lines` metric): partial detail must not pass as exact.
    if (fresh.length === 0 || round === 49) return null;
    from = last + 1;
  }
  const uncovered = [];
  const partial = [];
  for (const s of sources) {
    if (typeof s.line !== "number" || s.lineHits === undefined || (newOnly && !s.isNew)) continue;
    const code = decodeEntities(String(s.code ?? "").replace(/<[^>]+>/g, ""));
    if (s.lineHits === 0) uncovered.push({ line: s.line, code });
    else if ((s.conditions ?? 0) > (s.coveredConditions ?? 0))
      partial.push({ line: s.line, covered: s.coveredConditions ?? 0, total: s.conditions, code });
  }
  return { uncovered, partial };
}

// [33, 34, 67, 71, 72] -> "33-34, 67, 71-72"
export function toRanges(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return out.join(", ");
}
