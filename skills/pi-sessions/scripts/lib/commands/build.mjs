import { parseArgs } from "node:util";
import { build } from "../build.mjs";
import { parseWhen } from "../core.mjs";
import { localStamp, short } from "../format.mjs";
import { PissError } from "../load.mjs";

export const summary = "Read the sessions active in a time range into the corpus.";

export const usage = `piss build [options]

Rebuild the corpus every other command reads. A session is loaded when it was
active in the range; all of its entries are stored. The build replaces the
corpus it writes: give a long analysis its own with --corpus PATH.

  --since <time>        start of the range (default 90d, counted back from --until;
                        all for everything)
  --until <time>        end of the range (default now)
  --corpus PATH         write this corpus instead of the shared one (also PISS_CORPUS)
  --include-self        keep the session running this command
  --jira-project KEYS   ticket projects to detect, comma separated
                        (default: project.key in the jira CLI config)`;

function counts(obj, limit = 8) {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, limit).map(([k, v]) => `${k} ${v}`);
  if (entries.length > limit) shown.push(`+${entries.length - limit} more`);
  return shown.join(", ") || "none";
}

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string", default: "90d" },
      until: { type: "string", default: "now" },
      "include-self": { type: "boolean", default: false },
      "jira-project": { type: "string" },
    },
    strict: true,
  });
  const now = new Date();
  const when = (value) => {
    try {
      return parseWhen(value, now);
    } catch (err) {
      throw new PissError(err.message);
    }
  };
  const until = when(values.until);
  // Relative ranges count back from --until, as on the query commands.
  let since;
  try {
    since = parseWhen(values.since, until);
  } catch (err) {
    throw new PissError(err.message);
  }
  if (since >= until) throw new PissError(`--since (${since.toISOString()}) must be before --until (${until.toISOString()})`);

  const r = await build({
    since,
    until,
    openEnded: values.until === "now",
    includeSelf: values["include-self"],
    jiraProject: values["jira-project"],
  });
  const c = r.coverage;
  const rows = c.rows;
  const lines = [
    `corpus   ${short(r.path)}  (${r.seconds.toFixed(1)} s, pi ${r.meta.pi_version}, ${r.meta.timezone})`,
    `range    ${localStamp(r.meta.since)} to ${localStamp(r.meta.until)}`,
    `files    ${c.files_on_disk} on disk, ${c.files_listed} listed by pi, ${c.files_in_range} active in range, ${c.files_loaded} loaded` +
      (c.self_excluded ? ", 1 excluded (this session)" : "") +
      (c.files_without_created_time ? `, ${c.files_without_created_time} without a readable start time (refs Sx...)` : ""),
    `lines    ${c.lines} read, ${c.malformed_lines} malformed, ${c.missing_final_newline} files without final newline, ` +
      `${c.entries_inherited} fork or clone copies counted in another session`,
    `entries  ${counts(c.entry_types)}`,
    `rows     ${rows.sessions ?? 0} sessions, ${rows.prompts ?? 0} prompts, ${rows.turns ?? 0} turns, ${rows.tool_calls ?? 0} tool calls, ` +
      `${rows.usage_events ?? 0} usage events, ${rows.events ?? 0} other events, ${rows.ticket_mentions ?? 0} ticket mentions`,
    `pricing  ${counts(c.corrections_applied)} corrected; providers inferred for ${c.providers_inferred} usage rows; ` +
      `${c.repeated_review_receipts} repeated review receipts skipped`,
    `inputs   ${c.templates.count} prompt templates (${c.templates.versions} versions) from ${c.templates.dirs.length} dirs` +
      (c.templates.skipped.length ? ` (skipped packages: ${c.templates.skipped.join(", ")})` : "") +
      `; jira projects: ${c.jira_projects.join(", ") || "none"}`,
  ];
  for (const f of c.files_failed.slice(0, 3)) lines.push(`failed   ${short(f.path)}: ${f.reason}`);
  for (const p of c.files_not_listed.slice(0, 3)) lines.push(`unlisted ${short(p)}`);
  lines.push(r.warnings.length ? `status   WARN: ${r.warnings.join("; ")}` : "status   ok");
  console.log(lines.join("\n"));
  return 0;
}
