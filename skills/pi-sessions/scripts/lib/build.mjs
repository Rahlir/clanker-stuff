// `piss build`: read the sessions active in a range into a fresh corpus.

import { mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { assignRefs, createCopyLedger, extractSession, GAP_CAP_MS, inferProvider, priceUsage } from "./core.mjs";
import {
  corpusPath,
  jiraProjects,
  loadCorrections,
  loadInteractiveTools,
  loadPromptPatterns,
  loadTemplates,
} from "./config.mjs";
import { SCHEMA_VERSION, createCorpus } from "./db.mjs";
import { createRepoResolver, loadPi, readSessionFile, scanSessionFiles } from "./load.mjs";
import { coverageWarnings } from "./query.mjs";

const realpathOrNull = (p) => {
  try {
    return p ? realpathSync(p) : null;
  } catch {
    return null;
  }
};

const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

const mtimeMs = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Build the corpus and return its coverage report. A session is loaded when it
 * may have work in [since, until): created before `until`, and its last user
 * or assistant message (pi's `modified`) or its file's last write at or after
 * `since`. The file time catches sessions resumed only for `!` commands,
 * summaries or other usage, which pi's `modified` ignores. All of a loaded
 * session's entries are stored; commands filter by timestamp. Sessions are
 * processed oldest first so fork and clone copies count once (see
 * createCopyLedger).
 */
export async function build({ since, until, openEnded = true, includeSelf = false, jiraProject }) {
  const started = performance.now();
  const { pi, version } = await loadPi();
  const agentDir = pi.getAgentDir();
  const root = join(agentDir, "sessions");

  const listed = await pi.SessionManager.listAll();
  const { files: onDisk, unreadable } = scanSessionFiles(root);
  const listedPaths = new Set(listed.map((s) => s.path));
  const refs = assignRefs(listed);

  const selfPath = includeSelf ? null : realpathOrNull(process.env.PI_SESSION_FILE);
  // A header timestamp that does not parse leaves the creation date unknown;
  // such sessions are kept on their activity alone rather than dropped. They
  // sort first, which the copy ledger tolerates: without a creation date it
  // never treats their entries as copies.
  const createdMs = (s) => s.created.getTime();
  const inRange = listed
    .filter((s) => !(createdMs(s) >= until.getTime()) && (s.modified >= since || mtimeMs(s.path) >= since.getTime()))
    .sort((a, b) => (createdMs(a) || 0) - (createdMs(b) || 0) || (a.path < b.path ? -1 : 1));

  const templates = loadTemplates(agentDir);
  const projects = jiraProjects(jiraProject);
  const corrections = loadCorrections();
  const repoOf = createRepoResolver();
  const ctx = {
    templates: templates.templates,
    patterns: loadPromptPatterns(),
    interactiveTools: loadInteractiveTools(),
    parseSkillBlock: pi.parseSkillBlock,
    jiraProjects: projects,
  };

  const cov = {
    files_on_disk: onDisk.length,
    files_listed: listed.length,
    files_not_listed: onDisk.filter((p) => !listedPaths.has(p)),
    dirs_unreadable: unreadable,
    files_in_range: inRange.length,
    files_without_created_time: inRange.filter((s) => Number.isNaN(createdMs(s))).length,
    files_loaded: 0,
    files_failed: [],
    self_excluded: null,
    self_excluded_ref: null,
    lines: 0,
    malformed_lines: 0,
    missing_final_newline: 0,
    orphan_tool_results: 0,
    repeated_review_receipts: 0,
    late_review_receipts: 0,
    entries_without_time: 0,
    usage_without_cost: 0,
    usage_without_model: 0,
    entries_inherited: 0,
    entry_types: new Map(),
    unknown_types: new Map(),
    versions: new Map(),
    rows: new Map(),
    providers_inferred: 0,
    providers_unknown: 0,
    corrections_applied: new Map(),
  };

  // The corpus may be a private one (--corpus) in a run dir not made yet.
  mkdirSync(dirname(corpusPath()), { recursive: true });
  const corpus = createCorpus(corpusPath());
  const tally = new Map();
  const pending = [];
  const copies = createCopyLedger();
  const insertUsage = (row) => {
    const priced = priceUsage(row, corrections);
    if (priced.correction) bump(cov.corrections_applied, priced.correction);
    corpus.insert("usage_events", priced);
  };

  try {
    for (const s of inRange) {
      if (selfPath && realpathOrNull(s.path) === selfPath) {
        cov.self_excluded = s.path;
        cov.self_excluded_ref = refs.get(s.path) ?? null;
        continue;
      }
      let read;
      let rows;
      try {
        read = readSessionFile(pi, s.path);
        if (read.error) throw new Error(read.error);
        rows = extractSession(
          { ...read, path: s.path, ref: refs.get(s.path) },
          { ...ctx, repo: repoOf(read.header.cwd), skipCopy: copies.skipFor(read.header) },
        );
        copies.record(read.entries, rows.inherited);
      } catch (err) {
        cov.files_failed.push({ path: s.path, reason: String(err?.message ?? err).slice(0, 300) });
        continue;
      }

      cov.files_loaded++;
      cov.lines += read.lines;
      cov.malformed_lines += read.malformed;
      if (read.missingFinalNewline) cov.missing_final_newline++;
      cov.orphan_tool_results += rows.stats.orphanResults;
      cov.repeated_review_receipts += rows.stats.repeatedReceipts;
      cov.late_review_receipts += rows.stats.lateReceipts;
      cov.entries_inherited += rows.inherited.length;
      bump(cov.versions, String(read.version));
      for (const [t, n] of rows.stats.types) bump(cov.entry_types, t, n);
      for (const [t, n] of rows.stats.unknown) bump(cov.unknown_types, t, n);
      for (const [model, provider] of rows.stats.modelProviders) {
        if (!provider) continue;
        if (!tally.has(model)) tally.set(model, new Map());
        bump(tally.get(model), provider);
      }

      corpus.insert("sessions", rows.session);
      for (const [table, list] of [
        ["turns", rows.turns],
        ["prompts", rows.prompts],
        ["tool_calls", rows.toolCalls],
        ["events", rows.events],
        ["active_time", rows.activeTime],
        ["ticket_mentions", rows.tickets],
        ["inherited", rows.inherited],
        ["fts", rows.fts],
      ]) {
        corpus.insert(table, list);
        bump(cov.rows, table, list.length);
      }
      bump(cov.rows, "sessions");
      bump(cov.rows, "usage_events", rows.usage.length);
      cov.entries_without_time += rows.stats.badTimestamps;
      for (const row of rows.usage) {
        // Kept, so the tokens still count, but reported: spend with no recorded
        // cost adds $0, and spend with no model cannot be attributed.
        if (row.recorded == null) cov.usage_without_cost++;
        if (!row.provider && !row.model) cov.usage_without_model++;
        if (!row.provider && row.model) pending.push(row);
        else insertUsage(row);
      }
    }

    for (const row of pending) {
      const provider = inferProvider(row.model, tally);
      if (provider) cov.providers_inferred++;
      else cov.providers_unknown++;
      insertUsage({ ...row, provider, provider_source: provider ? "inferred" : null });
    }

    const coverage = {
      ...cov,
      entry_types: Object.fromEntries(cov.entry_types),
      unknown_types: Object.fromEntries(cov.unknown_types),
      versions: Object.fromEntries(cov.versions),
      rows: Object.fromEntries(cov.rows),
      corrections_applied: Object.fromEntries(cov.corrections_applied),
      templates: {
        count: templates.names.length,
        versions: templates.templates.length,
        dirs: templates.dirs,
        skipped: templates.skipped,
      },
      jira_projects: projects,
    };
    const meta = {
      schema_version: String(SCHEMA_VERSION),
      built_at: new Date().toISOString(),
      since: since.toISOString(),
      until: until.toISOString(),
      // Built up to "now": later activity is merely missing, not out of range.
      open_ended: openEnded ? "1" : "0",
      pi_version: version ?? "",
      sessions_root: root,
      // Reports built from this corpus leave out the session that built it;
      // record which, so their numbers can be reproduced.
      excluded_session: cov.self_excluded_ref ?? "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
      gap_cap_s: String(GAP_CAP_MS / 1000),
    };
    corpus.commit({ meta, coverage });
    const seconds = (performance.now() - started) / 1000;
    return { path: corpusPath(), meta, coverage, seconds, warnings: coverageWarnings(coverage) };
  } catch (err) {
    corpus.abort();
    throw err;
  }
}
