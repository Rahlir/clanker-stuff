import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { age, hours, int, localDate, localStamp, money, oneLine, short, table } from "../format.mjs";
import { PissError } from "../load.mjs";
import { all, coverageWarnings, headerLines, openCorpus, prepareScope, resolveWindow } from "../query.mjs";

export const summary = "What came out of the work: your commits, merge requests (glab) and Jira tickets.";

export const usage = `piss outcomes [options]

Outcomes for the repos and tickets worked on in the window: commits you
authored (from local refs, never fetched), your GitLab merge requests (glab),
and the Jira tickets mentioned in your sessions with their current status
(jira CLI). Missing tools or failing calls become notes, not errors.

  --since <time>   start of the window (default 30d)
  --until <time>   end of the window (default now; built: the corpus's end)
  --repo TEXT      only repos whose path contains TEXT
  --max-repos N    look at the N repos with the most active time (default 10)
  --no-glab        skip merge requests
  --no-jira        skip Jira
  --json           print the data as JSON`;

const TIMEOUT = 60_000;
const PAGE = 100;
const MAX_PAGES = 20;
const COMMITS_SHOWN = 15;
const MRS_SHOWN = 15;
const TICKETS_SHOWN = 30;
const JIRA_BATCH = 100;
const JIRA_COLUMNS = ["key", "type", "status", "resolution", "updated", "summary"];

function exec(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message };
}

const firstLine = (r) => oneLine((r.stderr || r.stdout || r.error || "failed").split("\n").find((l) => l.trim()) ?? "failed", 160);

function onPath(cmd) {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, cmd)));
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function defaultBranch(repo) {
  const head = exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo);
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (exec("git", ["rev-parse", "--verify", "--quiet", ref], repo).ok) return ref;
  }
  return null;
}

function parseLog(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...subject] = line.split("\t");
      return { hash, date, subject: subject.join("\t") };
    });
}

function gitOutcomes(repo, w) {
  const email = exec("git", ["config", "user.email"], repo).stdout.trim();
  if (!email) return { repo, note: "no git user.email configured" };
  // Unknown is not zero: without a default branch or a working git log there
  // is a note instead of commit lists, and the repo counts as not checked.
  const branch = defaultBranch(repo);
  if (!branch) return { repo, email, note: "no default branch (origin/HEAD, main or master), so landed commits are unknown" };
  // git's --until includes its end and reads whole seconds: the last second
  // before the window's end keeps it half-open, [since, until).
  const until = new Date((Math.ceil(Date.parse(w.U) / 1000) - 1) * 1000).toISOString();
  const range = ["--no-merges", `--author=${email}`, `--since=${w.S}`, `--until=${until}`, "--format=%h%x09%cI%x09%s"];
  const onBranch = exec("git", ["log", branch, ...range], repo);
  const anywhere = exec("git", ["log", "--all", ...range], repo);
  const failed = [onBranch, anywhere].find((r) => !r.ok);
  if (failed) return { repo, email, note: `git log failed: ${firstLine(failed)}` };
  const landed = parseLog(onBranch.stdout);
  const landedSet = new Set(landed.map((c) => c.hash));
  const elsewhere = parseLog(anywhere.stdout).filter((c) => !landedSet.has(c.hash));
  const fetchHead = join(repo, ".git", "FETCH_HEAD");
  const fetchedAt = existsSync(fetchHead) ? statSync(fetchHead).mtime.toISOString() : null;
  return { repo, email, default_branch: branch, fetched_at: fetchedAt, landed, elsewhere };
}

// ---------------------------------------------------------------------------
// glab
// ---------------------------------------------------------------------------

