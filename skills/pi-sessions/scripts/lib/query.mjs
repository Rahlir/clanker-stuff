// Opening the corpus and resolving the time window every query command uses.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { corpusPath, tagsPath } from "./config.mjs";
import { parseWhen } from "./core.mjs";
import { SCHEMA_VERSION } from "./db.mjs";
import { age, localStamp } from "./format.mjs";
import { PissError } from "./load.mjs";

const STALE_MS = 6 * 3_600_000;

// Tags are keyed by pi's session id, which never changes; refs can (see
// assignRefs). `from_entry` is reserved for labeling part of a session (from
// that entry on); null labels the whole session, the only kind written today.
export const TAGS_SCHEMA =
  "session_id TEXT NOT NULL, from_entry TEXT, tag TEXT NOT NULL, note TEXT, tagged_at TEXT NOT NULL, tagged_by TEXT";
export const TAGS_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS tags_segment ON tags (session_id, ifnull(from_entry, ''))";

/**
 * (ref, ts) of every piece of work, as core.mjs defines it for active time:
 * prompts, assistant turns, tool results, `!` shell commands and summaries.
 * Housekeeping is left out because reopening or renaming an old session
 * writes it too, and so are pi's usage entries: a cache warming ping in an
 * idle session is spend, not activity.
 */
export const ACTIVITY = `SELECT ref, ts FROM prompts UNION ALL SELECT ref, ts FROM turns
  UNION ALL SELECT ref, result_ts AS ts FROM tool_calls WHERE result_ts IS NOT NULL
  UNION ALL SELECT ref, ts FROM usage_events WHERE source NOT LIKE 'usage:%'
  UNION ALL SELECT ref, ts FROM events WHERE (type = 'message' AND subtype IN ('bashExecution', 'toolResult'))
    OR type IN ('compaction', 'branch_summary')`;

/**
 * Open the corpus read-only, with the agent's session tags attached as
 * `tags` (an empty view when none exist yet, so writes fail like everywhere
 * else) and the temp view `session_tags` mapping them to refs.
 */
export function openCorpus() {
  const path = corpusPath();
  if (!existsSync(path)) throw new PissError(`no corpus at ${path}: run piss build`);
  const db = new DatabaseSync(path, { readOnly: true });
  registerRegexp(db);
  const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
  if (meta.schema_version !== String(SCHEMA_VERSION)) {
    throw new PissError("the corpus was built by a different piss version: run piss build");
  }
  const coverage = Object.fromEntries(
    db
      .prepare("SELECT metric, value FROM coverage")
      .all()
      .map((r) => [r.metric, JSON.parse(r.value)]),
  );
  if (existsSync(tagsPath())) db.prepare("ATTACH DATABASE ? AS tagsdb").run(tagsPath());
  else {
    db.exec(`CREATE TEMP VIEW tags AS SELECT NULL AS session_id, NULL AS from_entry, NULL AS tag, NULL AS note,
      NULL AS tagged_at, NULL AS tagged_by WHERE 0`);
  }
  db.exec(`CREATE TEMP VIEW session_tags AS
    SELECT s.ref, t.session_id, t.from_entry, t.tag, t.note, t.tagged_at, t.tagged_by
    FROM tags t JOIN sessions s ON s.id = t.session_id`);
  return { db, meta, coverage };
}

/** Coverage problems worth a WARN: anything that means data was skipped or not understood. */
export function coverageWarnings(coverage) {
  const out = [];
  if (coverage.files_not_listed?.length) out.push(`${coverage.files_not_listed.length} session files not listed by pi`);
  if (coverage.files_failed?.length) out.push(`${coverage.files_failed.length} session files failed to load`);
  if (coverage.dirs_unreadable?.length) out.push(`${coverage.dirs_unreadable.length} session directories could not be read`);
  if (coverage.orphan_tool_results) out.push(`${coverage.orphan_tool_results} tool results without their call (kept as events)`);
  if (coverage.malformed_lines) out.push(`${coverage.malformed_lines} malformed lines skipped`);
  const unknown = Object.entries(coverage.unknown_types ?? {});
  if (unknown.length) out.push(`unknown entry types: ${unknown.map(([t, n]) => `${t} (${n})`).join(", ")}`);
  if (coverage.providers_unknown) out.push(`${coverage.providers_unknown} usage rows with no provider`);
  if (coverage.usage_without_model) out.push(`${coverage.usage_without_model} usage rows with neither provider nor model`);
  if (coverage.usage_without_cost) out.push(`${coverage.usage_without_cost} usage rows with no recorded cost (counted as $0)`);
  if (coverage.entries_without_time) out.push(`${coverage.entries_without_time} entries without a readable timestamp (outside every window)`);
  const skipped = coverage.templates?.skipped ?? [];
  if (skipped.length) out.push(`prompt packages not found, so their templates read as free text: ${skipped.join(", ")}`);
  if (coverage.late_review_receipts) {
    out.push(
      `${coverage.late_review_receipts} code_review results after the 20 Oct usage fix carry reviewer spend only in details ` +
        "(an extension loaded before the fix); that spend is not counted",
    );
  }
  return out;
}

