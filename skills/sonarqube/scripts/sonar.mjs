#!/usr/bin/env node
// sonar - SonarQube web API helper for the `sonarqube` pi skill.
//
// Instances and the repo -> project mapping come from a JSON config
// (${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/sonarqube.json, or
// $SONARQUBE_CONFIG). Tokens come only from the env vars the config names.

import { chmod, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { findRepoByRemotes, loadConfig, normalizeRemote } from "./lib/config.mjs";
import { createClient, encodeParams, SonarError } from "./lib/client.mjs";
import { hasUncommittedChanges, headBranches, headCommitDate, remoteUrls, repoRoot } from "./lib/git.mjs";
import {
  DEFAULT_STATUSES,
  issueFacets,
  QUALITIES,
  SEVERITIES,
  STATUSES,
  searchIssues,
  sortImpacts,
} from "./lib/issues.mjs";
import { fileGaps, lineCoverage, NEW_CODE, OVERALL, projectCoverage, toRanges } from "./lib/coverage.mjs";
import { createLocator, excerpt } from "./lib/locate.mjs";
import { commentWriteProblems, isSecurityFinding, resolveTransition, transitionProblems } from "./lib/guard.mjs";
import { fetchRule, ruleContexts, ruleGuidance, selectContexts } from "./lib/rules.mjs";
import { decideScope, loadAnalyses, parseSonarDate } from "./lib/scope.mjs";

const BOOL_FLAGS = new Set(["json", "all", "main", "guidance", "overall", "confirm"]);

// Values accepted after `--flag=`. Anything else is an error rather than
// "truthy", so a typo like `--confirm=flase` can never switch a gate on.
const BOOL_VALUES = {
  "": false,
  true: true,
  false: false,
  yes: true,
  no: false,
  on: true,
  off: false,
  1: true,
  0: false,
};

function help() {
  process.stdout.write(`sonar - SonarQube web API helper

Commands:
  me                 Check the config, and auth/edition/version of each instance
  projects           Mapped projects with main-branch gate and last analysis.
                     Defaults to the current repo; all repos outside one.
  gate               Quality gate per project in scope, failing conditions first
  summary            Issue counts by severity, quality, project, and top rules
  issues             Issues in scope, grouped by file
  plan               Worklist to fix: issues grouped by rule and file, mapped
                     onto local lines, with code and secondary locations.
                     Needs --rule on main (one rule per pass).
  issue KEY|URL      One issue in full; takes a pasted Sonar issue URL
  rule KEY           A rule's full description (all sections, all frameworks)
  coverage           Coverage on new code (what gates measure) per project, then
                     files with gaps: exact uncovered lines and partly covered
                     branches, mapped onto local lines

Writes (dry run unless --confirm; apply only after the user approves):
  comment KEY|URL --text T | --text-file PATH
                     Add a comment to an issue
  transition KEY|URL accept|falsepositive --comment T | --comment-file PATH
                     Comment with the reason, then change the status. Refused
                     for security findings and for transitions Sonar does not
                     offer. Prefer the -file forms for text with backticks or $.

Scope (gate, summary, issues, plan, coverage; default: this branch's MR,
else its branch analysis, else main):
  --mr N             A merge request's analysis
  --branch NAME      A branch analysis
  --main             The main branch
  --repo NAME        A mapped repo other than the one containing cwd (rule too)
  --project A,B      Only these projects (short name or key)

Filters (summary, issues, plan; coverage takes --file and --limit):
  --rule KEY,...     e.g. python:S8415
  --severity S,...   BLOCKER, HIGH, MEDIUM, LOW, INFO
  --quality Q,...    MAINTAINABILITY, RELIABILITY, SECURITY (prefixes work)
  --status S,...     OPEN, CONFIRMED, ACCEPTED, FALSE_POSITIVE, FIXED, or all
                     (default OPEN,CONFIRMED)
  --file PATH        A file or directory, relative to cwd
  --limit N          issues: max issues (100); plan: max issues (25);
                     summary: top rules shown (15); coverage: files (10)
  --context N        plan/issue: code lines around each issue (1 / 3)
  --guidance=off     plan/issue: leave out the rule guidance
  --framework KEY    rule: only this framework's "how to fix" (e.g. fastapi)
  --overall          coverage: whole branch instead of new code (not for MRs)
  --confirm          comment/transition: apply the write (default: dry run)

Other flags:
  --instance NAME    me, projects: limit to one instance; rule: which instance
  --all              projects: every mapped repo, even inside a mapped repo
  --json             Raw data instead of the human-readable summary

Env:
  SONARQUBE_CONFIG   Config path override
  <tokenEnv>         Each instance's User token, in the env var the config names
`);
}

function die(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

// Flags a command does not take are errors, not ignored: a typo such as
// --severty would otherwise silently drop the filter.
function unknownFlag(cmd, key, allowed) {
  const hint = key === "pr" || key === "pull-request" ? " Use --mr N: Sonar's pull requests are merge requests." : "";
  return `${cmd} does not take --${key}.${hint} Its flags: ${[...allowed].map((f) => `--${f}`).join(" ")}`;
}

function parseArgs(argv, cmd, allowed) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (!allowed.has(key)) die(unknownFlag(cmd, key, allowed));
    if (BOOL_FLAGS.has(key)) {
      const raw = eq > 0 ? a.slice(eq + 1).trim().toLowerCase() : "true";
      if (!Object.hasOwn(BOOL_VALUES, raw))
        die(`--${key} takes no value, or one of: ${Object.keys(BOOL_VALUES).filter(Boolean).join(", ")}`);
      flags[key] = BOOL_VALUES[raw];
    } else if (eq > 0) {
      flags[key] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[key] = argv[++i];
    } else {
      die(`--${key} needs a value`);
    }
  }
  return { positional, flags };
}

// ---- context ----------------------------------------------------------------

function selectInstances(config, flags) {
  if (!flags.instance) return [...config.instances.values()];
  const inst = config.instances.get(flags.instance);
  if (!inst) die(`unknown instance "${flags.instance}". Configured: ${[...config.instances.keys()].join(", ")}`);
  return [inst];
}

// The repo containing cwd, matched by any of its remotes so worktrees and
// detached checkouts resolve like the main clone. `repo` is null when the
// checkout is not in the config; `root` is null outside git entirely.
async function currentRepo(config, cwd = process.cwd()) {
  const root = await repoRoot(cwd);
  if (!root) return { root: null, remotes: [], repo: null };
  const remotes = await remoteUrls(root);
  return { root, remotes, repo: findRepoByRemotes(config, remotes) };
}

// Best-effort hint for an unmapped repo: server projects whose name or key
// contains the repo name or its first word. Lookup failures are ignored, the
// error message stands on its own.
async function suggestProjects(config, remotes) {
  const remote = remotes.map(normalizeRemote).find(Boolean);
  const name = remote?.split("/").pop() ?? "";
  const terms = [...new Set([name, name.split(/[-_.]/)[0]])].filter((t) => t.length >= 3);
  const hits = [];
  await Promise.all(
    [...config.instances.values()].flatMap((inst) =>
      terms.map(async (q) => {
        try {
          const res = await createClient(inst).get("/api/components/search", {
            qualifiers: "TRK",
            q,
            ps: 20,
          });
          for (const c of res?.components ?? []) hits.push(`${inst.name}  ${c.key}  (${c.name})`);
        } catch {}
      }),
    ),
  );
  return { remote, hits: [...new Set(hits)].sort() };
}

// `alternative`: how this command can still be used without mapping the repo.
async function unmappedRepoError(config, root, remotes, alternative) {
  const { remote, hits } = await suggestProjects(config, remotes);
  const lines = [
    `${root} is not in the sonarqube config.`,
    `  remote: ${remote ?? "(no remote with a host/path)"}`,
    `  config: ${config.source}`,
    `  Add a "repos" entry for that remote (see the skill's references/setup.md),`,
    `  or ${alternative}.`,
  ];
  if (hits.length) lines.push("  Server projects that look related:", ...hits.map((h) => `    ${h}`));
  return lines.join("\n");
}

function filterProjects(repo, wanted) {
  if (!wanted) return repo.projects;
  const names = String(wanted).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !repo.projects.some((p) => p.name === n || p.key === n));
  if (unknown.length)
    throw new Error(
      `unknown project ${unknown.join(", ")} in ${repo.name}. Projects: ${repo.projects.map((p) => p.name).join(", ")}`,
    );
  return repo.projects.filter((p) => names.includes(p.name) || names.includes(p.key));
}

