#!/usr/bin/env node
// history - what earlier pi usage reports said, for the next report.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { localStamp } from "../../pi-sessions/scripts/lib/format.mjs";
import { beforeDate, htmlExcerpt, leftOutLine, listReports, localDay, sidecarSummary } from "./lib/history.mjs";
import { htmlToText } from "./lib/publish.mjs";

const USAGE = `history.mjs [options]

Earlier reports, newest first. Reports with a sidecar JSON (published by
render.mjs, or backfilled) list every recommendation with the id to follow it
up by, such as 2026-10-13#give-investigations-an-exit; older ones show their
outline and the text of their recommendation sections. Reports dated on or
after --date are left out: a report from the same day is the one the new
report replaces, so render.mjs does not count it as earlier either.

  --last N      how many reports to show (default 3)
  --full NAME   print one earlier report's whole text (cut at 60000 characters)
  --date DATE   the new report's date, YYYY-MM-DD (default today), as for render.mjs
  --dir DIR     where reports live (default ~/.pi/agent/sessions)`;

const { values } = parseArgs({
  options: {
    last: { type: "string", default: "3" },
    full: { type: "string" },
    date: { type: "string" },
    dir: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const dir = values.dir ?? join(agentDir, "sessions");
const date = values.date ?? localDay();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("history: --date must be YYYY-MM-DD");
  process.exit(1);
}
const { earlier: reports, hidden } = beforeDate(existsSync(dir) ? listReports(readdirSync(dir)) : [], date);

if (values.full) {
  const file = join(dir, values.full);
  if (hidden.some((r) => r.name === values.full)) {
    console.error(`history: ${values.full} is dated ${date} or later, so it is not an earlier report`);
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`history: no report ${file}`);
    process.exit(1);
  }
  const text = htmlToText(readFileSync(file, "utf8"));
  console.log(text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (+${text.length - 60_000} chars)` : text);
  process.exit(0);
}

const last = Number(values.last);
if (!Number.isInteger(last) || last < 1) {
  console.error("history: --last must be a positive whole number");
  process.exit(1);
}
const out = [
  `${reports.length} reports before ${date} in ${dir.replace(homedir(), "~")}${reports.length ? `: ${reports.map((r) => r.date ?? r.name).join(", ")}` : ""}`,
  ...hidden.map((r) => {
    let sidecar = null;
    try {
      sidecar = JSON.parse(readFileSync(join(dir, r.name.replace(/\.html$/, ".json")), "utf8"));
    } catch {
      // No readable sidecar: the line falls back to the file's time.
    }
    const written = sidecar?.generated_at ?? statSync(join(dir, r.name)).mtime.toISOString();
    return leftOutLine(r.name, { sidecar, writtenAt: localStamp(written), replaced: r.name === `pi-session-report-${date}.html` });
  }),
];
for (const r of reports.slice(0, last)) {
  const sidecarFile = join(dir, r.name.replace(/\.html$/, ".json"));
  let sidecar = null;
  let problem = "no sidecar";
  if (existsSync(sidecarFile)) {
    try {
      sidecar = JSON.parse(readFileSync(sidecarFile, "utf8"));
      if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) {
        sidecar = null;
        problem = "sidecar is not a JSON object";
      }
    } catch (err) {
      problem = `sidecar unreadable (${err.message})`;
    }
  }
  if (sidecar) {
    out.push("", `== ${r.name} (${sidecar.backfilled ? "sidecar, backfilled" : "sidecar"})`, ...sidecarSummary(sidecar, r.key ?? sidecar.date));
    continue;
  }
  try {
    out.push("", `== ${r.name} (${problem}; text excerpt, --full for everything)`, ...htmlExcerpt(readFileSync(join(dir, r.name), "utf8")));
  } catch (err) {
    out.push("", `== ${r.name} (unreadable: ${err.message})`);
  }
}
console.log(out.join("\n"));
