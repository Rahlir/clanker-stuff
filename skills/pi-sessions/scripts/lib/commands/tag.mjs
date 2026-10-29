import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { stateDir, tagsPath } from "../config.mjs";
import { int, localStamp, oneLine, short, shortPath, table } from "../format.mjs";
import { PissError } from "../load.mjs";
import { all, headerLines, openCorpus, prepareScope, resolveWindow, TAGS_INDEX, TAGS_SCHEMA } from "../query.mjs";
import { displayText } from "./prompts.mjs";

export const summary = "Label sessions by kind of work; labels survive rebuilds and feed facts.";

export const usage = `piss tag <ref> <label> [<ref> <label> ...] [--note TEXT]
piss tag --file FILE
piss tag --untagged [--since <time>] [--repo TEXT]
piss tag --list [--since <time>]
piss tag --clear <ref> [<ref> ...]

One label per session, for the kind of work it was (design, hands-on-build,
team-review, ops, ...). Tagging a session again replaces its label. Reuse the
labels --list shows so months stay comparable. Labels are lowercase words
joined by hyphens. They are stored outside the corpus
(${short(tagsPath())}) so rebuilds keep them.

  --note TEXT        a short reason, stored with each label of this call
  --file FILE        lines of "ref label [note]"; # starts a comment
  --untagged         sessions active in the window that have no label
  --list             labels in use with session counts (in the window with --since)
  --clear            remove the labels of the given sessions
  --since/--until    window for --untagged (default 30d) and --list
  --repo TEXT        only sessions whose repo or cwd contains TEXT`;

const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function openTags() {
  mkdirSync(stateDir(), { recursive: true });
  const db = new DatabaseSync(tagsPath());
  db.exec(`CREATE TABLE IF NOT EXISTS tags (${TAGS_SCHEMA}); ${TAGS_INDEX};`);
  return db;
}

function parsePairs(positionals, note) {
  if (positionals.length % 2) throw new PissError("give sessions and labels in pairs: piss tag <ref> <label> [<ref> <label> ...]");
  const pairs = [];
  for (let i = 0; i < positionals.length; i += 2) pairs.push({ ref: positionals[i], tag: positionals[i + 1], note });
  return pairs;
}

function parseFile(file) {
  const pairs = [];
  for (const [i, raw] of readFileSync(file, "utf8").split("\n").entries()) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [ref, tag, ...note] = line.split(/\s+/);
    if (!tag) throw new PissError(`${file}:${i + 1}: expected "ref label [note]"`);
    pairs.push({ ref, tag, note: note.join(" ") || null });
  }
  return pairs;
}

/** Map refs to pi session ids, failing (before anything is written) on refs the corpus lacks. */
function sessionIds(refs) {
  const corpus = openCorpus();
  const ids = new Map(all(corpus.db, "SELECT ref, id FROM sessions").map((r) => [r.ref, r.id]));
  const unknown = refs.filter((r) => !ids.has(r));
  if (unknown.length) throw new PissError(`not in the corpus, nothing changed: ${unknown.join(", ")}`);
  return ids;
}

function save(pairs) {
  const ids = sessionIds(pairs.map((p) => p.ref));
  const bad = pairs.filter((p) => !LABEL.test(p.tag.toLowerCase())).map((p) => p.tag);
  if (bad.length) throw new PissError(`labels must be lowercase words joined by hyphens, nothing saved: ${bad.join(", ")}`);

  const db = openTags();
  const by = process.env.PI_PROVIDER && process.env.PI_MODEL ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : null;
  const current = db.prepare("SELECT tag FROM tags WHERE session_id = ? AND from_entry IS NULL");
  const remove = db.prepare("DELETE FROM tags WHERE session_id = ? AND from_entry IS NULL");
  const insert = db.prepare(
    "INSERT INTO tags (session_id, from_entry, tag, note, tagged_at, tagged_by) VALUES (?, NULL, ?, ?, ?, ?)",
  );
  const counts = { added: 0, changed: 0, same: 0 };
  db.exec("BEGIN");
  for (const p of pairs) {
    const id = ids.get(p.ref);
    const tag = p.tag.toLowerCase();
    const before = current.get(id)?.tag;
    counts[before == null ? "added" : before === tag ? "same" : "changed"]++;
    remove.run(id);
    insert.run(id, tag, p.note ?? null, new Date().toISOString(), by);
  }
  db.exec("COMMIT");
  db.close();
  console.log(`tagged ${pairs.length} sessions: ${counts.added} new, ${counts.changed} changed, ${counts.same} unchanged`);
}