// The mapped repo a command works on: --repo NAME, else the one containing
// cwd. `root` is the local checkout, or null when cwd is not a checkout of
// that repo; then there is no branch to auto-detect and no local files.
async function repoContext(config, flags) {
  const here = await currentRepo(config);
  let { repo, root } = here;
  const names = config.repos.map((r) => r.name).join(", ");
  if (flags.repo) {
    const wanted = String(flags.repo).toLowerCase();
    // Names are remote basenames and need not be unique; a full remote always is.
    const byName = config.repos.filter((r) => r.name === wanted);
    if (byName.length > 1)
      throw new Error(
        `--repo ${flags.repo} is ambiguous: ${byName.map((r) => r.remote).join(", ")}. Pass the full remote instead`,
      );
    const found = byName[0] ?? config.repos.find((r) => r.remote === normalizeRemote(flags.repo));
    if (!found) throw new Error(`unknown repo "${flags.repo}". Configured: ${names}`);
    if (found !== repo) root = null;
    repo = found;
  } else if (!repo) {
    if (root) throw new Error(await unmappedRepoError(config, root, here.remotes, "pass --repo NAME to use a mapped repo"));
    throw new Error(`not inside a mapped repo. Pass --repo NAME (configured: ${names})`);
  }
  return { repo, root, projects: filterProjects(repo, flags.project), client: createClient(repo.instance) };
}

async function scopeContext(config, flags) {
  const explicit = ["mr", "branch", "main"].filter((k) => flags[k] !== undefined && flags[k] !== false);
  if (explicit.length > 1) throw new Error(`pick one of --${explicit.join(", --")}`);
  const ctx = await repoContext(config, flags);
  const [head, analyses] = await Promise.all([
    ctx.root ? headBranches(ctx.root) : { names: [], detached: false },
    Promise.all(ctx.projects.map((p) => loadAnalyses(ctx.client, p))),
  ]);
  const scope = decideScope(analyses, { mr: flags.mr, branch: flags.branch, main: Boolean(flags.main), head });
  return { ...ctx, scope, notes: await freshnessNotes(ctx.root, scope) };
}

// Findings describe the code as analyzed. When the scope was detected from
// this checkout, say so if the checkout has moved on since.
async function freshnessNotes(root, scope) {
  if (!root || !scope.auto || scope.kind === "main") return [];
  const notes = [];
  const analyzed = Math.max(...scope.targets.map((t) => parseSonarDate(t.analysisDate)?.getTime() ?? 0));
  const committed = await headCommitDate(root);
  if (committed && analyzed > 0 && committed.getTime() > analyzed)
    notes.push("HEAD has commits newer than this analysis; findings may be outdated until CI re-analyzes");
  if (await hasUncommittedChanges(root)) notes.push("uncommitted local changes are not part of the analysis");
  return notes;
}

// Accepts exact values or unambiguous prefixes ("maint" -> MAINTAINABILITY).
function upperList(value, allowed, flag) {
  if (value === undefined) return undefined;
  return String(value)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((v) => {
      if (allowed.includes(v)) return v;
      const hits = allowed.filter((a) => a.startsWith(v));
      if (hits.length !== 1) throw new Error(`--${flag} ${v}: expected one of ${allowed.join(", ")}`);
      return hits[0];
    });
}

function issueFilters(flags) {
  const statuses =
    String(flags.status).toLowerCase() === "all"
      ? STATUSES
      : (upperList(flags.status, STATUSES, "status") ?? DEFAULT_STATUSES);
  return {
    issueStatuses: statuses,
    rules: flags.rule,
    impactSeverities: upperList(flags.severity, SEVERITIES, "severity"),
    impactSoftwareQualities: upperList(flags.quality, QUALITIES, "quality"),
  };
}

// --file as a repo-relative path. Relative to cwd inside the checkout,
// already repo-relative when there is no checkout (--repo from elsewhere).
async function repoPath(ctx, file) {
  const abs = ctx.root ? resolve(process.cwd(), String(file)) : null;
  let rel = (abs ? relative(ctx.root, abs) : String(file)).replace(/\\/g, "/");
  rel = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  if (rel === ".") rel = "";
  if (rel.startsWith("..")) throw new Error(`--file ${file} is outside ${ctx.root}`);
  const isDir =
    String(file).endsWith("/") ||
    (abs ? await stat(abs).then((s) => s.isDirectory(), () => false) : false);
  return { rel, isDir };
}

// Maps --file onto per-project Sonar filters. Sonar's `files`/`directories`
// take paths relative to the project's base dir, so the configured prefix is
// stripped. Projects the path cannot belong to are left out of the map; a
// path above a project's prefix selects that whole project.
async function fileFilters(ctx, file) {
  if (file === undefined) return null;
  const { rel, isDir } = await repoPath(ctx, file);
  const kind = isDir ? "directories" : "files";
  const out = new Map();
  for (const p of ctx.projects) {
    if (rel === "" || p.prefix.startsWith(`${rel}/`) || (isDir && p.prefix === rel)) out.set(p.key, {});
    else if (p.prefix === "") out.set(p.key, { [kind]: rel });
    else if (rel.startsWith(`${p.prefix}/`)) out.set(p.key, { [kind]: rel.slice(p.prefix.length + 1) });
  }
  if (out.size === 0) throw new Error(`--file ${file}: no selected project covers ${rel}`);
  return out;
}

// Null when --file excludes the project.
function targetParams(target, filters, fileMap) {
  if (fileMap && !fileMap.has(target.project.key)) return null;
  return { components: target.project.key, ...target.params, ...filters, ...(fileMap?.get(target.project.key) ?? {}) };
}

const localPath = (project, sonarPath) =>
  sonarPath == null ? null : project.prefix ? `${project.prefix}/${sonarPath}` : sonarPath;

function intFlag(value, fallback, flag = "limit", min = 1) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${flag} must be an integer >= ${min}`);
  return n;
}

// Runs fn over items with at most `size` in flight, preserving order.
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

const MAX_LINES = 200;

// Spilled output holds source excerpts and issue comments, so it goes to a
// per-user directory only the owner can read, never a shared world-readable
// one. A directory owned by someone else is refused rather than used.
async function spillDir() {
  const uid = process.getuid?.();
  const dir = join(tmpdir(), `pi-sonarqube-skill-${uid ?? "user"}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await lstat(dir);
  if (!s.isDirectory() || (uid !== undefined && s.uid !== uid))
    throw new Error(`${dir} is not a directory owned by you; remove it and run the command again`);
  if ((s.mode & 0o077) !== 0) await chmod(dir, 0o700);
  await pruneSpills(dir);
  return dir;
}

const SPILL_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// Every spill gets a unique name, so old ones are removed here; best effort.
async function pruneSpills(dir) {
  const cutoff = Date.now() - SPILL_MAX_AGE_MS;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith(".md")) continue;
    const file = join(dir, name);
    const s = await lstat(file).catch(() => null);
    if (s?.isFile() && s.mtimeMs < cutoff) await unlink(file).catch(() => {});
  }
}

