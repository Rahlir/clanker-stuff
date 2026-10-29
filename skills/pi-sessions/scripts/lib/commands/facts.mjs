import { parseArgs } from "node:util";
import { heading, hours, int, localStamp, money, pct, shortPath, table } from "../format.mjs";
import {
  ACTIVITY,
  all,
  coverageWarnings,
  headerLines,
  one,
  openCorpus,
  prepareScope,
  previousWindow,
  resolveWindow,
} from "../query.mjs";

export const summary = "Canonical usage numbers for a window: models, repos, weeks, templates, tools, reviews, tags.";

export const usage = `piss facts [options]

The standard tables, computed the same way every time (see
references/metrics.md). Tables are capped; use piss sql for the rest.

  --since <time>     start of the window (default 30d)
  --until <time>     end of the window (default now; built: the corpus's end)
  --repo TEXT        only sessions whose repo or cwd contains TEXT
  --compare          add the previous window of the same length
  --json             print everything as JSON, including per-day and
                     weekday x hour series for charts`;

// Spend buckets: the main agent's own turns, code_review reviewers, other
// tools that report nested usage, and the rest (summaries, cache warming).
const BUCKET = `CASE WHEN source = 'assistant' THEN 'main'
  WHEN tool GLOB 'code_review*' THEN 'reviews'
  WHEN source IN ('tool_result', 'review_legacy') THEN 'tools'
  ELSE 'other' END`;

const IN_WINDOW = "ts >= $S AND ts < $U AND ref IN (SELECT ref FROM scope)";
const HOURS_IN_WINDOW = "hour >= $H AND hour < $U AND ref IN (SELECT ref FROM scope)";
// Whole-session labels; `from_entry` segments are reserved for later.
const TAG_JOIN = "LEFT JOIN session_tags t ON t.ref = a.ref AND t.from_entry IS NULL";
const WEEK = (col) => `date(${col}, 'localtime', 'weekday 0', '-6 days')`;

const modelKey = (r) => `${r.provider ?? "?"}/${r.model ?? "?"}`;

function costBuckets(rows) {
  const out = { main: 0, reviews: 0, tools: 0, other: 0, total: 0, recorded: 0 };
  for (const r of rows) {
    out[r.bucket] += r.cost ?? 0;
    out.total += r.cost ?? 0;
    out.recorded += r.recorded ?? 0;
  }
  return out;
}