const buildSince = (date) => (date.getTime() === 0 ? "all" : localStamp(date.toISOString()).slice(0, 10));

/**
 * `x REGEXP 'pattern'` with JavaScript syntax; a leading (?i) makes it
 * case-insensitive, since JavaScript has no inline flags. SQLite ships no
 * regexp function of its own.
 */
export function registerRegexp(db) {
  const compiled = new Map();
  db.function("regexp", { deterministic: true }, (pattern, value) => {
    if (pattern == null || value == null) return 0;
    let re = compiled.get(pattern);
    if (!re) {
      const insensitive = String(pattern).startsWith("(?i)");
      re = new RegExp(insensitive ? String(pattern).slice(4) : String(pattern), insensitive ? "i" : "");
      compiled.set(pattern, re);
    }
    return re.test(String(value)) ? 1 : 0;
  });
}

function when(value, now) {
  try {
    return parseWhen(value, now);
  } catch (err) {
    throw new PissError(err.message);
  }
}

// A build whose range ended when it ran (the default --until now) keeps up
// with time in the sense that later activity is merely missing; a build with
// a historical --until never contains anything after it.
function corpusEnd(meta) {
  const until = Date.parse(meta.until);
  const built = Date.parse(meta.built_at);
  if (Number.isNaN(until) || Number.isNaN(built)) return { end: null, openEnded: true };
  // The build records it; the guess from timing is for metas written without it.
  if (meta.open_ended === "1" || meta.open_ended === "0") return { end: new Date(until), openEnded: meta.open_ended === "1" };
  return { end: new Date(until), openEnded: built - until < 60_000 };
}

/**
 * Resolve --since/--until against the corpus. A window may not start before
 * the corpus range (sessions that ended earlier were never loaded), nor end
 * after a historical build's --until (later sessions were never loaded).
 */
export function resolveWindow(corpus, { since, until }, { defaultSince } = {}) {
  const now = new Date();
  const corpusSince = new Date(corpus.meta.since);
  const { end: corpusUntil, openEnded } = corpusEnd(corpus.meta);
  // "built" is the end of the corpus's range: every command given
  // --since 30d --until built sees the same 30 days, however long apart they run.
  let end;
  if (until === "built") end = corpusUntil ?? new Date(corpus.meta.built_at);
  else end = until ? when(until, now) : openEnded ? now : corpusUntil;
  const from = since ?? defaultSince;
  // A relative start counts back from the window's end, not from now.
  const start = from ? when(from, end) : corpusSince;
  if (!openEnded && end > corpusUntil) {
    throw new PissError(
      `the window ends ${localStamp(end.toISOString())}, after the corpus (built up to ${localStamp(corpusUntil.toISOString())}): ` +
        `pass an earlier --until or rebuild with piss build`,
    );
  }
  if (start < corpusSince) {
    throw new PissError(
      `the window starts ${localStamp(start.toISOString())}, before the corpus (sessions active since ${localStamp(corpus.meta.since)}): ` +
        `rebuild with piss build --since ${buildSince(start)}`,
    );
  }
  if (start >= end) throw new PissError("--since must be before --until");
  return window(start, end);
}

export function window(start, end) {
  return {
    since: start,
    until: end,
    S: start.toISOString(),
    U: end.toISOString(),
    // First hourly active-time bucket in the window: a bucket belongs to the
    // window containing its start, so adjacent windows (--compare) never share
    // or skip one.
    H: new Date(Math.ceil(start.getTime() / 3_600_000) * 3_600_000).toISOString(),
    days: (end - start) / 86_400_000,
  };
}

