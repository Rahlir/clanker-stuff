import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { corpusPath, stateDir, tagsPath } from "./config.mjs";
import { extractSession, parseLines, parseWhen, priceUsage } from "./core.mjs";
import { createCorpus, SCHEMA_VERSION } from "./db.mjs";
import { coverageWarnings, openCorpus, prepareScope, previousWindow, TAGS_INDEX, TAGS_SCHEMA, window } from "./query.mjs";

process.env.TZ = "UTC";

const dir = mkdtempSync(join(tmpdir(), "piss-test-"));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_STATE_HOME = join(dir, "state");
after(() => rmSync(dir, { recursive: true, force: true }));

// A real corpus file built from fixtures, so the SQL that decides which
// sessions count as active runs against the actual schema.
function corpusOf(names, path = join(dir, `${names.join("-")}.db`)) {
  const corpus = createCorpus(path);
  for (const name of names) {
    const parsed = parseLines(readFileSync(fileURLToPath(new URL(`../fixtures/${name}.jsonl`, import.meta.url)), "utf8"));
    const [header, ...entries] = parsed.entries;
    const rows = extractSession({ ...parsed, header, entries, activeIds: new Set(entries.map((e) => e.id)), ref: name, path: name }, {
      jiraProjects: ["HSCTR"],
    });
    corpus.insert("sessions", rows.session);
    corpus.insert("usage_events", rows.usage.map((u) => priceUsage(u)));
    corpus.insert("turns", rows.turns);
    corpus.insert("prompts", rows.prompts);
    corpus.insert("tool_calls", rows.toolCalls);
    corpus.insert("events", rows.events);
    corpus.insert("active_time", rows.activeTime);
    corpus.insert("ticket_mentions", rows.tickets);
  }
  corpus.commit({ meta: { schema_version: String(SCHEMA_VERSION) }, coverage: {} });
  return new DatabaseSync(path, { readOnly: true });
}

const activeIn = (db, since, until) => {
  prepareScope(db, window(new Date(since), new Date(until)), null);
  return db
    .prepare("SELECT ref FROM act ORDER BY ref")
    .all()
    .map((r) => r.ref);
};

test("tags are keyed by session id and reach queries through their current ref", () => {
  mkdirSync(join(dir, "cache", "pi-clanker", "pi-sessions"), { recursive: true });
  corpusOf(["resume", "basic"], corpusPath());
  mkdirSync(stateDir(), { recursive: true });
  const tags = new DatabaseSync(tagsPath());
  tags.exec(`CREATE TABLE tags (${TAGS_SCHEMA}); ${TAGS_INDEX};`);
  tags.prepare("INSERT INTO tags (session_id, tag, tagged_at) VALUES (?, ?, ?)").run("0199aaaa-0000-7000-8000-000000000007", "ops", "2026-10-20");
  tags.close();
  const { db } = openCorpus();
  assert.deepEqual(
    db
      .prepare("SELECT ref, tag FROM session_tags")
      .all()
      .map((r) => [r.ref, r.tag]),
    [["resume", "ops"]],
  );
});

test("PISS_CORPUS selects the corpus, and SQL gets a REGEXP function", () => {
  const own = join(dir, "own-corpus.db");
  corpusOf(["basic"], own);
  process.env.PISS_CORPUS = own;
  try {
    assert.equal(corpusPath(), own);
    const { db } = openCorpus();
    const match = (pattern) => db.prepare("SELECT count(*) n FROM prompts WHERE text REGEXP ?").get(pattern).n;
    assert.equal(match("HSCTR-\\d+"), 3);
    assert.equal(match("^review the staged"), 0);
    assert.equal(match("(?i)^review the staged"), 1);
    assert.throws(() => match("("), /Invalid regular expression/);
  } finally {
    delete process.env.PISS_CORPUS;
  }
});

test("cache warming pings alone do not make a session active", () => {
  const db = corpusOf(["cachewarm"]);
  // 10:21 to 11:00 holds only pings; the answer at 10:20:30 and the prompt at
  // 11:05 are outside it.
  assert.deepEqual(activeIn(db, "2026-10-20T10:21:00Z", "2026-10-20T11:00:00Z"), []);
  assert.deepEqual(activeIn(db, "2026-10-20T10:00:00Z", "2026-10-20T10:01:00Z"), ["cachewarm"]);
});

test("a session is active only in windows where it did work", () => {
  const db = corpusOf(["resume", "basic"]);
  assert.deepEqual(activeIn(db, "2026-09-01", "2026-09-02"), ["resume"]);
  // The reopen on 2026-10-01 08:00 only re-injected memory, switched models
  // and renamed the session; basic did real work that morning.
  assert.deepEqual(activeIn(db, "2026-10-01T07:00:00Z", "2026-10-01T09:00:00Z"), ["basic"]);
  assert.deepEqual(activeIn(db, "2026-10-01T07:59:00Z", "2026-10-01T08:00:20Z"), []);
});

test("the previous window steps back in calendar days, so a 60d corpus covers it across a DST change", () => {
  process.env.TZ = "Europe/Prague";
  try {
    // Clocks went back on 25 Oct 2026: the 30 days before 5 Nov are 721 h long.
    const until = new Date(2026, 10, 5, 17, 31);
    const since = parseWhen("30d", until);
    const corpus = { meta: { since: parseWhen("60d", until).toISOString() } };
    const prev = previousWindow(corpus, window(since, until));
    assert.equal(prev.since.toISOString(), corpus.meta.since);
    assert.equal(prev.until.getTime(), since.getTime());
    // Windows that are not whole days still step back by their length.
    const hours = previousWindow(corpus, window(new Date(until - 12 * 3_600_000), until));
    assert.equal(hours.until - hours.since, 12 * 3_600_000);
  } finally {
    process.env.TZ = "UTC";
  }
});

test("coverage warns about spend it keeps but cannot fully read, and about templates it could not load", () => {
  assert.deepEqual(
    coverageWarnings({
      usage_without_model: 1,
      usage_without_cost: 2,
      entries_without_time: 3,
      late_review_receipts: 0,
      templates: { skipped: ["npm:@x/prompts"] },
    }),
    [
      "1 usage rows with neither provider nor model",
      "2 usage rows with no recorded cost (counted as $0)",
      "3 entries without a readable timestamp (outside every window)",
      "prompt packages not found, so their templates read as free text: npm:@x/prompts",
    ],
  );
});