// Long output goes to a new private file with only the head printed, so one
// command cannot flood the agent's context.
async function spill(text, name) {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  const head = lines.slice(0, MAX_LINES).join("\n");
  let file;
  try {
    file = join(await spillDir(), `${name.replace(/[^\w.-]+/g, "_")}.md`);
    await writeFile(file, `${text}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    // The command itself succeeded (possibly a write); losing its whole
    // output to a full disk or a foreign directory would read as a failure.
    return `${head}\n... ${lines.length - MAX_LINES} more lines could not be saved (${e.message}); narrow the command or use --json`;
  }
  return `${head}\n... ${lines.length - MAX_LINES} more lines. Full output: ${file} (use read with offset)`;
}

// ---- formatting ----------------------------------------------------------------

// Sonar timestamps look like 2026-10-01T13:21:16+0000; minutes are enough.
const fmtDate = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") : "never");

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd());
}

// Sonar's remediation estimate, in its own convention of 8-hour days.
function fmtEffort(minutes) {
  if (!minutes) return "0min";
  const d = Math.floor(minutes / 480);
  const h = Math.floor((minutes % 480) / 60);
  const m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}min`].filter(Boolean).join(" ");
}

const IMPACT_LEGEND = "impacts are severity/quality: M=maintainability R=reliability S=security";

function impactLabel(impacts) {
  if (!impacts?.length) return "-";
  return sortImpacts(impacts)
    .map((i) => `${i.severity}/${i.softwareQuality[0]}`)
    .join(" ");
}

const statusLabel = (filters) =>
  filters.issueStatuses.join() === DEFAULT_STATUSES.join() ? "open" : filters.issueStatuses.join("/").toLowerCase();

function scopeFlag(scope) {
  if (scope.kind === "mr") return ` --mr ${scope.key}`;
  if (scope.kind === "branch") return ` --branch ${scope.key}`;
  return scope.auto ? "" : " --main";
}

function scopeHeader(ctx) {
  const { scope, repo } = ctx;
  const n = scope.targets.length;
  const lines = [`scope: ${scope.label} on ${repo.instance.name} (${repo.name}), ${n} project${n === 1 ? "" : "s"}`];
  if (scope.auto) lines.push(`  auto: ${scope.reason}${scope.kind === "main" ? "" : "; --main for main"}`);
  for (const s of scope.skipped) lines.push(`  skipped ${s.project.name}: ${s.reason}`);
  for (const note of ctx.notes) lines.push(`  note: ${note}`);
  return lines;
}

function scopeJson(ctx) {
  const { scope, repo } = ctx;
  return {
    kind: scope.kind,
    key: scope.key,
    label: scope.label,
    auto: scope.auto,
    reason: scope.reason,
    repo: repo.name,
    instance: repo.instance.name,
    notes: ctx.notes,
    projects: scope.targets.map((t) => ({
      name: t.project.name,
      key: t.project.key,
      analysisDate: t.analysisDate,
      gate: t.gate,
    })),
    skipped: scope.skipped.map((s) => ({ name: s.project.name, reason: s.reason })),
  };
}

const METRIC_LABELS = {
  new_violations: "new issues",
  new_coverage: "coverage on new code, %",
  new_duplicated_lines_density: "duplicated lines on new code, %",
  new_security_hotspots_reviewed: "security hotspots reviewed, %",
  new_reliability_rating: "reliability rating on new code",
  new_security_rating: "security rating on new code",
  new_maintainability_rating: "maintainability rating on new code",
};

function conditionText(c) {
  const rating = c.metricKey.endsWith("_rating");
  const value = (x) => (x == null ? "-" : rating ? ("ABCDE"[Number(x) - 1] ?? x) : x);
  const ops = rating ? { GT: "worse than", LT: "better than" } : { GT: ">", LT: "<" };
  const label = METRIC_LABELS[c.metricKey];
  return `${c.metricKey} = ${value(c.actualValue)} (fails when ${ops[c.comparator] ?? c.comparator} ${value(c.errorThreshold)})${label ? `, ${label}` : ""}`;
}

// ---- commands ----------------------------------------------------------------

// "Can this instance do MR analysis" decides whether MR scope is available.
// Commercial editions always can; Community Build only with the community
// branch plugin, and listing plugins may be forbidden (-> unknown).
async function branchSupport(client, edition) {
  if (edition && edition !== "community") return "yes";
  const plugins = await client.get("/api/plugins/installed", undefined, { optional: true });
  if (!plugins) return "unknown (cannot list plugins)";
  return plugins.plugins?.some((p) => p.key === "communityBranchPlugin")
    ? "yes (community branch plugin)"
    : "no (Community Build analyzes main only)";
}

async function checkInstance(inst) {
  const client = createClient(inst);
  try {
    const [nav, user] = await Promise.all([
      client.get("/api/navigation/global"),
      client.get("/api/users/current"),
    ]);
    if (!user?.isLoggedIn)
      throw new SonarError(`${inst.name}: the token was not accepted as a login (${inst.tokenEnv})`);
    return {
      instance: inst.name,
      url: inst.url,
      ok: true,
      edition: nav.edition ?? "unknown",
      version: nav.version,
      mrAnalysis: await branchSupport(client, nav.edition),
      belowMinimum: belowMinimum(nav.version),
      user: user.login,
    };
  } catch (e) {
    if (!(e instanceof SonarError)) throw e;
    return { instance: inst.name, url: inst.url, ok: false, error: e.message };
  }
}

// Informational only; the issue guard in issues.mjs is what protects results.
// Before Community Build 24.12 versions used the classic numbering, in which
// 10.4 added the issue status fields this helper needs.
function belowMinimum(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major < 24 && (major < 10 || (major === 10 && minor < 4));
}

async function cmdMe(_args, flags) {
  const config = await loadConfig();
  const results = await Promise.all(selectInstances(config, flags).map(checkInstance));
  const { root, remotes, repo } = await currentRepo(config);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  if (flags.json)
    return JSON.stringify({ config: config.source, instances: results, repo: repo?.remote ?? null }, null, 2);

  const width = Math.max(6, ...results.map((r) => r.instance.length)) + 2;
  const row = (label, text) => `${label.padEnd(width)}${text}`;
  const projectCount = config.repos.reduce((n, r) => n + r.projects.length, 0);
  const lines = [
    row("config", `${config.source}: ${config.instances.size} instances, ${config.repos.length} repos, ${projectCount} projects`),
  ];
  for (const r of results) {
    lines.push(row(r.instance, `${r.ok ? "ok" : "FAIL"}  ${r.url}`));
    lines.push(row("", r.ok ? `${r.edition} ${r.version}, MR analysis: ${r.mrAnalysis}, user: ${r.user}` : r.error));
    if (r.belowMinimum) lines.push(row("", "note: older than SonarQube 10.4; commands that list issues will stop with an error"));
  }
  if (!root) lines.push(row("repo", "(not in a git repo)"));
  else if (!repo)
    lines.push(row("repo", `${root} is not mapped (remote: ${remotes.map(normalizeRemote).find(Boolean) ?? "none"})`));
  else lines.push(row("repo", `${repo.name} -> ${repo.instance.name}, ${repo.projects.length} projects`));
  return lines.join("\n");
}

async function projectStatus(client, project) {
  try {
    const { branches, prs, mrSupport } = await loadAnalyses(client, project);
    const main = branches.find((b) => b.isMain);
    return {
      ...project,
      main: main
        ? { name: main.name, gate: main.status?.qualityGateStatus ?? null, analysisDate: main.analysisDate ?? null }
        : null,
      mrAnalyses: mrSupport ? prs.length : null,
    };
  } catch (e) {
    if (!(e instanceof SonarError)) throw e;
    return { ...project, error: e.status === 404 ? "not found on the server (check the key)" : e.message };
  }
}

async function cmdProjects(_args, flags) {
  const config = await loadConfig();
  let repos;
  if (flags.instance) {
    const [inst] = selectInstances(config, flags);
    repos = config.repos.filter((r) => r.instance === inst);
  } else if (flags.all) {
    repos = config.repos;
  } else {
    const { root, remotes, repo } = await currentRepo(config);
    if (repo) repos = [repo];
    else if (root) throw new Error(await unmappedRepoError(config, root, remotes, "pass --all to list every mapped repo"));
    else repos = config.repos;
  }
  if (repos.length === 0) return "No mapped repos.";

  const results = await Promise.all(
    repos.map(async (repo) => {
      const client = createClient(repo.instance);
      return {
        repo: repo.remote,
        instance: repo.instance.name,
        projects: await Promise.all(repo.projects.map((p) => projectStatus(client, p))),
      };
    }),
  );
  if (flags.json) return JSON.stringify(results, null, 2);

  const out = [];
  for (const r of results) {
    out.push(`${r.repo} on ${r.instance}`);
    const rows = [["  project", "path prefix", "main gate", "analyzed", "MR analyses"]];
    for (const p of r.projects) {
      if (p.error) {
        rows.push([`  ${p.name}`, p.prefix || "(repo root)", "ERROR", p.error, ""]);
        continue;
      }
      rows.push([
        `  ${p.name}`,
        p.prefix || "(repo root)",
        p.main?.gate ?? "none",
        fmtDate(p.main?.analysisDate),
        p.mrAnalyses ?? "?",
      ]);
    }
    out.push(...table(rows), "");
  }
  return out.join("\n").trimEnd();
}

// A malformed answer must not read as "no gate".
function gateStatus(res, client, key) {
  if (typeof res?.projectStatus?.status !== "string")
    throw new SonarError(`${client.instance.name}: api/qualitygates/project_status returned an unexpected response for ${key}`);
  return res.projectStatus.status;
}

async function cmdGate(_args, flags) {
  const ctx = await scopeContext(await loadConfig(), flags);
  const results = await Promise.all(
    ctx.scope.targets.map(async (t) => {
      const res = await ctx.client.get("/api/qualitygates/project_status", { projectKey: t.project.key, ...t.params });
      return {
        project: t.project.name,
        key: t.project.key,
        analysisDate: t.analysisDate,
        status: gateStatus(res, ctx.client, t.project.key),
        conditions: res?.projectStatus?.conditions ?? [],
      };
    }),
  );
  if (flags.json) return JSON.stringify({ scope: scopeJson(ctx), projects: results }, null, 2);

  const out = scopeHeader(ctx);
  out.push("", ...table([["project", "gate", "analyzed"], ...results.map((r) => [r.project, r.status, fmtDate(r.analysisDate)])]));
  for (const r of results.filter((x) => x.status !== "OK")) {
    out.push("", `${r.project}: ${r.status}`);
    const failingFirst = [...r.conditions].sort((a, b) => (a.status === "OK") - (b.status === "OK"));
    for (const c of failingFirst) out.push(`  ${c.status.padEnd(5)} ${conditionText(c)}`);
    if (r.conditions.some((c) => c.status === "ERROR" && c.metricKey === "new_violations"))
      out.push(`  -> list them: sonar.mjs issues --project ${r.project}${scopeFlag(ctx.scope)}`);
    const coverage = r.conditions.find((c) => c.status === "ERROR" && (c.metricKey === "new_coverage" || c.metricKey === "coverage"));
    if (coverage)
      out.push(
        `  -> see uncovered lines: sonar.mjs coverage --project ${r.project}${scopeFlag(ctx.scope)}${coverage.metricKey === "coverage" ? " --overall" : ""}`,
      );
  }
  return out.join("\n");
}

async function cmdSummary(_args, flags) {
  const ctx = await scopeContext(await loadConfig(), flags);
  const filters = issueFilters(flags);
  const fileMap = await fileFilters(ctx, flags.file);
  const limit = intFlag(flags.limit, 15);
  const per = (
    await Promise.all(
      ctx.scope.targets.map(async (t) => {
        const params = targetParams(t, filters, fileMap);
        if (!params) return null;
        const res = await issueFacets(ctx.client, params, "rules,impactSeverities,impactSoftwareQualities");
        return { project: t.project, ...res };
      }),
    )
  ).filter(Boolean);

  // Sonar computes each facet as if its own filter were absent (so a UI can
  // offer the other values), hence the explicit `only` for filtered facets.
  const sum = (facet, only) => {
    const m = new Map();
    for (const p of per)
      for (const v of p.facets[facet] ?? [])
        if (!only || only.includes(v.val)) m.set(v.val, (m.get(v.val) ?? 0) + v.count);
    return m;
  };
  const bySeverity = sum("impactSeverities", filters.impactSeverities);
  const byQuality = sum("impactSoftwareQualities", filters.impactSoftwareQualities);
  const ruleFilter = filters.rules?.split(",").map((r) => r.trim());
  const allRules = [...sum("rules", ruleFilter)].sort((a, b) => b[1] - a[1]);
  const top = allRules.slice(0, limit);
  const infos = await Promise.all(top.map(([key]) => fetchRule(ctx.client, key).catch(() => null)));
  const rules = top.map(([key, count], i) => ({
    key,
    count,
    name: infos[i]?.name ?? null,
    impacts: infos[i]?.impacts ?? [],
    projects: per.filter((p) => p.facets.rules?.some((v) => v.val === key)).map((p) => p.project.name),
  }));
  const total = per.reduce((n, p) => n + p.total, 0);
  const effort = per.reduce((n, p) => n + p.effortTotal, 0);
  const byProject = per
    .map((p) => ({ project: p.project.name, total: p.total, effortMinutes: p.effortTotal }))
    .sort((a, b) => b.total - a.total);

  if (flags.json)
    return JSON.stringify(
      {
        scope: scopeJson(ctx),
        statuses: filters.issueStatuses,
        total,
        effortMinutes: effort,
        bySeverity: Object.fromEntries(bySeverity),
        byQuality: Object.fromEntries(byQuality),
        byProject,
        rules,
        rulesTotal: allRules.length,
      },
      null,
      2,
    );

  const ordered = (m, order) => order.filter((k) => m.has(k)).map((k) => `${k} ${m.get(k)}`).join(", ") || "none";
  const out = scopeHeader(ctx);
  out.push("", `${statusLabel(filters)} issues: ${total}, remediation effort ${fmtEffort(effort)}`);
  if (total > 0) {
    out.push(
      `  by severity: ${ordered(bySeverity, SEVERITIES)}`,
      `  by quality:  ${ordered(byQuality, QUALITIES)}`,
      "  (one issue can have several impacts, so these can exceed the total)",
    );
  }
  out.push("", ...table([["project", "issues", "effort"], ...byProject.map((p) => [p.project, p.total, fmtEffort(p.effortMinutes)])]));
  if (rules.length) {
    out.push("", `top rules (${rules.length} of ${allRules.length}); ${IMPACT_LEGEND}`);
    out.push(
      ...table([
        ["count", "rule", "impacts", "name", "projects"],
        ...rules.map((r) => [
          r.count,
          r.key,
          impactLabel(r.impacts),
          r.name ? (r.name.length > 70 ? `${r.name.slice(0, 69)}…` : r.name) : "?",
          r.projects.length > 3 ? `${r.projects.length} projects` : r.projects.join(", "),
        ]),
      ]),
    );
  }
  return out.join("\n");
}

async function cmdIssues(_args, flags) {
  const ctx = await scopeContext(await loadConfig(), flags);
  const filters = issueFilters(flags);
  const fileMap = await fileFilters(ctx, flags.file);
  const limit = intFlag(flags.limit, 100);
  const per = (
    await Promise.all(
      ctx.scope.targets.map(async (t) => {
        const params = targetParams(t, { ...filters, s: "FILE_LINE" }, fileMap);
        if (!params) return null;
        return { project: t.project, ...(await searchIssues(ctx.client, params, { limit })) };
      }),
    )
  ).filter(Boolean);
  const total = per.reduce((n, p) => n + p.total, 0);
  const issues = per
    .flatMap((p) => p.issues.map((i) => ({ ...i, projectName: p.project.name, path: localPath(p.project, i.sonarPath) })))
    .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, limit);

  if (flags.json) return JSON.stringify({ scope: scopeJson(ctx), total, shown: issues.length, issues }, null, 2);

  const out = scopeHeader(ctx);
  const more = issues.length < total ? `, showing ${issues.length} (--limit N for more)` : "";
  out.push("", `${plural(total, `${statusLabel(filters)} issue`)}${more}. Line numbers are as analyzed; ${IMPACT_LEGEND}`);
  const byFile = new Map();
  for (const i of issues) {
    const k = i.path ?? `(project ${i.projectName})`;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(i);
  }
  for (const [path, list] of byFile) {
    out.push("", path);
    const cols = table(list.map((i) => [`  ${i.line ? `L${i.line}` : "file"}`, impactLabel(i.impacts), i.rule]));
    list.forEach((i, n) => {
      const status = i.status === "OPEN" ? "" : ` (${i.status})`;
      out.push(`${cols[n]}  ${i.message}${status}  [${i.key}]`);
    });
  }
  return out.join("\n");
}

