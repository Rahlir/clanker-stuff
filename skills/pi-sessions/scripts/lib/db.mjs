// The corpus database. Column meanings are documented in references/data-model.md.

import { renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Bump when the schema or a metric definition changes, so query commands
// refuse a corpus whose numbers were computed differently.
export const SCHEMA_VERSION = 9;

const TABLES = {
  sessions: [
    "ref",
    "id",
    "path",
    "cwd",
    "repo",
    "name",
    "parent_path",
    "created",
    "last_activity",
    "first_prompt",
    "first_template",
    "first_skill",
    "version",
    "lines",
    "malformed_lines",
    "entries",
    "abandoned_entries",
    "inherited_entries",
  ],
  usage_events: [
    "ref",
    "entry_id",
    "ts",
    "source",
    "tool",
    "provider",
    "model",
    "provider_source",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "cost_recorded",
    "cost_corrected",
    "correction",
    "on_active_branch",
  ],
  turns: [
    "ref",
    "entry_id",
    "ts",
    "provider",
    "model",
    "thinking_level",
    "stop_reason",
    "error",
    "duration_ms",
    "text_chars",
    "tool_calls",
    "on_active_branch",
  ],
  prompts: [
    "ref",
    "entry_id",
    "ts",
    "template",
    "skill",
    "template_match",
    "args",
    "text",
    "has_images",
    "gap_before_s",
    "on_active_branch",
  ],
  tool_calls: [
    "ref",
    "call_id",
    "entry_id",
    "ts",
    "name",
    "key_arg",
    "args_json",
    "args_chars",
    "result_entry_id",
    "result_ts",
    "is_error",
    "result_text",
    "result_chars",
    "duration_ms",
    "on_active_branch",
  ],
  events: ["ref", "entry_id", "ts", "type", "subtype", "payload_json", "payload_chars", "on_active_branch"],
  active_time: ["ref", "hour", "user_s", "agent_s"],
  ticket_mentions: ["ref", "key", "source", "entry_id", "ts", "count"],
  inherited: ["ref", "entry_id", "ts"],
  fts: ["text", "ref", "entry_id", "kind", "ts"],
};

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE coverage (metric TEXT PRIMARY KEY, value TEXT);
CREATE TABLE sessions (
  ref TEXT PRIMARY KEY, id TEXT, path TEXT, cwd TEXT, repo TEXT, name TEXT, parent_path TEXT,
  created TEXT, last_activity TEXT, first_prompt TEXT, first_template TEXT, first_skill TEXT,
  version INTEGER, lines INTEGER, malformed_lines INTEGER, entries INTEGER, abandoned_entries INTEGER,
  inherited_entries INTEGER
);
CREATE TABLE usage_events (
  ref TEXT, entry_id TEXT, ts TEXT, source TEXT, tool TEXT, provider TEXT, model TEXT, provider_source TEXT,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost_recorded REAL, cost_corrected REAL, correction TEXT, on_active_branch INTEGER
);
CREATE TABLE turns (
  ref TEXT, entry_id TEXT, ts TEXT, provider TEXT, model TEXT, thinking_level TEXT, stop_reason TEXT,
  error TEXT, duration_ms INTEGER, text_chars INTEGER, tool_calls INTEGER, on_active_branch INTEGER
);
CREATE TABLE prompts (
  ref TEXT, entry_id TEXT, ts TEXT, template TEXT, skill TEXT, template_match TEXT, args TEXT, text TEXT,
  has_images INTEGER, gap_before_s REAL, on_active_branch INTEGER
);
CREATE TABLE tool_calls (
  ref TEXT, call_id TEXT, entry_id TEXT, ts TEXT, name TEXT, key_arg TEXT, args_json TEXT, args_chars INTEGER,
  result_entry_id TEXT, result_ts TEXT, is_error INTEGER, result_text TEXT, result_chars INTEGER,
  duration_ms INTEGER, on_active_branch INTEGER
);
CREATE TABLE events (
  ref TEXT, entry_id TEXT, ts TEXT, type TEXT, subtype TEXT, payload_json TEXT, payload_chars INTEGER,
  on_active_branch INTEGER
);
CREATE TABLE active_time (ref TEXT, hour TEXT, user_s REAL, agent_s REAL, PRIMARY KEY (ref, hour));
CREATE TABLE ticket_mentions (
  ref TEXT, key TEXT, source TEXT, entry_id TEXT, ts TEXT, count INTEGER, PRIMARY KEY (ref, key, source, entry_id)
);
CREATE TABLE inherited (ref TEXT, entry_id TEXT, ts TEXT);
CREATE VIRTUAL TABLE fts USING fts5(text, ref UNINDEXED, entry_id UNINDEXED, kind UNINDEXED, ts UNINDEXED);
`;

const INDEXES = `
CREATE INDEX usage_events_ts ON usage_events (ts);
CREATE INDEX usage_events_ref ON usage_events (ref);
CREATE INDEX turns_ref ON turns (ref);
CREATE INDEX turns_ts ON turns (ts);
CREATE INDEX prompts_ref ON prompts (ref);
CREATE INDEX prompts_ts ON prompts (ts);
CREATE INDEX tool_calls_ref ON tool_calls (ref);
CREATE INDEX tool_calls_name ON tool_calls (name);
CREATE INDEX tool_calls_ts ON tool_calls (ts);
CREATE INDEX tool_calls_result_ts ON tool_calls (result_ts);
CREATE INDEX events_ref ON events (ref);
CREATE INDEX events_ts ON events (ts);
CREATE INDEX events_type ON events (type, subtype);
CREATE INDEX active_time_hour ON active_time (hour);
CREATE INDEX ticket_mentions_key ON ticket_mentions (key);
CREATE INDEX ticket_mentions_ts ON ticket_mentions (ts);
CREATE INDEX sessions_repo ON sessions (repo);
CREATE INDEX inherited_ref ON inherited (ref);
`;

const toSql = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

/**
 * Write a fresh corpus to a temp file and move it over `path` on `commit()`,
 * so a failed build or a concurrent reader never sees a half-written corpus.
 */
export function createCorpus(path) {
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
  db.exec(SCHEMA);
  const statements = Object.fromEntries(
    Object.entries(TABLES).map(([table, cols]) => [
      table,
      { cols, stmt: db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`) },
    ]),
  );
  db.exec("BEGIN");

  return {
    insert(table, rows) {
      const { cols, stmt } = statements[table];
      for (const row of Array.isArray(rows) ? rows : [rows]) stmt.run(...cols.map((c) => toSql(row[c])));
    },
    commit({ meta, coverage }) {
      const kv = (table, key) => db.prepare(`INSERT INTO ${table} (${key}, value) VALUES (?, ?)`);
      const metaStmt = kv("meta", "key");
      for (const [k, v] of Object.entries(meta)) metaStmt.run(k, typeof v === "string" ? v : JSON.stringify(v));
      const coverageStmt = kv("coverage", "metric");
      for (const [k, v] of Object.entries(coverage)) coverageStmt.run(k, JSON.stringify(v));
      db.exec("COMMIT");
      db.exec(INDEXES);
      db.close();
      renameSync(tmp, path);
    },
    abort() {
      try {
        db.close();
      } catch {
        // already closed by a commit that failed later
      }
      rmSync(tmp, { force: true });
    },
  };
}