function glabOutcomes(repo, w, users) {
  const remote = exec("git", ["remote", "get-url", "origin"], repo).stdout.trim();
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(remote)?.[1] ?? remote;
  if (!remote) return { repo, skipped: "no origin remote" };
  if (/(^|\.)github\.com$/i.test(host)) return { repo, skipped: "GitHub remote" };
  if (!users.has(host)) {
    const r = exec("glab", ["api", "user"], repo);
    let name = null;
    try {
      name = r.ok ? JSON.parse(r.stdout).username : null;
    } catch {
      name = null;
    }
    users.set(host, name ? { name } : { error: firstLine(r) });
  }
  const user = users.get(host);
  if (!user.name) return { repo, note: `glab: ${user.error}` };
  // Every page is fetched before filtering: a window's MRs can sit behind
  // hundreds of newer ones.
  const list = (extra) => {
    const mrs = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const args = ["mr", "list", "--author", user.name, ...extra, "-F", "json", "-P", String(PAGE), "-p", String(page)];
      const r = exec("glab", args, repo);
      if (!r.ok) return { error: firstLine(r) };
      let batch;
      try {
        batch = JSON.parse(r.stdout || "[]");
      } catch {
        return { error: "glab returned something that is not JSON" };
      }
      mrs.push(...batch);
      if (batch.length < PAGE) return { mrs };
    }
    return { mrs, error: `stopped after ${MAX_PAGES * PAGE} merge requests` };
  };
  const merged = list(["--merged"]);
  if (!merged.mrs) return { repo, note: `glab: ${merged.error}` };
  const open = list([]);
  const pick = (m) => ({ iid: m.iid, title: m.title, created_at: m.created_at, merged_at: m.merged_at ?? null, url: m.web_url });
  const inWindow = (iso) => iso && new Date(iso) >= w.since && new Date(iso) < w.until;
  return {
    repo,
    merged: merged.mrs.filter((m) => inWindow(m.merged_at)).map(pick),
    open: (open.mrs ?? []).map(pick),
    note: [merged.error && `glab (merged MRs): ${merged.error}`, open.error && `glab (open MRs): ${open.error}`].filter(Boolean).join("; ") || null,
  };
}

// ---------------------------------------------------------------------------
// jira
// ---------------------------------------------------------------------------

/** Fields of RFC 4180 CSV text, rows of cells. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows.filter((r) => r.some((f) => f !== ""));
}

// The jira CLI escapes square brackets for its terminal UI even in CSV: "[core]" becomes "[core[]".
const unescapeTview = (s) => s.replace(/\[([^[\]]*)\[\]/g, "[$1]");

/** Rows of `jira issue list --csv --columns ...` output, keyed by lowercased header. */
export function parseJiraCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const cols = header.map((h) => h.trim().toLowerCase());
  return rows
    .map((cells) => Object.fromEntries(cols.map((c, i) => [c, unescapeTview((cells[i] ?? "").trim())])))
    .filter((r) => /^[A-Z][A-Z0-9_]*-\d+$/.test(r.key ?? ""));
}

/** Jira drops leading zeros from issue numbers in its answers (HSCTR-0042 is HSCTR-42). */
export function canonicalKey(key) {
  const m = /^([A-Z][A-Z0-9_]*)-0*(\d+)$/.exec(key);
  return m ? `${m[1]}-${m[2]}` : key;
}

/** Keys Jira rejected in a `key in (...)` query, which fails as a whole; canonical form. */
export function rejectedJiraKeys(text) {
  const keys = new Set();
  for (const m of text.matchAll(/(?:An issue with key|The issue key) '([A-Z][A-Z0-9_]*-\d+)'/g)) keys.add(canonicalKey(m[1]));
  return [...keys];
}

/** Every row of a JQL query, page by page (the CLI returns at most 100 per call). */
function jiraList(jql, columns = JIRA_COLUMNS) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = exec("jira", ["issue", "list", "-q", jql, "--csv", "--columns", columns.join(","), "--paginate", `${page * PAGE}:${PAGE}`]);
    const text = `${r.stdout}\n${r.stderr}`;
    if (!r.ok) {
      if (/no result/i.test(text)) return { rows };
      return { error: firstLine(r), text };
    }
    const batch = parseJiraCsv(r.stdout);
    rows.push(...batch);
    if (batch.length < PAGE) return { rows };
  }
  return { rows, error: `stopped after ${MAX_PAGES * PAGE} issues` };
}

