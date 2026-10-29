# Corpus data model

One SQLite file, rebuilt by `piss build`. Timestamps are UTC ISO strings
(`2026-10-13T10:58:27.475Z`), so string comparison orders them; use
`date(ts, 'localtime')` or `strftime('%H', ts, 'localtime')` for local days and
hours. `text REGEXP 'pattern'` takes JavaScript regex syntax; start the
pattern with `(?i)` for a case-insensitive match. `piss sql` runs one
read-only statement (SELECT, WITH, EXPLAIN, PRAGMA or VALUES) and pages long
results with `--offset`; columns sharing a name get " (2)", " (3)", and BLOBs
print as their size. Every row carries `ref`, the session it belongs to.
`on_active_branch` is 1 for entries on the branch the session ended on and 0
for abandoned ones.

## sessions

| Column | Meaning |
|--------|---------|
| `ref` | Session ref, local creation time `SYYMMDD-HHMM[b..]`, or `Sx` plus the first 8 characters of `id` when the header timestamp does not parse. Stable across rebuilds unless another session from the same minute is deleted (suffixes shift) or the machine's timezone changes; `id` never changes |
| `id`, `path` | pi's session id and JSONL file |
| `cwd`, `repo` | Working directory and its main git checkout (see metrics.md) |
| `name` | Name from `/name`, if any |
| `parent_path` | Session it was forked or cloned from |
| `created`, `last_activity` | Header timestamp, and the latest work entry (see metrics.md; renames and reopens do not move it) |
| `first_prompt`, `first_template`, `first_skill` | Opening prompt (first 500 chars) and how it was sent; for a fork or clone, its first own prompt, after the copied ones |
| `version`, `lines`, `malformed_lines`, `entries`, `abandoned_entries` | File facts |
| `inherited_entries` | Copies of entries another session already counts (forks and clones); they produce no rows here |

## usage_events

One row per thing that cost money; sum `cost_corrected`.

| Column | Meaning |
|--------|---------|
| `entry_id`, `ts` | The entry that recorded the usage |
| `source` | `assistant`, `usage:<kind>`, `compaction`, `branch_summary`, `tool_result`, `review_legacy` |
| `tool` | Tool name for `tool_result` and `review_legacy` rows (e.g. `code_review_await`) |
| `provider`, `model`, `provider_source` | Who answered, and how that was determined |
| `input`, `output`, `cache_read`, `cache_write` | Tokens |
| `cost_recorded`, `cost_corrected`, `correction` | USD as logged, after corrections, and which correction applied |

## turns

One row per assistant message: `provider`, `model`, `thinking_level`,
`stop_reason` (`stop`, `toolUse`, `error`, `aborted`, ...), `error`,
`duration_ms`, `text_chars`, `tool_calls` (count). Cost is in `usage_events`
(`source = 'assistant'`, same `entry_id`).

## prompts

One row per user message.

| Column | Meaning |
|--------|---------|
| `text` | Full text as sent (template bodies included) |
| `template`, `skill` | Template or skill it came from, if any |
| `template_match` | `full`, `prefix` or `pattern` (see metrics.md) |
| `args` | What the user added to a template or skill; null when none or unknown |
| `has_images` | 1 when images were attached |
| `gap_before_s` | Seconds since the previous assistant message |

## tool_calls

One row per tool call, joined with its result.

| Column | Meaning |
|--------|---------|
| `call_id`, `entry_id`, `ts` | The call and the assistant message that made it |
| `name`, `key_arg` | Tool and its most telling argument (command, path, ...), 300 chars |
| `args_json`, `args_chars` | Arguments as JSON (first 64 KB) and full length |
| `result_entry_id`, `result_ts`, `is_error`, `duration_ms` | The result; null when none was recorded |
| `result_text`, `result_chars` | Result text (first 4000 chars) and full length |

## events

Every other entry, so nothing is dropped: `type` (`model_change`,
`thinking_level_change`, `compaction`, `branch_summary`, `custom`,
`custom_message`, `label`, `session_info`, `context_edit`, `usage`,
`message` for system and other roles and for tool results without their call,
and any type piss does not know), `subtype` (model, level, customType, kind,
label, name, target, or role),
`payload_json` (the whole entry, first 8000 chars) and `payload_chars`.
`custom` rows with `subtype = 'mr-review'` hold the mr-review extension's
issue state.

## Other tables

| Table | Rows |
|-------|------|
| `active_time` | `ref`, `hour` (UTC hour start), `user_s`, `agent_s` |
| `inherited` | `ref`, `entry_id`, `ts` of every skipped fork or clone copy (see metrics.md) |
| `ticket_mentions` | One row per entry that mentions a ticket: `ref`, `key`, `source` (`prompt`, `tool_args`, `session_name`), `entry_id`, `ts`, `count` (mentions in that entry) |
| `fts` | FTS5 index over prompts, assistant text and session names: `text`, `ref`, `entry_id`, `kind`, `ts` |
| `tags` | The agent's labels, kept in the state dir and attached on open: `session_id` (pi's id, so a label never moves to another session), `from_entry`, `tag`, `note`, `tagged_at`, `tagged_by`. `from_entry` is null for a whole-session label, the only kind written today; it is reserved for labeling part of a session, so filter on `from_entry IS NULL` |
| `session_tags` | Temp view: `tags` joined to `sessions`, adding `ref`. Use it to join labels to other tables |
| `meta` | Build facts: `built_at`, `since`, `until`, `open_ended` (`1` when built up to now), `pi_version`, `timezone`, `excluded_session`, `schema_version`, ... |
| `coverage` | Build coverage report, JSON values per metric: what was read and what was skipped or only partly understood (`late_review_receipts`, `usage_without_cost`, `usage_without_model`, `entries_without_time`); the query header turns these into WARN lines |

## Examples

```sql
-- Spend per repo and week
SELECT s.repo, date(u.ts, 'localtime', 'weekday 0', '-6 days') week, round(sum(u.cost_corrected), 2) usd
FROM usage_events u JOIN sessions s USING (ref) GROUP BY 1, 2 ORDER BY 2, 3 DESC;

-- Sessions where the agent edited a given file
SELECT DISTINCT ref FROM tool_calls WHERE name IN ('edit', 'write') AND key_arg LIKE '%/review-state.ts';

-- Prompts that mention a phrase, newest first
SELECT ref, ts, snippet(fts, 0, '[', ']', ' ... ', 10) FROM fts
WHERE fts MATCH '"handoff document"' AND kind = 'prompt' ORDER BY ts DESC LIMIT 10;
```