const sameWallClock = (a, b) =>
  a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes() && a.getSeconds() === b.getSeconds() && a.getMilliseconds() === b.getMilliseconds();

/**
 * The window right before `w`, of the same length. A window of whole local
 * days (30d, or two dates) steps back in calendar days, as parseWhen counts
 * them: across a daylight-saving change such a window is an hour off 30 x 24 h,
 * and subtracting its length would start an hour outside a --since 60d corpus.
 */
export function previousWindow(corpus, w) {
  const start = new Date(w.since);
  if (sameWallClock(w.since, w.until)) start.setDate(start.getDate() - Math.round((w.until - w.since) / 86_400_000));
  else start.setTime(w.since.getTime() - (w.until - w.since));
  if (start < new Date(corpus.meta.since)) {
    throw new PissError(
      `--compare needs sessions from ${localStamp(start.toISOString())}: rebuild with piss build --since ${buildSince(start)}`,
    );
  }
  return window(start, w.since);
}

/** First lines of every query command: how fresh and complete the corpus is, and the window. */
export function headerLines(corpus, w) {
  const { meta, coverage } = corpus;
  const built = new Date(meta.built_at);
  const warnings = coverageWarnings(coverage);
  const stale = Date.now() - built > STALE_MS ? " (stale: rerun piss build)" : "";
  const everything = Date.parse(meta.since) === 0;
  const lines = [
    `corpus   built ${localStamp(meta.built_at)} (${age(Date.now() - built)})${stale}, ` +
      `${everything ? "all sessions" : `sessions active since ${localStamp(meta.since)}`}, ` +
      `coverage ${warnings.length ? `WARN: ${warnings.join("; ")}` : "ok"}`,
  ];
  if (w) {
    const days = w.days >= 1 ? `${Math.round(w.days * 10) / 10} days` : `${Math.round(w.days * 24)} h`;
    const { end } = corpusEnd(meta);
    const missing = w.until - (end ?? built) > 10 * 60_000 ? "; activity after the build is not in the corpus" : "";
    const span = w.since.getTime() === 0 ? `all history to ${localStamp(w.U)}` : `${localStamp(w.S)} to ${localStamp(w.U)} (${days})`;
    lines.push(`window   ${span}${missing}`);
  }
  return lines;
}

/**
 * Create temp tables `scope` (sessions matching the repo filter) and `act`
 * (scope sessions with work in the window, see ACTIVITY). Queries join
 * against them.
 */
export function prepareScope(db, w, repo) {
  db.exec("DROP TABLE IF EXISTS temp.scope; DROP TABLE IF EXISTS temp.act;");
  db.prepare(
    `CREATE TEMP TABLE scope AS SELECT ref FROM sessions
     WHERE $repo IS NULL OR instr(lower(repo), lower($repo)) > 0 OR instr(lower(cwd), lower($repo)) > 0`,
  ).run({ repo: repo ?? null });
  db.prepare(
    `CREATE TEMP TABLE act AS SELECT DISTINCT ref FROM (${ACTIVITY})
     WHERE ts >= $S AND ts < $U AND ref IN (SELECT ref FROM scope)`,
  ).run({ S: w.S, U: w.U });
}

// node:sqlite rejects named parameters a statement does not use, so bind only
// the ones the SQL mentions.
function bind(sql, params) {
  const names = new Set([...sql.matchAll(/\$(\w+)/g)].map((m) => m[1]));
  return Object.fromEntries(Object.entries(params).filter(([k]) => names.has(k)));
}

export const all = (db, sql, params = {}) => db.prepare(sql).all(bind(sql, params));
export const one = (db, sql, params = {}) => db.prepare(sql).get(bind(sql, params));

/** Resolve a ref, a session id prefix, or a session file path to a sessions row. */
export function findSession(db, key) {
  const exact = db.prepare("SELECT * FROM sessions WHERE ref = ? OR path = ?").get(key, key);
  if (exact) return exact;
  const byId = db.prepare("SELECT * FROM sessions WHERE id LIKE ? || '%' LIMIT 2").all(key);
  if (byId.length > 1) throw new PissError(`"${key}" matches more than one session id; use more characters or the ref`);
  return byId[0] ?? null;
}