// ---- located issues (plan, issue) ---------------------------------------------

// Project keys are unique per instance only, so the instance is part of the
// lookup.
function findProject(config, instance, key) {
  for (const repo of config.repos) {
    if (repo.instance.name !== instance.name) continue;
    const project = repo.projects.find((p) => p.key === key);
    if (project) return { repo, project };
  }
  return null;
}

function locationTag(loc) {
  switch (loc.status) {
    case "exact":
      return `L${loc.line} [exact]`;
    case "moved":
      return `L${loc.line} [moved from L${loc.sonarLine}]`;
    case "changed":
      return `L${loc.sonarLine} [changed since the analysis, maybe already fixed; re-read the file]`;
    case "stale":
      return `L${loc.line} [stale: no longer matches the analyzed line; re-read the file]`;
    case "missing":
      return `L${loc.sonarLine ?? "?"} [file missing locally]`;
    case "file-level":
      return "file-level";
    case "no-checkout":
      return `L${loc.sonarLine} [as analyzed; no local checkout]`;
    case "unverified":
      return `L${loc.line} [unverified: Sonar's copy of the file was unavailable; check the line]`;
    case "historical":
      return `${loc.sonarLine ? `L${loc.sonarLine} ` : ""}[historical: the issue is fixed; location as last analyzed]`;
    default:
      return `L${loc.sonarLine}`;
  }
}

// Rules whose finding is a credential. No code
// is printed from a file that holds one, whatever issue is being shown:
// local edits can stretch or move a secret across lines, so line-level
// masking cannot be trusted. Listing findings must never copy a secret into
// the transcript; fixing one means reading the file deliberately.
const isCredentialRule = (rule) => /^secrets:|:S2068$|:S6418$|:S6437$/.test(rule);
const WITHHELD = "<code withheld: this file contains a credential finding; read it deliberately>";
// Dismissed findings count too: accepting one does not remove the secret.
const CREDENTIAL_STATUSES = ["OPEN", "CONFIRMED", "ACCEPTED", "FALSE_POSITIVE"];

// The local paths among `paths` whose file holds a credential finding,
// including files its secondary locations point to. targets: [{ project,
// params, target? }]. An MR or branch analysis only reports new code, so the
// baseline is scanned too: main, and the MR's target branch. Fails closed:
// if the scan cannot see every finding, all of `paths` are withheld.
async function credentialFiles(client, targets, paths) {
  const out = new Set();
  if (paths.size === 0) return out;
  const scans = targets.flatMap(({ project, params, target }) => {
    const sets = [params, {}];
    if (target) sets.push({ branch: target });
    const unique = [...new Map(sets.map((s) => [JSON.stringify(s), s])).values()];
    return unique.map((p) => ({ project, params: p, baseline: p !== params }));
  });
  let complete = true;
  await Promise.all(
    scans.map(async ({ project, params, baseline }) => {
      let res;
      try {
        res = await searchIssues(
          client,
          { components: project.key, ...params, impactSoftwareQualities: "SECURITY", issueStatuses: CREDENTIAL_STATUSES },
          { limit: 10_000 },
        );
      } catch (e) {
        // An MR's target branch need not have an analysis of its own.
        if (baseline && params.branch && e instanceof SonarError && e.status === 404) return;
        throw e;
      }
      if (res.issues.length < res.total) complete = false;
      for (const i of res.issues) {
        if (!isCredentialRule(i.rule)) continue;
        for (const path of printedPaths(i, project, localPath(project, i.sonarPath))) if (paths.has(path)) out.add(path);
      }
    }),
  );
  return complete ? out : new Set(paths);
}