function jiraDetails(keys) {
  const rows = [];
  for (let i = 0; i < keys.length; i += JIRA_BATCH) {
    let batch = keys.slice(i, i + JIRA_BATCH);
    while (batch.length) {
      const r = jiraList(`key in (${batch.join(", ")})`);
      if (r.rows && !r.error) {
        rows.push(...r.rows);
        break;
      }
      const bad = new Set(rejectedJiraKeys(r.text ?? ""));
      const kept = batch.filter((k) => !bad.has(canonicalKey(k)));
      if (kept.length === batch.length) return { rows, error: r.error };
      batch = kept;
    }
  }
  return { rows };
}

function jiraOutcomes(db, w, projects) {
  const mentioned = all(
    db,
    `WITH m AS (SELECT DISTINCT key, ref FROM ticket_mentions WHERE ts >= $S AND ts < $U AND ref IN (SELECT ref FROM scope))
     SELECT m.key, count(*) sessions, group_concat(m.ref, ' ') refs,
       (SELECT coalesce(sum(a.user_s), 0) FROM active_time a WHERE a.ref IN (SELECT ref FROM m m2 WHERE m2.key = m.key) AND a.hour >= $H AND a.hour < $U) user_s,
       (SELECT coalesce(sum(a.agent_s), 0) FROM active_time a WHERE a.ref IN (SELECT ref FROM m m2 WHERE m2.key = m.key) AND a.hour >= $H AND a.hour < $U) agent_s,
       (SELECT coalesce(sum(u.cost_corrected), 0) FROM usage_events u WHERE u.ref IN (SELECT ref FROM m m2 WHERE m2.key = m.key) AND u.ts >= $S AND u.ts < $U) cost
     FROM m GROUP BY m.key`,
    { S: w.S, U: w.U, H: w.H },
  );
  const details = jiraDetails(mentioned.map((t) => t.key));
  const byKey = new Map(details.rows.map((r) => [canonicalKey(r.key), r]));
  const tickets = mentioned
    .map((t) => {
      const hit = byKey.get(canonicalKey(t.key));
      return { ...t, ...(hit ?? {}), key: t.key, found: Boolean(hit) };
    })
    .sort((a, b) => b.user_s + b.agent_s - (a.user_s + a.agent_s));
  // Two views of resolved work that differ on purpose: tickets assigned to
  // you, whoever resolved them, and tickets whose resolution you set, whoever
  // they are assigned to (the issue history names the actor; you often close
  // teammates' tickets). JQL reads these local times in the Jira profile's
  // timezone.
  const start = `"${localStamp(w.S)}"`;
  const end = `"${localStamp(w.U)}"`;
  const scope = `project in (${projects.join(", ")})`;
  const cols = ["key", "type", "status", "summary"];
  const assigned = jiraList(`${scope} AND assignee = currentUser() AND resolved >= ${start} AND resolved < ${end}`, cols);
  const closed = jiraList(`${scope} AND resolution CHANGED FROM EMPTY BY currentUser() DURING (${start}, ${end})`, cols);
  const created = jiraList(`${scope} AND creator = currentUser() AND created >= ${start} AND created < ${end}`, cols);
  const notes = [];
  if (details.error) notes.push(`jira: ${details.error}`);
  // Jira fails a short `key in (...)` query on an unknown key but silently
  // drops unknown keys from a long one, so report whatever did not come back.
  const missing = details.error ? [] : tickets.filter((t) => !t.found).map((t) => t.key);
  if (missing.length) notes.push(`jira returned nothing for ${missing.join(", ")} (deleted, moved, or not a ticket)`);
  if (assigned.error) notes.push(`jira (your tickets resolved): ${assigned.error}`);
  if (closed.error) notes.push(`jira (tickets you closed): ${closed.error}`);
  if (created.error) notes.push(`jira (created): ${created.error}`);
  const complete = (r) => (r.rows && !r.text ? r.rows : null);
  return {
    projects,
    tickets,
    assigned_resolved: complete(assigned),
    closed_by_you: complete(closed),
    created_by_you: complete(created),
    notes,
  };
}