/** Every number `facts` reports for one window, as plain data. */
export function computeFacts(db, w, repo) {
  prepareScope(db, w, repo);
  const p = { S: w.S, U: w.U, H: w.H };
  const q = (sql) => all(db, sql, p);
  const q1 = (sql) => one(db, sql, p);

  const prompts = q1(`SELECT count(*) n, sum(template IS NOT NULL) templates, sum(skill IS NOT NULL) skills
    FROM prompts WHERE ${IN_WINDOW}`);
  const turns = q1(`SELECT count(*) n, sum(stop_reason IN ('error', 'aborted')) failed FROM turns WHERE ${IN_WINDOW}`);
  const tools = q1(`SELECT count(*) n, sum(is_error = 1) errors FROM tool_calls WHERE ${IN_WINDOW}`);
  const active = q1(`SELECT coalesce(sum(user_s), 0) user_s, coalesce(sum(agent_s), 0) agent_s FROM active_time WHERE ${HOURS_IN_WINDOW}`);
  const cost = costBuckets(
    q(`SELECT ${BUCKET} bucket, sum(cost_corrected) cost, sum(cost_recorded) recorded FROM usage_events
       WHERE ${IN_WINDOW} GROUP BY bucket`),
  );
  const sessions = q1(`SELECT count(*) n,
      sum(created >= $S AND created < $U) started,
      count(DISTINCT repo) repos,
      sum(abandoned_entries > 0) with_abandoned
    FROM sessions WHERE ref IN (SELECT ref FROM act)`);
  const structure = q1(`SELECT sum(type = 'compaction') compactions, sum(type = 'branch_summary') branch_summaries
    FROM events WHERE ${IN_WINDOW}`);

  const overview = {
    sessions: sessions.n,
    sessions_started: sessions.started ?? 0,
    repos: sessions.repos,
    prompts: prompts.n,
    template_prompts: prompts.templates ?? 0,
    skill_prompts: prompts.skills ?? 0,
    turns: turns.n,
    failed_turns: turns.failed ?? 0,
    tool_calls: tools.n,
    tool_errors: tools.errors ?? 0,
    user_s: active.user_s,
    agent_s: active.agent_s,
    cost,
    compactions: structure.compactions ?? 0,
    branch_summaries: structure.branch_summaries ?? 0,
    sessions_with_abandoned_branches: sessions.with_abandoned ?? 0,
  };

  const models = new Map();
  const model = (key) => {
    if (!models.has(key)) models.set(key, { model: key, turns: 0, main: 0, reviews: 0, tools: 0, other: 0, total: 0, thinking: {} });
    return models.get(key);
  };
  for (const r of q(`SELECT provider, model, ${BUCKET} bucket, sum(cost_corrected) cost FROM usage_events
      WHERE ${IN_WINDOW} GROUP BY provider, model, bucket`)) {
    const m = model(modelKey(r));
    m[r.bucket] += r.cost ?? 0;
    m.total += r.cost ?? 0;
  }
  for (const r of q(`SELECT provider, model, coalesce(thinking_level, '-') level, count(*) n FROM turns
      WHERE ${IN_WINDOW} GROUP BY provider, model, level`)) {
    const m = model(modelKey(r));
    m.turns += r.n;
    m.thinking[r.level] = r.n;
  }

  const repos = new Map();
  const repoRow = (key) => {
    if (!repos.has(key)) repos.set(key, { repo: key, sessions: 0, prompts: 0, user_s: 0, agent_s: 0, cost: 0 });
    return repos.get(key);
  };
  for (const r of q("SELECT repo, count(*) n FROM sessions WHERE ref IN (SELECT ref FROM act) GROUP BY repo")) repoRow(r.repo).sessions = r.n;
  for (const r of q(`SELECT s.repo, count(*) n FROM prompts p JOIN sessions s USING (ref)
      WHERE p.ts >= $S AND p.ts < $U AND p.ref IN (SELECT ref FROM scope) GROUP BY s.repo`)) repoRow(r.repo).prompts = r.n;
  for (const r of q(`SELECT s.repo, sum(a.user_s) user_s, sum(a.agent_s) agent_s FROM active_time a JOIN sessions s USING (ref)
      WHERE a.hour >= $H AND a.hour < $U AND a.ref IN (SELECT ref FROM scope) GROUP BY s.repo`)) {
    Object.assign(repoRow(r.repo), { user_s: r.user_s, agent_s: r.agent_s });
  }
  for (const r of q(`SELECT s.repo, sum(u.cost_corrected) cost FROM usage_events u JOIN sessions s USING (ref)
      WHERE u.ts >= $S AND u.ts < $U AND u.ref IN (SELECT ref FROM scope) GROUP BY s.repo`)) repoRow(r.repo).cost = r.cost ?? 0;

  const modelRepo = q(`SELECT s.repo, u.provider, u.model, sum(u.cost_corrected) cost FROM usage_events u JOIN sessions s USING (ref)
      WHERE u.ts >= $S AND u.ts < $U AND u.ref IN (SELECT ref FROM scope)
      GROUP BY s.repo, u.provider, u.model ORDER BY cost DESC`).map((r) => ({ repo: r.repo, model: modelKey(r), cost: r.cost ?? 0 }));

  const series = (unit) => {
    const key = unit === "week" ? WEEK : (col) => `date(${col}, 'localtime')`;
    const out = new Map();
    const slot = (k) => {
      if (!out.has(k)) out.set(k, { [unit]: k, sessions: 0, prompts: 0, user_s: 0, agent_s: 0, cost: 0 });
      return out.get(k);
    };
    for (const r of q(`SELECT ${key("ts")} k, count(DISTINCT ref) n FROM (${ACTIVITY}) WHERE ${IN_WINDOW} GROUP BY k`)) slot(r.k).sessions = r.n;
    for (const r of q(`SELECT ${key("ts")} k, count(*) n FROM prompts WHERE ${IN_WINDOW} GROUP BY k`)) slot(r.k).prompts = r.n;
    for (const r of q(`SELECT ${key("hour")} k, sum(user_s) u, sum(agent_s) a FROM active_time WHERE ${HOURS_IN_WINDOW} GROUP BY k`)) {
      Object.assign(slot(r.k), { user_s: r.u, agent_s: r.a });
    }
    for (const r of q(`SELECT ${key("ts")} k, sum(cost_corrected) c FROM usage_events WHERE ${IN_WINDOW} GROUP BY k`)) slot(r.k).cost = r.c ?? 0;
    return [...out.values()].sort((a, b) => (a[unit] < b[unit] ? -1 : 1));
  };

  const heatmap = q(`SELECT CAST(strftime('%w', hour, 'localtime') AS INTEGER) weekday, CAST(strftime('%H', hour, 'localtime') AS INTEGER) hour,
      sum(user_s) user_s, sum(agent_s) agent_s FROM active_time WHERE ${HOURS_IN_WINDOW} GROUP BY weekday, hour ORDER BY weekday, hour`);

  const templates = q(`SELECT coalesce(template, CASE WHEN skill IS NOT NULL THEN 'skill:' || skill END, '(free text)') name,
      count(*) prompts, count(DISTINCT ref) sessions FROM prompts WHERE ${IN_WINDOW} GROUP BY name ORDER BY prompts DESC`);

  const toolRows = q(`SELECT name, count(*) calls, sum(is_error = 1) errors, avg(duration_ms) avg_ms FROM tool_calls
      WHERE ${IN_WINDOW} GROUP BY name ORDER BY calls DESC`);

  // The agent loads a skill by reading its SKILL.md; explicit /skill: prompts are rare.
  const skillLoads = new Map();
  for (const r of q(`SELECT ref, key_arg FROM tool_calls WHERE name = 'read' AND key_arg GLOB '*SKILL.md' AND ${IN_WINDOW}`)) {
    const skill = r.key_arg.split("/").at(-2) ?? r.key_arg;
    const s = skillLoads.get(skill) ?? { skill, loads: 0, refs: new Set() };
    s.loads++;
    s.refs.add(r.ref);
    skillLoads.set(skill, s);
  }
  const skillsLoaded = [...skillLoads.values()]
    .map((s) => ({ skill: s.skill, loads: s.loads, sessions: s.refs.size }))
    .sort((a, b) => b.sessions - a.sessions || b.loads - a.loads);

  const reviews = q(`SELECT provider, model, count(*) receipts, sum(source = 'review_legacy') legacy, sum(cost_corrected) cost
      FROM usage_events WHERE tool GLOB 'code_review*' AND ${IN_WINDOW} GROUP BY provider, model ORDER BY cost DESC`).map((r) => ({
    model: modelKey(r),
    receipts: r.receipts,
    legacy: r.legacy,
    cost: r.cost ?? 0,
  }));

  const tagged = q(`SELECT coalesce(t.tag, '(untagged)') tag, count(*) sessions FROM act a ${TAG_JOIN} GROUP BY 1`);
  const tags = tagged.some((t) => t.tag !== "(untagged)")
    ? tagged.map((t) => {
        const filter = t.tag === "(untagged)" ? "t.tag IS NULL" : "t.tag = $tag";
        const params = { ...p, tag: t.tag };
        const time = one(
          db,
          `SELECT coalesce(sum(a.user_s), 0) user_s, coalesce(sum(a.agent_s), 0) agent_s FROM active_time a ${TAG_JOIN}
           WHERE a.hour >= $H AND a.hour < $U AND a.ref IN (SELECT ref FROM act) AND ${filter}`,
          params,
        );
        const spend = one(
          db,
          `SELECT coalesce(sum(a.cost_corrected), 0) cost FROM usage_events a ${TAG_JOIN}
           WHERE a.ts >= $S AND a.ts < $U AND a.ref IN (SELECT ref FROM act) AND ${filter}`,
          params,
        );
        return { tag: t.tag, sessions: t.sessions, ...time, cost: spend.cost };
      })
    : [];

  return {
    window: { since: w.S, until: w.U, days: w.days },
    repo_filter: repo ?? null,
    overview,
    models: [...models.values()].sort((a, b) => b.total - a.total),
    repos: [...repos.values()].sort((a, b) => b.user_s + b.agent_s - (a.user_s + a.agent_s) || b.cost - a.cost),
    model_repo: modelRepo,
    weeks: series("week"),
    days: series("day"),
    heatmap,
    templates,
    skills_loaded: skillsLoaded,
    tools: toolRows,
    reviews,
    tags: tags.sort((a, b) => b.sessions - a.sessions),
  };
}