// Credential scans cover every mapped project of the repo, whatever is being
// displayed (--project, projects the scope skipped), because projects may
// analyze the same files. A project without the given MR or branch yields no
// issues for it, and its main analysis is still scanned as the baseline.
function credentialTargets(repo, params, target) {
  return repo.projects.map((project) => ({ project, params, target }));
}

// The resolved scope as query params, plus the MR's target branch.
function scopeAnalysis(scope) {
  const params = scope.kind === "mr" ? { pullRequest: scope.key } : scope.kind === "branch" ? { branch: scope.key } : {};
  return { params, target: scope.targets.find((t) => t.target)?.target };
}

// Every local path an issue's output may print code from.
const printedPaths = (issue, project, path) => [
  path,
  ...issue.flows.flatMap((f) => f.locations.map((l) => localPath(project, l.sonarPath))),
];

function renderExcerpt(lines, line, context, indent) {
  const rows = excerpt(lines, line, context);
  const width = String(rows.at(-1)?.[0] ?? line).length;
  return rows.map(([n, text]) => `${indent}${n === line ? ">" : " "} ${String(n).padStart(width)} | ${text}`);
}

const locationNote = (loc) =>
  loc.status === "changed" ? " (changed since the analysis)" : loc.status === "unverified" ? " (unverified)" : "";

const snippet = (text) => {
  const t = text.trim();
  return t.length > 100 ? `${t.slice(0, 99)}…` : t;
};

// Secondary locations, mapped like the primary one. Flows of single
// locations (S3776 increments) print as one list; multi-step flows (data
// flow) print step by step.
async function renderFlows(issue, project, locator, primaryPath, indent, withheld) {
  if (!issue.flows.length) return [];
  // A credential finding's secondary locations may hold parts of the secret.
  const credential = isCredentialRule(issue.rule);
  const steps = issue.flows.every((f) => f.locations.length <= 1);
  const out = [`${indent}secondary locations:`];
  for (const [i, flow] of issue.flows.entries()) {
    if (!steps) out.push(`${indent}  flow ${i + 1}${flow.description ? `: ${flow.description}` : ""}`);
    for (const l of flow.locations) {
      const path = localPath(project, l.sonarPath);
      const loc = await locator.locate({ component: l.component, path, line: l.textRange?.startLine ?? null });
      const lines = loc.line ? await locator.linesOf(l.component, path) : null;
      const where = `${path !== primaryPath ? `${path}:` : ""}L${loc.line ?? loc.sonarLine}${locationNote(loc)}`;
      const code = lines && !credential && !withheld.has(path) ? `:  ${snippet(lines[loc.line - 1] ?? "")}` : "";
      out.push(`${indent}${steps ? "  " : "    "}${where} ${l.msg}${code}`);
    }
  }
  return out;
}

// A fixed issue keeps its old coordinates while Sonar's copy of the file is
// already the fixed code, so mapping them would point at unrelated lines.
// Such locations are reported as historical and never mapped or rendered.
function locateIssue(locator, issue, path) {
  if (issue.status === "FIXED") return { path, sonarLine: issue.line, line: null, status: "historical" };
  return locator.locate({ component: issue.component, path, line: issue.line, hash: issue.hash });
}

// `withheld`: local paths never to print code from (see credentialFiles).
async function renderLocated(issue, project, loc, locator, context, indent, withheld) {
  if (loc.status === "historical") return [];
  const out = [];
  const lines = loc.line ? await locator.linesOf(issue.component, loc.path) : null;
  if (lines && (withheld.has(loc.path) || isCredentialRule(issue.rule))) out.push(`${indent}${WITHHELD}`);
  else if (lines) out.push(...renderExcerpt(lines, loc.line, context, indent));
  out.push(...(await renderFlows(issue, project, locator, loc.path, indent, withheld)));
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function scopeOfIssue(issue) {
  if (issue.pullRequest) return { params: { pullRequest: issue.pullRequest }, label: `MR !${issue.pullRequest}` };
  if (issue.branch) return { params: { branch: issue.branch }, label: `branch ${issue.branch}` };
  return { params: {}, label: "main" };
}

function parseIssueRef(config, ref, preferred) {
  const all = [...config.instances.values()];
  if (/^https?:\/\//i.test(ref)) {
    let url;
    try {
      url = new URL(ref);
    } catch {
      throw new Error(`not a valid URL: ${ref}`);
    }
    // Host plus base path: several instances may share a host under
    // different context paths (https://proxy/sonar-a, https://proxy/sonar-b).
    const base = (u) => `${u.host}${u.pathname.replace(/\/+$/, "")}`;
    const target = base(url);
    const inst = all
      .filter((i) => {
        const b = base(new URL(i.url));
        return target === b || target.startsWith(`${b}/`);
      })
      .sort((a, b) => base(new URL(b.url)).length - base(new URL(a.url)).length)[0];
    if (!inst) throw new Error(`${url.host} is not a configured instance (${all.map((i) => i.url).join(", ")})`);
    if (url.pathname.includes("security_hotspots"))
      throw new Error("security hotspot URLs are not supported; this helper covers issues only");
    const listed = url.searchParams.get("issues")?.split(",").filter(Boolean) ?? [];
    const key = url.searchParams.get("open") ?? (listed.length === 1 ? listed[0] : null);
    if (!key) throw new Error("the URL names no single issue (expected open=<key>); open the issue in Sonar and copy its URL");
    // The URL's MR or branch narrows the lookup; some server versions only
    // search the main branch for a bare key.
    const pullRequest = url.searchParams.get("pullRequest");
    const branch = url.searchParams.get("branch");
    return { key, instances: [inst], scope: pullRequest ? { pullRequest } : branch ? { branch } : {}, fromUrl: true };
  }
  if (!/^[\w-]{10,}$/.test(ref)) throw new Error(`"${ref}" is neither an issue key nor a Sonar URL`);
  return { key: ref, instances: preferred ? [preferred, ...all.filter((i) => i !== preferred)] : all, scope: {}, fromUrl: false };
}

async function cmdPlan(_args, flags) {
  const ctx = await scopeContext(await loadConfig(), flags);
  if (ctx.scope.kind === "main" && !flags.rule)
    throw new Error("on main, plan one rule at a time: pick one from `sonar.mjs summary` and pass --rule KEY");
  const filters = issueFilters(flags);
  const fileMap = await fileFilters(ctx, flags.file);
  const limit = intFlag(flags.limit, 25);
  const context = intFlag(flags.context, 1, "context", 0);

  const per = (
    await Promise.all(
      ctx.scope.targets.map(async (t) => {
        const params = targetParams(t, { ...filters, s: "FILE_LINE", additionalFields: "ruleDescriptionContextKey" }, fileMap);
        if (!params) return null;
        const locator = createLocator({ client: ctx.client, root: ctx.root, scopeParams: t.params });
        return { project: t.project, locator, ...(await searchIssues(ctx.client, params, { limit })) };
      }),
    )
  ).filter(Boolean);
  const total = per.reduce((n, p) => n + p.total, 0);
  const items = per
    .flatMap((p) => p.issues.map((issue) => ({ issue, project: p.project, locator: p.locator, path: localPath(p.project, issue.sonarPath) })))
    .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || (a.issue.line ?? 0) - (b.issue.line ?? 0))
    .slice(0, limit);
  await mapPool(items, 8, async (it) => {
    it.loc = await locateIssue(it.locator, it.issue, it.path);
  });

  const byRule = Map.groupBy(items, (it) => it.issue.rule);
  const infos = new Map(
    await Promise.all([...byRule.keys()].map(async (k) => [k, await fetchRule(ctx.client, k).catch(() => null)])),
  );
  const guidance = new Map();
  if (flags.guidance !== false)
    for (const [key, list] of byRule) {
      const rule = infos.get(key);
      if (rule)
        guidance.set(key, ruleGuidance(rule, { contexts: await planContexts(rule, list), baseUrl: ctx.repo.instance.url }));
    }

  if (flags.json)
    return JSON.stringify(
      {
        scope: scopeJson(ctx),
        total,
        shown: items.length,
        rules: [...byRule].map(([key, list]) => ({
          key,
          name: infos.get(key)?.name ?? null,
          impacts: infos.get(key)?.impacts ?? [],
          guidance: guidance.get(key) ?? null,
          issues: list.map((it) => ({ ...it.issue, path: it.path, location: it.loc })),
        })),
      },
      null,
      2,
    );

  const counts = Map.groupBy(items, (it) => it.loc.status);
  const analysis = scopeAnalysis(ctx.scope);
  const withheld = await credentialFiles(
    ctx.client,
    credentialTargets(ctx.repo, analysis.params, analysis.target),
    new Set(items.flatMap((it) => printedPaths(it.issue, it.project, it.path))),
  );
  const out = scopeHeader(ctx);
  const more = items.length < total ? `, showing ${items.length} (--limit N for more)` : "";
  out.push(
    "",
    `${plural(total, `${statusLabel(filters)} issue`)}${more}. ${IMPACT_LEGEND}`,
    `locations: ${[...counts].map(([s, l]) => `${l.length} ${s}`).join(", ") || "none"}`,
  );
  for (const [rule, list] of byRule) {
    const info = infos.get(rule);
    out.push("", `# ${rule}: ${info?.name ?? "?"} (${impactLabel(info?.impacts)})`);
    if (guidance.has(rule)) out.push("", "## Guidance", "", guidance.get(rule));
    for (const [path, inFile] of Map.groupBy(list, (it) => it.path ?? "(unknown file)")) {
      out.push("", `## ${path}`);
      for (const it of inFile) {
        const status = it.issue.status === "OPEN" ? "" : ` (${it.issue.status})`;
        out.push(`${locationTag(it.loc)} ${it.issue.message}${status}  [${it.issue.key}]`);
        out.push(...(await renderLocated(it.issue, it.project, it.loc, it.locator, context, "  ", withheld)));
      }
    }
  }
  return out.join("\n");
}