// ---------------------------------------------------------------------------

function render(data, corpus, w) {
  const out = headerLines(corpus, w);
  out.push("", "GIT (commits you authored; local refs only, nothing is fetched)");
  if (!data.git.length) out.push("no git repos among the sessions in this window");
  const quiet = data.git.filter((g) => !g.note && !g.landed.length && !g.elsewhere.length);
  for (const g of data.git) {
    if (quiet.includes(g)) continue;
    if (g.note) {
      out.push(`${short(g.repo)}: ${g.note}`);
      continue;
    }
    const fetched = g.fetched_at ? `origin fetched ${age(Date.now() - new Date(g.fetched_at))}` : "never fetched";
    out.push(
      `${short(g.repo)}: ${g.landed.length} on ${g.default_branch ?? "(no default branch)"}, ${g.elsewhere.length} only on other branches (${fetched})`,
    );
    for (const c of g.landed.slice(0, COMMITS_SHOWN)) out.push(`  ${localDate(c.date)}  ${c.hash}  ${oneLine(c.subject, 100)}`);
    if (g.landed.length > COMMITS_SHOWN) out.push(`  (+${g.landed.length - COMMITS_SHOWN} more)`);
  }
  if (quiet.length) out.push(`no commits by you: ${quiet.map((g) => short(g.repo)).join(", ")}`);

  if (data.merge_requests) {
    out.push("", "MERGE REQUESTS (glab, authored by you)");
    const none = data.merge_requests.filter((m) => m.merged && !m.merged.length && !m.open.length && !m.note);
    const skipped = data.merge_requests.filter((m) => m.skipped);
    for (const m of data.merge_requests) {
      if (none.includes(m) || m.skipped) continue;
      if (m.note && !m.merged) {
        out.push(`${short(m.repo)}: ${m.note}`);
        continue;
      }
      out.push(`${short(m.repo)}: ${m.merged.length} merged in the window, ${m.open.length} open now${m.note ? ` (${m.note})` : ""}`);
      for (const mr of m.merged.slice(0, MRS_SHOWN)) {
        const days = (new Date(mr.merged_at) - new Date(mr.created_at)) / 86_400_000;
        out.push(`  !${mr.iid}  merged ${localDate(mr.merged_at)} after ${days.toFixed(1)} days  ${oneLine(mr.title, 90)}`);
      }
      for (const mr of m.open.slice(0, MRS_SHOWN)) out.push(`  !${mr.iid}  open since ${localDate(mr.created_at)}  ${oneLine(mr.title, 90)}`);
    }
    if (none.length) out.push(`no merge requests by you: ${none.map((m) => short(m.repo)).join(", ")}`);
    if (skipped.length) out.push(`not checked: ${skipped.map((m) => `${short(m.repo)} (${m.skipped})`).join(", ")}`);
  }

  if (data.jira) {
    const j = data.jira;
    out.push("", `JIRA (${j.projects.join(", ")}; tickets mentioned in the window)`);
    if (j.tickets.length) {
      out.push(
        table(j.tickets.slice(0, TICKETS_SHOWN), [
          { label: "key", key: "key" },
          { label: "type", get: (t) => t.type ?? "-", max: 12 },
          { label: "status", get: (t) => (t.found ? t.status : "(unknown)"), max: 16 },
          { label: "sessions", get: (t) => int(t.sessions), right: true },
          { label: "you", get: (t) => hours(t.user_s), right: true },
          { label: "agent", get: (t) => hours(t.agent_s), right: true },
          { label: "cost", get: (t) => money(t.cost), right: true },
          { label: "summary", get: (t) => t.summary ?? "", max: 60 },
        ]),
      );
      if (j.tickets.length > TICKETS_SHOWN) out.push(`(+${j.tickets.length - TICKETS_SHOWN} more tickets; --json has all)`);
      out.push("(time and cost are those sessions' in-window totals; a session that mentions several tickets counts toward each)");
    } else out.push("no ticket mentions in this window");
    const keys = (rows) => (rows == null ? "unavailable" : `${rows.length}${rows.length ? `: ${rows.map((r) => r.key).join(", ")}` : ""}`);
    out.push(
      `your tickets resolved in the window (assigned to you, resolved by anyone): ${keys(j.assigned_resolved)}`,
      `tickets you closed in the window (you set the resolution, any assignee): ${keys(j.closed_by_you)}`,
      `tickets you created in the window: ${keys(j.created_by_you)}`,
    );
  }

  if (data.notes.length) out.push("", "NOTES", ...data.notes.map((n) => `- ${n}`));
  return out.join("\n");
}

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      repo: { type: "string" },
      "max-repos": { type: "string", default: "10" },
      "no-glab": { type: "boolean", default: false },
      "no-jira": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const corpus = openCorpus();
  const w = resolveWindow(corpus, values, { defaultSince: "30d" });
  prepareScope(corpus.db, w, values.repo);

  const worked = all(
    corpus.db,
    `SELECT s.repo, coalesce(sum(a.user_s + a.agent_s), 0) active FROM sessions s
     LEFT JOIN active_time a ON a.ref = s.ref AND a.hour >= $H AND a.hour < $U
     WHERE s.ref IN (SELECT ref FROM act) GROUP BY s.repo ORDER BY active DESC`,
    { H: w.H, U: w.U },
  )
    .map((r) => r.repo)
    .filter(Boolean);
  const notes = [];
  // A directory that is gone may have held commits (unknown, not checked); one
  // that exists outside git cannot (nothing to check). Both are named.
  const gone = worked.filter((repo) => !existsSync(repo));
  const notGit = worked.filter((repo) => existsSync(repo) && !existsSync(join(repo, ".git")));
  if (gone.length) notes.push(`${gone.length} worked-in directories no longer exist, so their commits are unknown: ${gone.map(short).join(", ")}`);
  if (notGit.length) notes.push(`${notGit.length} worked-in directories are not git checkouts: ${notGit.map(short).join(", ")}`);
  const repos = worked.filter((repo) => existsSync(join(repo, ".git")));
  const maxRepos = Number(values["max-repos"]);
  if (!Number.isInteger(maxRepos) || maxRepos < 1) throw new PissError("--max-repos must be a positive whole number");
  if (repos.length > maxRepos) notes.push(`${repos.length - maxRepos} more repos not checked (--max-repos)`);
  const checked = repos.slice(0, maxRepos);

  const data = {
    window: { since: w.S, until: w.U },
    repos_not_checked: repos.length - checked.length + gone.length,
    git: checked.map((repo) => gitOutcomes(repo, w)),
    notes,
  };

  if (!values["no-glab"]) {
    if (onPath("glab")) {
      const users = new Map();
      data.merge_requests = checked.map((repo) => glabOutcomes(repo, w, users));
    } else notes.push("glab is not installed: no merge requests");
  }
  if (!values["no-jira"]) {
    const projects = corpus.coverage.jira_projects ?? [];
    if (!projects.length) notes.push("no Jira project configured when the corpus was built: no tickets");
    else if (!onPath("jira")) notes.push("the jira CLI is not installed: no ticket status");
    else {
      data.jira = jiraOutcomes(corpus.db, w, projects);
      notes.push(...data.jira.notes);
    }
  }

  if (values.json) {
    const coverage = { warnings: coverageWarnings(corpus.coverage) };
    console.log(JSON.stringify({ corpus: { ...corpus.meta, ...coverage }, ...data }, null, 2));
  } else console.log(render(data, corpus, w));
  return 0;
}