function topThinking(thinking, turns) {
  return Object.entries(thinking)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([level, n]) => `${level} ${pct(n, turns)}`)
    .join(", ");
}

function capped(rows, limit) {
  return { shown: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

const moreLine = (n, what) => (n ? `(+${n} more ${what}; see piss facts --json or piss sql)` : null);

function renderText(f, prev) {
  const o = f.overview;
  const out = [];
  const overviewRows = [
    ["sessions active", int(o.sessions), `${int(o.sessions_started)} started in window`, prev && int(prev.overview.sessions)],
    ["repos", int(o.repos), "", prev && int(prev.overview.repos)],
    [
      "prompts",
      int(o.prompts),
      `${int(o.template_prompts)} from templates, ${int(o.skill_prompts)} skill invocations`,
      prev && int(prev.overview.prompts),
    ],
    ["assistant turns", int(o.turns), `${int(o.failed_turns)} ended in error or abort`, prev && int(prev.overview.turns)],
    ["tool calls", int(o.tool_calls), `${pct(o.tool_errors, o.tool_calls)} errors`, prev && int(prev.overview.tool_calls)],
    ["active time, you", hours(o.user_s), "time leading to your next prompt (breaks of 30 min+ excluded)", prev && hours(prev.overview.user_s)],
    ["active time, agent", hours(o.agent_s), "time leading to the next agent turn or tool result", prev && hours(prev.overview.agent_s)],
    [
      "cost, corrected",
      money(o.cost.total),
      `recorded ${money(o.cost.recorded)}; main ${money(o.cost.main)}, reviews ${money(o.cost.reviews)}, tools ${money(o.cost.tools)}, other ${money(o.cost.other)}`,
      prev && money(prev.overview.cost.total),
    ],
    [
      "session structure",
      `${int(o.compactions)} / ${int(o.branch_summaries)}`,
      `compactions / branch summaries; ${int(o.sessions_with_abandoned_branches)} sessions with abandoned branches`,
      prev && `${int(prev.overview.compactions)} / ${int(prev.overview.branch_summaries)}`,
    ],
  ];
  out.push(heading("overview"));
  out.push(
    table(
      overviewRows.map(([metric, value, note, before]) => ({ metric, value, before, note })),
      [
        { label: "metric", key: "metric" },
        { label: "window", key: "value", right: true },
        ...(prev ? [{ label: "previous", key: "before", right: true }] : []),
        { label: "", key: "note", max: 110 },
      ],
    ),
  );

  const prevModels = new Map((prev?.models ?? []).map((m) => [m.model, m]));
  const models = capped(f.models, 15);
  out.push(heading("models (all spend, corrected)"));
  out.push(
    table(models.shown, [
      { label: "model", key: "model", max: 44 },
      { label: "turns", get: (m) => int(m.turns), right: true },
      { label: "main", get: (m) => money(m.main), right: true },
      { label: "reviews", get: (m) => money(m.reviews), right: true },
      { label: "tools", get: (m) => money(m.tools), right: true },
      { label: "other", get: (m) => money(m.other), right: true },
      { label: "total", get: (m) => money(m.total), right: true },
      { label: "share", get: (m) => pct(m.total, o.cost.total), right: true },
      ...(prev ? [{ label: "previous", get: (m) => money(prevModels.get(m.model)?.total ?? 0), right: true }] : []),
      { label: "thinking", get: (m) => topThinking(m.thinking, m.turns), max: 30 },
    ]),
  );
  out.push(moreLine(models.more, "models"));

  const prevRepos = new Map((prev?.repos ?? []).map((r) => [r.repo, r]));
  const repos = capped(f.repos, 15);
  out.push(heading("repos (by active time)"));
  out.push(
    table(repos.shown, [
      { label: "repo", get: (r) => shortPath(r.repo, 52), max: 52 },
      { label: "sessions", get: (r) => int(r.sessions), right: true },
      { label: "prompts", get: (r) => int(r.prompts), right: true },
      { label: "you", get: (r) => hours(r.user_s), right: true },
      { label: "agent", get: (r) => hours(r.agent_s), right: true },
      { label: "cost", get: (r) => money(r.cost), right: true },
      { label: "share", get: (r) => pct(r.cost, o.cost.total), right: true },
      ...(prev
        ? [
            {
              label: "previous",
              get: (r) => {
                const b = prevRepos.get(r.repo);
                return b ? `${hours(b.user_s + b.agent_s)}, ${money(b.cost)}` : "-";
              },
              right: true,
            },
          ]
        : []),
    ]),
  );
  out.push(moreLine(repos.more, "repos"));

  const pairs = capped(f.model_repo, 12);
  out.push(heading("model x repo (top spend)"));
  out.push(
    table(pairs.shown, [
      { label: "repo", get: (r) => shortPath(r.repo, 52), max: 52 },
      { label: "model", key: "model", max: 44 },
      { label: "cost", get: (r) => money(r.cost), right: true },
    ]),
  );
  out.push(moreLine(pairs.more, "pairs"));

  const earlier = Math.max(0, f.weeks.length - 26);
  out.push(heading("weeks (starting monday)"));
  if (earlier) out.push(`(${earlier} earlier weeks not shown; see piss facts --json)`);
  out.push(
    table(f.weeks.slice(earlier), [
      { label: "week", key: "week" },
      { label: "sessions", get: (r) => int(r.sessions), right: true },
      { label: "prompts", get: (r) => int(r.prompts), right: true },
      { label: "you", get: (r) => hours(r.user_s), right: true },
      { label: "agent", get: (r) => hours(r.agent_s), right: true },
      { label: "cost", get: (r) => money(r.cost), right: true },
    ]),
  );

  const templates = capped(f.templates, 15);
  out.push(heading("templates and skills"));
  out.push(
    table(templates.shown, [
      { label: "invoked as", key: "name", max: 40 },
      { label: "prompts", get: (r) => int(r.prompts), right: true },
      { label: "sessions", get: (r) => int(r.sessions), right: true },
    ]),
  );
  out.push(moreLine(templates.more, "templates"));

  const skills = capped(f.skills_loaded, 15);
  out.push(heading("skills loaded by the agent (reads of SKILL.md)"));
  out.push(
    skills.shown.length
      ? table(skills.shown, [
          { label: "skill", key: "skill", max: 40 },
          { label: "sessions", get: (r) => int(r.sessions), right: true },
          { label: "loads", get: (r) => int(r.loads), right: true },
        ])
      : "none",
  );
  out.push(moreLine(skills.more, "skills"));

  const tools = capped(f.tools, 15);
  out.push(heading("tools"));
  out.push(
    table(tools.shown, [
      { label: "tool", key: "name", max: 32 },
      { label: "calls", get: (r) => int(r.calls), right: true },
      { label: "errors", get: (r) => int(r.errors ?? 0), right: true },
      { label: "error rate", get: (r) => pct(r.errors ?? 0, r.calls), right: true },
      { label: "avg time", get: (r) => (r.avg_ms == null ? "-" : `${(r.avg_ms / 1000).toFixed(1)} s`), right: true },
    ]),
  );
  out.push(moreLine(tools.more, "tools"));

  const reviewers = capped(f.reviews, 15);
  if (reviewers.shown.length) {
    out.push(heading("code_review reviewers"));
    out.push(
      table(reviewers.shown, [
        { label: "reviewer", key: "model", max: 44 },
        { label: "receipts", get: (r) => int(r.receipts), right: true },
        { label: "legacy", get: (r) => int(r.legacy), right: true },
        { label: "cost", get: (r) => money(r.cost), right: true },
      ]),
    );
    out.push(moreLine(reviewers.more, "reviewers"));
  }

  const tags = capped(f.tags, 20);
  out.push(heading("tags"));
  if (tags.shown.length) {
    out.push(
      table(tags.shown, [
        { label: "tag", key: "tag", max: 32 },
        { label: "sessions", get: (r) => int(r.sessions), right: true },
        { label: "you", get: (r) => hours(r.user_s), right: true },
        { label: "agent", get: (r) => hours(r.agent_s), right: true },
        { label: "cost", get: (r) => money(r.cost), right: true },
      ]),
    );
    out.push(moreLine(tags.more, "tags"));
  } else {
    out.push("no sessions in this window are tagged yet (piss tag --untagged lists them)");
  }
  return out.filter((l) => l != null).join("\n");
}

/**
 * What `piss facts --json` prints: corpus facts and coverage warnings, the
 * window's facts, and with `compare` the previous window's. Shared with the
 * report renderer so its charts use exactly these numbers.
 */
export function factsDocument(corpus, w, { repo, compare = false } = {}) {
  const facts = computeFacts(corpus.db, w, repo);
  const previous = compare ? computeFacts(corpus.db, previousWindow(corpus, w), repo) : undefined;
  return { corpus: { ...corpus.meta, warnings: coverageWarnings(corpus.coverage) }, ...facts, previous };
}

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      repo: { type: "string" },
      compare: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const corpus = openCorpus();
  const w = resolveWindow(corpus, values, { defaultSince: "30d" });
  if (values.json) {
    console.log(JSON.stringify(factsDocument(corpus, w, { repo: values.repo, compare: values.compare }), null, 2));
    return 0;
  }
  const prevWindow = values.compare ? previousWindow(corpus, w) : null;
  const facts = computeFacts(corpus.db, w, values.repo);
  const prev = prevWindow ? computeFacts(corpus.db, prevWindow, values.repo) : null;
  const lines = headerLines(corpus, w);
  if (prevWindow) lines.push(`previous ${localStamp(prevWindow.S)} to ${localStamp(prevWindow.U)}`);
  if (values.repo) lines.push(`repo     sessions whose repo or cwd contains "${values.repo}"`);
  console.log(`${lines.join("\n")}\n${renderText(facts, prev)}`);
  return 0;
}