// Finds an issue by key or Sonar URL, trying the current repo's instance
// first. The issue comes with additionalFields, so it carries the
// transitions and actions Sonar allows this user.
async function findIssue(config, ref) {
  const here = await currentRepo(config);
  const { key, instances, scope, fromUrl } = parseIssueRef(config, ref, here.repo?.instance);
  const failures = [];
  for (const inst of instances) {
    const client = createClient(inst);
    try {
      const res = await searchIssues(client, { issues: key, additionalFields: "_all", ...scope }, { limit: 1 });
      if (res.issues.length) return { key, issue: res.issues[0], client, here };
    } catch (e) {
      if (!(e instanceof SonarError)) throw e;
      failures.push(e.message);
    }
  }
  const hint = fromUrl ? "" : ". If it belongs to an MR or branch, paste its Sonar URL instead, which carries the scope";
  throw new Error(
    `issue ${key} not found on ${instances.map((i) => i.name).join(", ")}${failures.length ? ` (${failures.join("; ")})` : ""}${hint}`,
  );
}

const issueUrl = (inst, issue, scope) =>
  `${inst.url}/project/issues?${encodeParams({ id: issue.project, open: issue.key, ...scope.params })}`;

async function cmdIssue(args, flags) {
  if (!args[0]) throw new Error("usage: sonar.mjs issue <issue key | Sonar issue URL>");
  const config = await loadConfig();
  const context = intFlag(flags.context, 3, "context", 0);
  const { key, issue, client, here } = await findIssue(config, args[0]);

  const inst = client.instance;
  const scope = scopeOfIssue(issue);
  const mapped = findProject(config, inst, issue.project);
  const project = mapped?.project ?? { key: issue.project, name: issue.project, prefix: "" };
  // Local files only count when cwd is a checkout of the repo this project maps to.
  const root = mapped && here.repo === mapped.repo ? here.root : null;
  const locator = createLocator({ client, root, scopeParams: scope.params });
  const path = localPath(project, issue.sonarPath);
  const [loc, rule, changelog] = await Promise.all([
    locateIssue(locator, issue, path),
    fetchRule(client, issue.rule).catch(() => null),
    client.get("/api/issues/changelog", { issue: key }, { optional: true }),
  ]);
  const url = issueUrl(inst, issue, scope);
  // Code is only printed from local files, so without a checkout there is
  // nothing to withhold.
  let withheld = new Set();
  if (root) {
    // The MR's target branch is part of the credential baseline; the issue
    // itself only names the MR.
    const pr = issue.pullRequest
      ? (await loadAnalyses(client, project)).prs.find((p) => p.key === issue.pullRequest)
      : null;
    // `root` is only set for a mapped project, so `mapped` exists here.
    withheld = await credentialFiles(
      client,
      credentialTargets(mapped.repo, scope.params, pr?.target ?? pr?.base),
      new Set(printedPaths(issue, project, path)),
    );
  }

  let guidance = null;
  if (flags.guidance !== false && rule) {
    const lines = await locator.linesOf(issue.component, path);
    const contexts = selectContexts(rule, { contextKey: issue.ruleDescriptionContextKey, fileText: lines?.join("\n") ?? null });
    guidance = ruleGuidance(rule, { contexts, baseUrl: inst.url });
  }

  if (flags.json)
    return JSON.stringify(
      { instance: inst.name, scope: scope.label, ...issue, path, location: loc, ruleName: rule?.name ?? null, guidance, changelog: changelog?.changelog ?? [], url },
      null,
      2,
    );

  const out = [
    `issue ${key} on ${inst.name} (${project.name}, ${scope.label})`,
    `rule:      ${issue.rule}  ${rule?.name ?? ""}`.trimEnd(),
    `status:    ${issue.status}  |  impacts: ${impactLabel(issue.impacts)}  |  ${issue.type ?? ""}${issue.effort ? `  |  effort ${issue.effort}` : ""}`,
    `created:   ${fmtDate(issue.creationDate)}${issue.author ? ` by ${issue.author}` : ""}${issue.tags.length ? `  |  tags: ${issue.tags.join(", ")}` : ""}`,
    `message:   ${issue.message}`,
    `location:  ${path ?? "(unknown)"} ${locationTag(loc)}`,
    ...(await renderLocated(issue, project, loc, locator, context, "  ", withheld)),
  ];
  if (!root && mapped) out.push(`  (run inside a checkout of ${mapped.repo.name} to map lines onto local files)`);
  if (issue.comments?.length) {
    out.push("comments:");
    for (const c of issue.comments) out.push(`  ${fmtDate(c.createdAt)} ${c.login}: ${c.markdown ?? c.htmlText ?? ""}`);
  }
  const history = (changelog?.changelog ?? []).slice(-5);
  if (history.length) {
    out.push("history (latest 5):");
    for (const h of history) {
      const diffs = (h.diffs ?? [])
        .filter((d) => d.key !== "line" && d.key !== "textRange")
        .map((d) => `${d.key} ${d.oldValue ?? ""}->${d.newValue ?? ""}`);
      if (diffs.length) out.push(`  ${fmtDate(h.creationDate)} ${h.userName ?? h.user ?? "sonar"}: ${diffs.join(", ")}`);
    }
  }
  if (issue.transitions?.length) out.push(`transitions you may apply: ${issue.transitions.join(", ")}`);
  out.push(`url:       ${url}`);
  if (guidance) out.push("", "## Guidance", "", guidance);
  return out.join("\n");
}

// The framework contexts to show for one rule in a plan: the union of what
// each issue's file selects, so a batch mixing asyncio and anyio files gets
// both and nothing else.
async function planContexts(rule, list) {
  if (ruleContexts(rule).length <= 1) return null;
  const keys = new Set();
  for (const it of list) {
    const lines = await it.locator.linesOf(it.issue.component, it.path);
    const picked = selectContexts(rule, { contextKey: it.issue.ruleDescriptionContextKey, fileText: lines?.join("\n") ?? null });
    for (const k of picked ?? []) keys.add(k);
  }
  return keys.size ? [...keys] : null;
}

// A rule is instance-wide; take the instance from --instance, the repo in
// scope, or the only one configured.
async function ruleInstance(config, flags) {
  if (flags.instance) {
    const inst = config.instances.get(flags.instance);
    if (!inst) throw new Error(`unknown instance "${flags.instance}". Configured: ${[...config.instances.keys()].join(", ")}`);
    return inst;
  }
  if (flags.repo) return (await repoContext(config, flags)).repo.instance;
  const here = await currentRepo(config);
  if (here.repo) return here.repo.instance;
  if (config.instances.size === 1) return [...config.instances.values()][0];
  throw new Error(`not inside a mapped repo; pass --instance (${[...config.instances.keys()].join(", ")})`);
}

