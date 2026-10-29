import { parseArgs } from "node:util";
import { localStamp, oneLine, short } from "../format.mjs";
import { PissError } from "../load.mjs";
import { all, headerLines, openCorpus, prepareScope, resolveWindow } from "../query.mjs";

export const summary = "Full-text search over prompts, agent text and session names, ranked by session.";

export const usage = `piss find <words...> [options]

Finds sessions by what was said in them. Every word must appear (in any one
prompt, agent message or session name); punctuation is ignored, so
voucherpro-engine matches the two words in sequence. Tool output is not
searched; use piss sql on tool_calls for that.

  --any             match any word instead of all
  --raw             pass the query to SQLite FTS5 unchanged (OR, NEAR, prefix*)
  --kind KIND       only prompt, assistant, or name text
  --since <time>    start of the window (default: whole corpus)
  --until <time>    end of the window (default now; built: the corpus's end)
  --repo TEXT       only sessions whose repo or cwd contains TEXT
  --limit N         at most N sessions (default 20)`;

const quote = (word) => `"${word.replaceAll('"', '""')}"`;

const KIND_LABEL = { prompt: "you", assistant: "agent", name: "name" };

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      any: { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
      kind: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      repo: { type: "string" },
      limit: { type: "string", default: "20" },
    },
    strict: true,
  });
  if (!positionals.length) throw new PissError("find needs something to search for");
  if (values.kind && !KIND_LABEL[values.kind]) throw new PissError("--kind must be prompt, assistant, or name");
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new PissError("--limit must be a positive whole number");

  const words = positionals.join(" ").split(/\s+/).filter(Boolean);
  const match = values.raw ? positionals.join(" ") : words.map(quote).join(values.any ? " OR " : " ");

  const corpus = openCorpus();
  const w = resolveWindow(corpus, values);
  prepareScope(corpus.db, w, values.repo);
  const where = "fts MATCH $match AND ($kind IS NULL OR kind = $kind) AND ts >= $S AND ts < $U";
  const params = { match, kind: values.kind ?? null, S: w.S, U: w.U };
  let matched;
  let ranked;
  try {
    // Every matching session with its full hit count, so the totals hold for
    // any search; snippets are fetched only for the sessions shown. The CTE is
    // materialized because bm25() cannot run inside an aggregate.
    matched = all(
      corpus.db,
      `WITH h AS MATERIALIZED (SELECT ref, bm25(fts) score FROM fts WHERE ${where} AND ref IN (SELECT ref FROM scope))
       SELECT ref, count(*) n, min(score) best FROM h GROUP BY ref ORDER BY best`,
      params,
    );
    const snippets = corpus.db.prepare(
      `SELECT kind, entry_id, ts, snippet(fts, 0, '«', '»', ' … ', 14) snip, bm25(fts) score FROM fts
       WHERE ${where} AND ref = $ref ORDER BY score LIMIT 2`,
    );
    ranked = matched.slice(0, limit).map((s) => ({ ref: s.ref, count: s.n, hits: snippets.all({ ...params, ref: s.ref }) }));
  } catch (err) {
    throw new PissError(`search failed (${err.message})${values.raw ? "; check the FTS5 syntax or drop --raw" : ""}`);
  }
  const refs = ranked.map((s) => s.ref);
  const info = new Map(
    refs.length
      ? corpus.db
          .prepare(`SELECT ref, created, repo, name, first_prompt FROM sessions WHERE ref IN (${refs.map(() => "?").join(",")})`)
          .all(...refs)
          .map((r) => [r.ref, r])
      : [],
  );

  const out = headerLines(corpus, w);
  out.push(`search   ${match}`);
  for (const s of ranked) {
    const meta = info.get(s.ref) ?? {};
    out.push(
      "",
      `${s.ref}  ${localStamp(meta.created)}  ${short(meta.repo)}  ${s.count} hit${s.count === 1 ? "" : "s"}`,
      `  ${meta.name ? `"${meta.name}"` : oneLine(meta.first_prompt ?? "", 140)}`,
    );
    for (const h of s.hits) {
      out.push(`  ${KIND_LABEL[h.kind].padEnd(5)} ${localStamp(h.ts).slice(5)}  ${oneLine(h.snip, 220)}  (--entry ${h.entry_id ?? "-"})`);
    }
  }
  out.push(
    "",
    matched.length
      ? `${matched.length} session${matched.length === 1 ? "" : "s"} matched${matched.length > limit ? `, showing the best ${limit} (--limit for more)` : ""}; open one with piss show <ref>`
      : "no matches",
  );
  console.log(out.join("\n"));
  return 0;
}
