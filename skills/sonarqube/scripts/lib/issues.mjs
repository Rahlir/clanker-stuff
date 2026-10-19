// Issue search and facet counts over api/issues/search.

import { SonarError } from "./client.mjs";

export const SEVERITIES = ["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"];
export const QUALITIES = ["MAINTAINABILITY", "RELIABILITY", "SECURITY"];
export const STATUSES = ["OPEN", "CONFIRMED", "ACCEPTED", "FALSE_POSITIVE", "FIXED"];
export const DEFAULT_STATUSES = ["OPEN", "CONFIRMED"];

// Sonar refuses to page past 10,000 results.
const MAX_WINDOW = 10_000;

// An answer without an issues list or a total must not read as "no issues".
// Returns the total.
function expectShape(res, client) {
  const total = res?.paging?.total ?? res?.total;
  if (!Array.isArray(res?.issues) || typeof total !== "number")
    throw new SonarError(`${client.instance.name}: api/issues/search returned an unexpected response (no issues list or total)`);
  // Servers before 10.4 ignore the issueStatuses filter and omit the field,
  // so closed issues would be listed as open.
  if (res.issues.some((i) => i.issueStatus === undefined))
    throw new SonarError(`${client.instance.name}: issues come without an issueStatus field; this skill needs SonarQube Server 10.4 or newer`);
  return total;
}

// `sonarPath` is relative to the project's base dir. It comes from the
// response's components[] rather than from splitting the component key,
// because project keys may themselves contain ":" (`team:service-a`).
function normalizeIssue(i, paths) {
  const keyPrefix = `${i.project}:`;
  const pathOf = (component) =>
    paths.get(component) ?? (component?.startsWith(keyPrefix) ? component.slice(keyPrefix.length) : null);
  return {
    key: i.key,
    project: i.project,
    component: i.component,
    // Which analysis the issue belongs to; both null means main.
    branch: i.branch ?? null,
    pullRequest: i.pullRequest ?? null,
    rule: i.rule,
    sonarPath: pathOf(i.component),
    line: i.line ?? null,
    textRange: i.textRange ?? null,
    hash: i.hash ?? null,
    message: i.message,
    impacts: i.impacts ?? [],
    status: i.issueStatus,
    type: i.type,
    tags: i.tags ?? [],
    effort: i.effort ?? null,
    // Secondary locations, e.g. each complexity increment of S3776. A
    // location may sit in another file than the issue.
    flows: (i.flows ?? []).map((f) => ({
      type: f.type ?? null,
      description: f.description ?? null,
      locations: (f.locations ?? []).map((l) => ({
        component: l.component,
        sonarPath: pathOf(l.component),
        textRange: l.textRange ?? null,
        msg: l.msg ?? "",
      })),
    })),
    creationDate: i.creationDate,
    author: i.author ?? null,
    // Present only with additionalFields (transitions, actions, comments).
    transitions: i.transitions ?? null,
    actions: i.actions ?? null,
    comments: i.comments ?? null,
    ruleDescriptionContextKey: i.ruleDescriptionContextKey ?? null,
  };
}

export async function searchIssues(client, params, { limit = 100 } = {}) {
  const ps = Math.min(500, Math.max(1, limit));
  const paths = new Map();
  const raw = [];
  let total = 0;
  let effortTotal = 0;
  for (let p = 1; ; p++) {
    const res = await client.get("/api/issues/search", { ...params, ps, p });
    total = expectShape(res, client);
    effortTotal = res.effortTotal ?? 0;
    for (const c of res.components ?? []) if (c.path) paths.set(c.key, c.path);
    const page = res.issues ?? [];
    raw.push(...page);
    if (page.length === 0 || raw.length >= Math.min(total, limit) || p * ps >= MAX_WINDOW) break;
  }
  return { total, effortTotal, issues: raw.slice(0, limit).map((i) => normalizeIssue(i, paths)) };
}

// Exact counts without downloading issues. Facet values are { val, count }.
export async function issueFacets(client, params, facets) {
  const res = await client.get("/api/issues/search", { ...params, ps: 1, facets });
  const total = expectShape(res, client);
  const out = {};
  for (const f of res.facets ?? []) if (Array.isArray(f.values)) out[f.property] = f.values.filter((v) => v.count > 0);
  const missing = facets.split(",").filter((f) => !out[f]);
  if (missing.length)
    throw new SonarError(`${client.instance.name}: api/issues/search did not return the requested facets: ${missing.join(", ")}`);
  return { total, effortTotal: res.effortTotal ?? 0, facets: out };
}

// Highest severity first; ties keep Sonar's order.
export function sortImpacts(impacts) {
  return [...impacts].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}