async function cmdRule(args, flags) {
  if (!args[0]) throw new Error("usage: sonar.mjs rule <rule key, e.g. python:S3776>");
  const config = await loadConfig();
  const inst = await ruleInstance(config, flags);
  const client = createClient(inst);
  let rule;
  try {
    rule = await fetchRule(client, args[0]);
  } catch (e) {
    if (e instanceof SonarError && e.status === 404) throw new Error(`rule ${args[0]} not found on ${inst.name}`);
    throw e;
  }
  const contexts = ruleContexts(rule);
  if (flags.framework && !contexts.some((c) => c.key === flags.framework))
    throw new Error(
      `${rule.key} has ${contexts.length ? `frameworks: ${contexts.map((c) => c.key).join(", ")}` : "no framework variants"}`,
    );
  const sections = ["introduction", "root_cause", "assess_the_problem", "how_to_fix", "resources"];
  const body = ruleGuidance(rule, { sections, contexts: flags.framework ? [flags.framework] : null, baseUrl: inst.url });
  const url = `${inst.url}/coding_rules?${encodeParams({ open: rule.key, rule_key: rule.key })}`;
  const effort = rule.remFnBaseEffort ?? rule.defaultRemFnBaseEffort ?? rule.debtRemFnOffset ?? null;

  if (flags.json) return JSON.stringify({ instance: inst.name, ...rule, markdown: body, url }, null, 2);

  const tags = [...(rule.sysTags ?? []), ...(rule.tags ?? [])];
  const out = [
    `rule ${rule.key}: ${rule.name}${rule.status && rule.status !== "READY" ? ` (${rule.status})` : ""}`,
    `language: ${rule.langName ?? rule.lang}  |  impacts: ${impactLabel(rule.impacts)}  |  ${rule.type ?? ""}${rule.cleanCodeAttribute ? `  |  attribute: ${rule.cleanCodeAttribute}` : ""}${effort ? `  |  effort per issue: ${effort}` : ""}`,
  ];
  if (tags.length) out.push(`tags: ${tags.join(", ")}`);
  if (contexts.length) out.push(`frameworks: ${contexts.map((c) => `${c.displayName} (${c.key})`).join(", ")}`);
  out.push(`url: ${url}`, "", body);
  return out.join("\n");
}

// ---- writes ----------------------------------------------------------------------

const DRY_RUN = "DRY RUN, nothing was sent. To apply, re-run with --confirm, only after the user approved this exact change:";

// Inline text or a file, never both. The file form exists because backticks
// and $ in an inline shell argument get expanded before the helper sees them.
async function readText(flags, inline, file) {
  if (flags[inline] !== undefined && flags[file] !== undefined) throw new Error(`pass --${inline} or --${file}, not both`);
  if (flags[file] !== undefined) return (await readFile(String(flags[file]), "utf8")).trim();
  return flags[inline] === undefined ? "" : String(flags[inline]).trim();
}

async function writeTarget(config, ref) {
  const found = await findIssue(config, ref);
  let identityError = "the server returned no login";
  const [login, rule] = await Promise.all([
    found.client.get("/api/users/current").then(
      (u) => u?.login ?? null,
      (e) => {
        identityError = e.message;
        return null;
      },
    ),
    fetchRule(found.client, found.issue.rule).catch(() => null),
  ]);
  const mapped = findProject(config, found.client.instance, found.issue.project);
  const project = mapped?.project ?? { key: found.issue.project, name: found.issue.project, prefix: "" };
  const scope = scopeOfIssue(found.issue);
  return { ...found, login, identityError, project, rule, scope, url: issueUrl(found.client.instance, found.issue, scope) };
}

// The approval covers who the write is attributed to, so a confirmed write
// never goes out under an unknown user.
function requireIdentity(t) {
  if (!t.login)
    throw new Error(`not writing: could not confirm which Sonar user the write would be attributed to (${t.identityError})`);
}

// Everything the user needs to approve the write, including whose name it
// will carry in Sonar.
function writeSummary(t, statusChange, comment) {
  const i = t.issue;
  const path = localPath(t.project, i.sonarPath);
  return [
    `  instance:  ${t.client.instance.name}, writing as ${t.login ?? `an unknown user (${t.identityError})`}`,
    `  issue:     ${i.key} (${t.project.name}, ${t.scope.label})`,
    `  rule:      ${i.rule}  ${t.rule?.name ?? ""}`.trimEnd(),
    `  location:  ${path ?? "?"}${i.line ? `:${i.line}` : ""} (as analyzed)`,
    `  message:   ${i.message}`,
    `  status:    ${statusChange}`,
    "  comment:",
    ...comment.split("\n").map((l) => `    ${l}`),
    `  url:       ${t.url}`,
  ];
}

async function cmdComment(args, flags) {
  if (!args[0]) throw new Error("usage: sonar.mjs comment <issue key | URL> --text TEXT | --text-file PATH [--confirm]");
  const text = await readText(flags, "text", "text-file");
  const t = await writeTarget(await loadConfig(), args[0]);
  const problems = commentWriteProblems(t.issue, text);
  if (problems.length) throw new Error(`refusing to comment on ${t.issue.key}:\n  - ${problems.join("\n  - ")}`);
  const summary = writeSummary(t, `${t.issue.status} (unchanged)`, text);
  if (!flags.confirm) return [DRY_RUN, ...summary].join("\n");
  requireIdentity(t);
  await t.client.post("/api/issues/add_comment", { issue: t.issue.key, text });
  return [`Comment posted on ${t.issue.key}:`, ...summary].join("\n");
}

async function cmdTransition(args, flags) {
  const [ref, name] = args;
  if (!ref || !name)
    throw new Error(
      "usage: sonar.mjs transition <issue key | URL> accept|falsepositive --comment TEXT | --comment-file PATH [--confirm]",
    );
  const comment = await readText(flags, "comment", "comment-file");
  const t = await writeTarget(await loadConfig(), ref);
  const problems = transitionProblems(t.issue, name, comment);
  if (problems.length) {
    const handOff = isSecurityFinding(t.issue) ? `\n  review it in Sonar: ${t.url}` : "";
    throw new Error(`refusing to ${name} ${t.issue.key}:\n  - ${problems.join("\n  - ")}${handOff}`);
  }
  const transition = resolveTransition(name);
  const summary = writeSummary(t, `${t.issue.status} -> ${transition.status}`, comment);
  if (!flags.confirm) return [DRY_RUN, ...summary].join("\n");
  requireIdentity(t);

  // Comment first: if the transition then fails, the reason is still on
  // record, and re-running shows the issue's real state.
  await t.client.post("/api/issues/add_comment", { issue: t.issue.key, text: comment });
  try {
    await t.client.post("/api/issues/do_transition", { issue: t.issue.key, transition: transition.name });
  } catch (e) {
    throw new Error(`the comment was posted, but the transition failed: ${e.message}. Run the dry run again to see the current state`);
  }
  // The write succeeded; failing to re-read the status must not read as a
  // failed write.
  let status = transition.status;
  try {
    status = (await searchIssues(t.client, { issues: t.issue.key }, { limit: 1 })).issues[0]?.status ?? status;
  } catch (e) {
    status = `${status} (could not re-read the issue: ${e.message})`;
  }
  return [`Done: ${t.issue.key} is now ${status}, with the comment on record:`, ...summary].join("\n");
}

// ---- coverage --------------------------------------------------------------------

const pct = (v) => (v == null ? "-" : `${v.toFixed(1)}%`);
const MAX_CODE_LINES = 20;

// Maps analyzed line numbers onto the local file, keeping Sonar's code text
// when the line cannot be mapped (no checkout, or edited since).
async function localizeLines(locator, file, entries) {
  return Promise.all(
    entries.map(async (e) => {
      const loc = await locator.locate({ component: file.key, path: file.path, line: e.line });
      const lines = loc.line ? await locator.linesOf(file.key, file.path) : null;
      return { ...e, localLine: loc.line, status: loc.status, code: lines ? lines[loc.line - 1] : e.code };
    }),
  );
}

