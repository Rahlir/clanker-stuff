// Which analysis a command looks at: an MR (Sonar "pull request"), a branch,
// or main. One scope applies to every project of a repo, because an MR is
// analyzed under the same PR key in each project it touches.

import { SonarError } from "./client.mjs";

export async function loadAnalyses(client, project) {
  const [branches, prs] = await Promise.all([
    client.get("/api/project_branches/list", { project: project.key }),
    // Optional: instances without branch support reject this endpoint.
    client.get("/api/project_pull_requests/list", { project: project.key }, { optional: true }),
  ]);
  // Without the branch list, "main" cannot be found and every scope would
  // silently come out empty.
  if (!Array.isArray(branches?.branches))
    throw new SonarError(`${client.instance.name}: api/project_branches/list returned an unexpected response for ${project.key}`);
  // null means the instance has no MR support; any other answer must carry
  // the list, or a malformed one would quietly switch the scope to main.
  if (prs !== null && !Array.isArray(prs?.pullRequests))
    throw new SonarError(`${client.instance.name}: api/project_pull_requests/list returned an unexpected response for ${project.key}`);
  return { project, branches: branches.branches, prs: prs?.pullRequests ?? [], mrSupport: prs !== null };
}

// Sonar writes offsets without a colon (+0000), which strict ISO parsing rejects.
export function parseSonarDate(s) {
  return s ? new Date(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : null;
}

const newest = (items) =>
  items.reduce((a, b) => ((parseSonarDate(b.analysisDate) ?? 0) > (parseSonarDate(a?.analysisDate) ?? 0) ? b : a), null);

function mainTarget({ project, branches }) {
  const main = branches.find((b) => b.isMain);
  if (!main?.analysisDate) return { project, skip: "main branch never analyzed" };
  // No branch param: Sonar defaults to the main branch.
  return { project, params: {}, gate: main.status?.qualityGateStatus ?? null, analysisDate: main.analysisDate };
}

function prTarget({ project, prs }, key) {
  const pr = prs.find((p) => p.key === key);
  if (!pr) return { project, skip: `no analysis for MR !${key}` };
  return {
    project,
    params: { pullRequest: key },
    gate: pr.status?.qualityGateStatus ?? null,
    analysisDate: pr.analysisDate,
    branch: pr.branch,
    target: pr.target ?? pr.base,
  };
}

function branchTarget({ project, branches }, name) {
  const b = branches.find((x) => x.name === name && !x.isMain);
  if (!b) return { project, skip: `no analysis for branch ${name}` };
  return { project, params: { branch: name }, gate: b.status?.qualityGateStatus ?? null, analysisDate: b.analysisDate };
}

function build(kind, key, analyses, pick, extra = {}) {
  const all = analyses.map((a) => pick(a, key));
  const targets = all.filter((t) => !t.skip);
  const skipped = all.filter((t) => t.skip).map((t) => ({ project: t.project, reason: t.skip }));
  const branch = targets.find((t) => t.branch)?.branch;
  const label = kind === "mr" ? `MR !${key}${branch ? ` (${branch})` : ""}` : kind === "branch" ? `branch ${key}` : "main";
  return { kind, key, label, targets, skipped, auto: false, reason: null, ...extra };
}

function noTargets(what, hint) {
  return new Error(`${what} has no analysis in any selected project.${hint ? ` ${hint}` : ""}`);
}

// Resolves the scope from explicit flags, else from the branches at HEAD:
// an MR analysis wins over a branch analysis of the same name (MR scope is
// what the gate judges), which wins over main. `head` is { names, detached }.
export function decideScope(analyses, { mr, branch, main, head }) {
  if (main) return build("main", null, analyses, mainTarget);

  if (mr !== undefined) {
    const key = String(mr).replace(/^!/, "");
    const scope = build("mr", key, analyses, prTarget);
    if (scope.targets.length === 0) {
      const seen = new Set();
      const recent = newestFirst(analyses.flatMap((a) => a.prs))
        .filter((p) => !seen.has(p.key) && seen.add(p.key))
        .slice(0, 5);
      throw noTargets(`MR !${key}`, recent.length ? `Recently analyzed: ${recent.map((p) => `!${p.key} (${p.branch})`).join(", ")}` : "");
    }
    return scope;
  }

  if (branch !== undefined) {
    if (analyses.some((a) => a.branches.some((b) => b.isMain && b.name === branch)))
      return build("main", null, analyses, mainTarget);
    const scope = build("branch", branch, analyses, branchTarget);
    if (scope.targets.length === 0) throw noTargets(`Branch ${branch}`);
    return scope;
  }

  const names = new Set(head?.names ?? []);
  const where = head?.detached ? `detached HEAD at ${[...names].join(", ")}` : `current branch ${[...names][0]}`;
  if (names.size === 0) {
    const reason = head?.detached ? "detached HEAD matches no branch" : "not inside this repo's checkout";
    return { ...build("main", null, analyses, mainTarget), auto: true, reason };
  }
  const pr = newest(analyses.flatMap((a) => a.prs.filter((p) => names.has(p.branch))));
  // A detached HEAD can sit on main and on an MR branch at once (an MR with
  // no commits yet); main wins, but the alternative is named.
  if (analyses.some((a) => a.branches.some((b) => b.isMain && names.has(b.name)))) {
    const also = pr ? `; HEAD is also MR !${pr.key}'s branch, pass --mr ${pr.key} for that` : "";
    return { ...build("main", null, analyses, mainTarget), auto: true, reason: `${where}${also}` };
  }

  if (pr) return { ...build("mr", pr.key, analyses, prTarget), auto: true, reason: where };

  const br = newest(analyses.flatMap((a) => a.branches.filter((b) => !b.isMain && names.has(b.name))));
  if (br) return { ...build("branch", br.name, analyses, branchTarget), auto: true, reason: `${where}, which has no MR analysis` };

  return { ...build("main", null, analyses, mainTarget), auto: true, reason: `${where} has no MR or branch analysis` };
}

function newestFirst(items) {
  return [...items].sort((a, b) => (parseSonarDate(b.analysisDate) ?? 0) - (parseSonarDate(a.analysisDate) ?? 0));
}