function list(values) {
  const corpus = openCorpus();
  if (values.since || values.until) {
    const w = resolveWindow(corpus, values);
    prepareScope(corpus.db, w, values.repo);
    const rows = all(
      corpus.db,
      "SELECT coalesce(t.tag, '(untagged)') tag, count(*) sessions FROM act a LEFT JOIN session_tags t ON t.ref = a.ref AND t.from_entry IS NULL GROUP BY 1 ORDER BY sessions DESC",
    );
    console.log([...headerLines(corpus, w), "", table(rows, [{ label: "label", key: "tag" }, { label: "sessions", key: "sessions", right: true }])].join("\n"));
    return;
  }
  const rows = all(
    corpus.db,
    "SELECT tag, count(DISTINCT session_id) sessions, max(tagged_at) last_used FROM tags GROUP BY tag ORDER BY sessions DESC",
  );
  console.log(
    rows.length
      ? table(rows, [
          { label: "label", key: "tag" },
          { label: "sessions", key: "sessions", right: true },
          { label: "last used", get: (r) => localStamp(r.last_used) },
        ])
      : "no labels yet",
  );
}

function untagged(values) {
  const corpus = openCorpus();
  const w = resolveWindow(corpus, values, { defaultSince: "30d" });
  prepareScope(corpus.db, w, values.repo);
  const rows = all(
    corpus.db,
    `SELECT s.ref, s.repo, s.created, s.name,
       (SELECT count(*) FROM prompts p WHERE p.ref = s.ref) prompts,
       p.text, p.template, p.skill, p.template_match, p.args
     FROM sessions s LEFT JOIN prompts p ON p.ref = s.ref AND p.ts = (SELECT min(ts) FROM prompts WHERE ref = s.ref)
     WHERE s.ref IN (SELECT ref FROM act) AND s.id NOT IN (SELECT session_id FROM tags)
     GROUP BY s.ref ORDER BY s.created`,
  );
  const shown = rows.slice(0, 200);
  const out = [...headerLines(corpus, w), ""];
  out.push(
    shown.length
      ? table(shown, [
          { label: "ref", key: "ref" },
          { label: "repo", get: (r) => shortPath(r.repo, 40), max: 40 },
          { label: "prompts", get: (r) => int(r.prompts), right: true },
          { label: "first prompt", get: (r) => (r.name ? `"${r.name}" ` : "") + (r.text == null ? "-" : oneLine(displayText(r), 110)), max: 120 },
        ])
      : "every session in the window has a label",
  );
  if (rows.length > shown.length) out.push(`(+${rows.length - shown.length} more; narrow with --since/--until or --repo)`);
  out.push("", `${rows.length} untagged sessions`);
  console.log(out.join("\n"));
}

function clear(refs) {
  if (!refs.length) throw new PissError("--clear needs the sessions to clear");
  const ids = sessionIds(refs);
  const db = openTags();
  const del = db.prepare("DELETE FROM tags WHERE session_id = ?");
  let n = 0;
  for (const ref of refs) n += Number(del.run(ids.get(ref)).changes);
  db.close();
  console.log(`cleared ${n} labels`);
}

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      note: { type: "string" },
      file: { type: "string" },
      untagged: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      clear: { type: "boolean", default: false },
      since: { type: "string" },
      until: { type: "string" },
      repo: { type: "string" },
    },
    strict: true,
  });
  if (values.list) list(values);
  else if (values.untagged) untagged(values);
  else if (values.clear) clear(positionals);
  else if (values.file) save(parseFile(values.file));
  else if (positionals.length) save(parsePairs(positionals, values.note ?? null));
  else throw new PissError("nothing to do; see piss tag --help");
  return 0;
}