async function cmdCoverage(_args, flags) {
  const ctx = await scopeContext(await loadConfig(), flags);
  const metrics = flags.overall ? OVERALL : NEW_CODE;
  if (metrics.overall && ctx.scope.kind === "mr")
    throw new Error("overall coverage is a branch measure, an MR has only new-code coverage; drop --overall or pass --main / --branch");
  const limit = intFlag(flags.limit, 10);
  const pathFilter = flags.file === undefined ? null : await repoPath(ctx, flags.file);
  const inFilter = (path) =>
    !pathFilter || pathFilter.rel === "" || path === pathFilter.rel || path?.startsWith(`${pathFilter.rel}/`);

  const per = await Promise.all(
    ctx.scope.targets.map(async (t) => {
      const summary = await projectCoverage(ctx.client, t.project.key, t.params, metrics);
      const scan = summary.lines
        ? await fileGaps(ctx.client, t.project.key, t.params, metrics)
        : { gaps: [], scanned: 0, total: 0, truncated: false };
      return { target: t, summary, ...scan };
    }),
  );
  const truncated = per.filter((p) => p.truncated);
  const allFiles = per
    .flatMap(({ target, gaps }) => gaps.map((f) => ({ ...f, target, path: localPath(target.project, f.sonarPath) })))
    .filter((f) => inFilter(f.path))
    .sort((a, b) => (b.uncoveredLines ?? 0) - (a.uncoveredLines ?? 0) || (b.uncoveredConditions ?? 0) - (a.uncoveredConditions ?? 0));
  const top = allFiles.slice(0, limit);

  const locators = new Map(
    ctx.scope.targets.map((t) => [t.project.key, createLocator({ client: ctx.client, root: ctx.root, scopeParams: t.params })]),
  );
  let lineDetail = true;
  await mapPool(top, 4, async (f) => {
    const lines = await lineCoverage(ctx.client, f.key, f.target.params, { newOnly: !metrics.overall, totalLines: f.totalLines });
    if (!lines) {
      lineDetail = false;
      return;
    }
    const locator = locators.get(f.target.project.key);
    f.detail = {
      uncovered: await localizeLines(locator, f, lines.uncovered),
      partial: await localizeLines(locator, f, lines.partial),
    };
  });
  // Coverage prints code even without a checkout (Sonar's copy), so the
  // credential check applies here regardless of `root`, JSON included.
  const analysis = scopeAnalysis(ctx.scope);
  const withheld = await credentialFiles(
    ctx.client,
    credentialTargets(ctx.repo, analysis.params, analysis.target),
    new Set(top.map((f) => f.path)),
  );
  for (const f of top)
    if (f.detail && withheld.has(f.path))
      for (const e of [...f.detail.uncovered, ...f.detail.partial]) e.code = null;

  const what = metrics.overall ? "overall coverage" : "coverage on new code (what quality gates measure)";
  if (flags.json)
    return JSON.stringify(
      {
        scope: scopeJson(ctx),
        measure: metrics.overall ? "overall" : "new_code",
        projects: per.map((p) => ({
          project: p.target.project.name,
          ...p.summary,
          filesScanned: p.scanned,
          filesTotal: p.total,
          truncated: p.truncated,
        })),
        filesWithGaps: allFiles.length,
        lineDetail,
        files: top.map(({ target, ...f }) => ({ project: target.project.name, ...f })),
      },
      null,
      2,
    );

  const out = scopeHeader(ctx);
  out.push("", `${what}:`);
  out.push(
    ...table([
      ["  project", "coverage", "lines to cover", "uncovered", "conditions", "uncovered"],
      ...per.map(({ target, summary: s }) =>
        s.lines
          ? [`  ${target.project.name}`, pct(s.coverage), s.lines, s.uncoveredLines ?? 0, s.conditions ?? 0, s.uncoveredConditions ?? 0]
          : [`  ${target.project.name}`, metrics.overall ? "no coverage data" : "no new code", "", "", "", ""],
      ),
    ]),
  );
  for (const p of truncated)
    out.push(
      `warning: ${p.target.project.name}: only ${p.scanned} of ${p.total} files could be checked (Sonar's paging limit); counts and ranking cover those files only`,
    );
  if (allFiles.length === 0) {
    const where = pathFilter ? ` under ${pathFilter.rel || "the repo root"}` : "";
    out.push("", truncated.length ? `No coverage gaps${where} among the checked files.` : `No coverage gaps${where}.`);
    return out.join("\n");
  }
  const more = top.length < allFiles.length ? `, showing ${top.length} (--limit N for more)` : "";
  out.push("", `${plural(allFiles.length, "file")} with gaps${more}, most uncovered lines first.`);
  if (!lineDetail)
    out.push("warning: exact lines unavailable (api/sources/lines did not answer as expected); showing per-file counts only");
  else if (ctx.root) out.push("Line numbers and code are from your checkout, mapped from the analysis.");
  else out.push("Line numbers and code are as analyzed (no local checkout).");

  for (const f of top) {
    const conditions = f.conditions ? `, ${f.uncoveredConditions ?? 0} of ${f.conditions} conditions` : "";
    out.push("", `## ${f.path}  ${pct(f.coverage)} (${f.uncoveredLines ?? 0} of ${f.lines ?? 0} lines uncovered${conditions})`);
    const d = f.detail;
    if (!d) continue;
    // Lines edited since the analysis have no local number. They are listed
    // apart, under their analyzed numbers, so every number in the main lists
    // refers to the same version of the file.
    const edited = (e) => e.status === "changed" || e.status === "stale";
    const num = (e) => e.localLine ?? e.line;
    const uncovered = d.uncovered.filter((e) => !edited(e));
    const partial = d.partial.filter((e) => !edited(e));
    const editedEntries = [...d.uncovered, ...d.partial].filter(edited).sort((a, b) => a.line - b.line);
    const unverified = [...uncovered, ...partial].filter((e) => e.status === "unverified");
    if (uncovered.length) {
      out.push(`  uncovered lines: ${toRanges(uncovered.map(num))}`);
      const width = String(Math.max(...uncovered.map(num))).length;
      if (withheld.has(f.path)) out.push(`    ${WITHHELD}`);
      else {
        for (const e of uncovered.slice(0, MAX_CODE_LINES)) out.push(`    ${String(num(e)).padStart(width)} | ${e.code}`);
        if (uncovered.length > MAX_CODE_LINES) out.push(`    ... ${uncovered.length - MAX_CODE_LINES} more, read the file`);
      }
    }
    if (partial.length)
      out.push(`  partly covered branches: ${partial.map((e) => `L${num(e)} (${e.covered} of ${e.total} covered)`).join(", ")}`);
    if (editedEntries.length)
      out.push(
        `  edited since the analysis (analyzed line numbers; re-read the file): ${editedEntries.map((e) => `L${e.line}${e.total ? " (branch)" : ""}`).join(", ")}`,
      );
    if (d.uncovered.concat(d.partial).some((e) => e.status === "missing"))
      out.push("  note: this file is not in your checkout; lines and code shown as analyzed");
    if (unverified.length)
      out.push(
        `  note: unverified, Sonar's copy of the file was unavailable, check before relying on them: ${unverified.map((e) => `L${num(e)}`).join(", ")}`,
      );
  }
  return out.join("\n");
}

// ---- dispatch ----------------------------------------------------------------

// `args`: how many positional arguments a command takes; `flags`: which
// flags. Anything else is an error, not ignored: `--confirm false` must not
// silently mean --confirm, and a mistyped filter must not silently vanish.
const SCOPE_FLAGS = ["mr", "branch", "main", "repo", "project"];
const FILTER_FLAGS = ["rule", "severity", "quality", "status", "file", "limit"];
const command = (run, args, flags) => ({ run, args, flags: new Set(flags) });
const COMMANDS = {
  me: command(cmdMe, 0, ["instance", "json"]),
  projects: command(cmdProjects, 0, ["instance", "all", "json"]),
  gate: command(cmdGate, 0, [...SCOPE_FLAGS, "json"]),
  summary: command(cmdSummary, 0, [...SCOPE_FLAGS, ...FILTER_FLAGS, "json"]),
  issues: command(cmdIssues, 0, [...SCOPE_FLAGS, ...FILTER_FLAGS, "json"]),
  plan: command(cmdPlan, 0, [...SCOPE_FLAGS, ...FILTER_FLAGS, "context", "guidance", "json"]),
  issue: command(cmdIssue, 1, ["context", "guidance", "json"]),
  rule: command(cmdRule, 1, ["instance", "repo", "framework", "json"]),
  coverage: command(cmdCoverage, 0, [...SCOPE_FLAGS, "file", "limit", "overall", "json"]),
  comment: command(cmdComment, 1, ["text", "text-file", "confirm"]),
  transition: command(cmdTransition, 2, ["comment", "comment-file", "confirm"]),
};

async function main() {
  const argv = process.argv.slice(2);
  // -h/--help anywhere, except as the value of a preceding value flag
  // (`--text -h` is a comment text).
  const isValueOf = (i) => i > 1 && argv[i - 1].startsWith("--") && !argv[i - 1].includes("=") && !BOOL_FLAGS.has(argv[i - 1].slice(2));
  if (argv.length === 0 || argv.some((a, i) => (a === "-h" || a === "--help") && !isValueOf(i))) {
    help();
    return;
  }
  const cmd = argv[0];
  const spec = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
  if (!spec) die(`unknown command: ${cmd}. Try --help.`);
  const { positional, flags } = parseArgs(argv.slice(1), cmd, spec.flags);
  if (positional.length > spec.args) {
    const extra = positional.slice(spec.args);
    const hint = extra.some((a) => Object.hasOwn(BOOL_VALUES, a.toLowerCase()))
      ? ". Boolean flags take their value with =, e.g. --confirm=false"
      : "";
    die(`unexpected argument${extra.length > 1 ? "s" : ""}: ${extra.join(" ")}${hint}`);
  }
  try {
    const out = await spec.run(positional, flags);
    // JSON stays whole for machine use; text is bounded for the agent's context.
    process.stdout.write(`${flags.json ? out : await spill(out, `${cmd}-${Date.now()}-${process.pid}`)}\n`);
  } catch (e) {
    die(e.message || String(e));
  }
}

main();
