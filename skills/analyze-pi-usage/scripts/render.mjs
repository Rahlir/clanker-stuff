#!/usr/bin/env node
// render - check a report body and publish it as the pi usage report.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { factsDocument } from "../../pi-sessions/scripts/lib/commands/facts.mjs";
import { localStamp, short } from "../../pi-sessions/scripts/lib/format.mjs";
import { PissError } from "../../pi-sessions/scripts/lib/load.mjs";
import { coverageWarnings, openCorpus, resolveWindow } from "../../pi-sessions/scripts/lib/query.mjs";
import { beforeDate, historyIndex, latestBefore, latestWithoutSidecar, listReports, loadHistory, localDay } from "./lib/history.mjs";
import {
  checkHistory,
  checkOutcomes,
  crossCheck,
  findingsRefs,
  lintBody,
  outcomeCounts,
  resolveCarried,
  SESSION_REF,
  sidecar,
  validateFindings,
} from "./lib/publish.mjs";
import { colophon, renderReport } from "./lib/render.mjs";
import { refInfo } from "./lib/refs.mjs";
import { HERO_CHARTS, REQUIRED_SECTIONS } from "./lib/spec.mjs";

const USAGE = `render.mjs --body FILE --findings FILE [options]

Checks a report body and its findings.json against the corpus, the earlier
reports' sidecars and the report spec, then writes pi-session-report-<date>.html
and its sidecar .json. Any problem is listed and nothing is written.

  --body FILE       the report body (see assets/example-body.html)
  --findings FILE   recommendations, followed-up earlier ones and community finds
                    (see assets/example-findings.json)
  --outcomes FILE   output of piss outcomes --json, for the outcome KPI
  --corpus PATH     the corpus the report was written from (also PISS_CORPUS)
  --since <time>    window start (default 30d, counted back from --until)
  --until <time>    window end (default built: the end of the corpus's range)
  --date DATE       report date, YYYY-MM-DD (default today)
  --out-dir DIR     where to write (default: the sessions directory)
  --check           check only, write nothing
  --force           replace an existing report for that date, once the user agreed`;

const skill = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function readJson(file, what, errors) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${what} (${file}): ${err.message}`);
    return null;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      body: { type: "string" },
      findings: { type: "string" },
      outcomes: { type: "string" },
      corpus: { type: "string" },
      since: { type: "string", default: "30d" },
      until: { type: "string", default: "built" },
      date: { type: "string" },
      "out-dir": { type: "string" },
      check: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.body || !values.findings) throw new PissError("--body and --findings are required (render.mjs --help)");
  const date = values.date ?? localDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PissError("--date must be YYYY-MM-DD");

  if (values.corpus) process.env.PISS_CORPUS = values.corpus;
  const corpus = openCorpus();
  const w = resolveWindow(corpus, { since: values.since, until: values.until });
  let facts;
  let note = null;
  try {
    facts = factsDocument(corpus, w, { compare: true });
  } catch (err) {
    if (!(err instanceof PissError)) throw err;
    facts = factsDocument(corpus, w);
    note = `no change against the previous window on the KPI cards: ${err.message}`;
  }

  const errors = [];
  const body = readFileSync(values.body, "utf8");
  const findings = readJson(values.findings, "findings", errors) ?? {};
  const outcomes = values.outcomes ? readJson(values.outcomes, "outcomes", errors) : null;
  const required = REQUIRED_SECTIONS.map((s) => s.id);

  errors.push(...lintBody(body, REQUIRED_SECTIONS, { heroCharts: HERO_CHARTS }), ...validateFindings(findings), ...crossCheck(body, findings));
  errors.push(...checkOutcomes(outcomes, facts.window));

  // Earlier reports live where this one will be written. An unreadable
  // earlier sidecar is an error, not a skip: the coverage check would
  // otherwise run against an older report than the latest.
  const outDir = values["out-dir"] ?? corpus.meta.sessions_root;
  const earlierReports = beforeDate(listReports(existsSync(outDir) ? readdirSync(outDir) : []), date).earlier;
  const history = loadHistory(
    earlierReports.map((r) => r.name),
    (name) => {
      const file = join(outDir, name);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    },
  );
  errors.push(...history.problems.map((p) => `earlier report ${p}; fix or remove that file`));
  const bare = latestWithoutSidecar(earlierReports, history.entries);
  if (bare) errors.push(`the latest earlier report, ${bare}, has no sidecar, so it cannot be followed up; backfill one or move it away`);
  const index = historyIndex(history.entries);
  const latest = latestBefore(history.entries, date);
  errors.push(...checkHistory(findings, index, latest));
  const { carried, reportInfo } = resolveCarried(findings, index);

  const bodyRefs = [...body.matchAll(/\[\[(S[^\]\n]+)\]\]/g)].map((m) => m[1]).filter((r) => SESSION_REF.test(r));
  const refs = [...new Set([...bodyRefs, ...findingsRefs(findings)])];
  const info = refInfo(corpus.db, refs);
  for (const ref of findingsRefs(findings)) if (!info[ref]) errors.push(`findings.json cites unknown session ref ${ref}`);

  const since = new Date(facts.window.since);
  const until = new Date(new Date(facts.window.until).getTime() - 1);
  const generator = {
    provider: process.env.PI_PROVIDER ?? null,
    model: process.env.PI_MODEL ?? null,
    thinking: process.env.PI_REASONING_LEVEL ?? null,
  };
  const generatedAt = new Date().toISOString();
  const rendered = renderReport({
    shell: readFileSync(join(skill, "assets", "report-shell.html"), "utf8"),
    body,
    facts,
    outcomes,
    refInfo: info,
    reportInfo,
    carried,
    requiredSections: required,
    seed: date,
    title: `pi field notes, ${since.getDate()} ${MONTHS[since.getMonth()]} to ${until.getDate()} ${MONTHS[until.getMonth()]} ${until.getFullYear()}`,
    colophon: colophon({
      generatedAt: localStamp(generatedAt),
      model: generator.provider && generator.model ? `${generator.provider}/${generator.model}` : generator.model,
      thinking: generator.thinking,
      corpus: { ...facts.corpus, built_at_local: localStamp(facts.corpus.built_at) },
    }),
  });
  errors.push(...rendered.errors);

  const htmlFile = join(outDir, `pi-session-report-${date}.html`);
  const jsonFile = htmlFile.replace(/\.html$/, ".json");
  // Replacing a report destroys the user's copy, so the agent asks first;
  // every --check says so, even on a draft with problems, while there is
  // still time to ask.
  const exists = existsSync(htmlFile) || existsSync(jsonFile);
  const replace = `${short(htmlFile)} already exists; ask the user before replacing it with --force`;

  if (errors.length) {
    console.error(`render: ${errors.length} problem${errors.length === 1 ? "" : "s"}, nothing written`);
    for (const e of errors) console.error(`- ${e}`);
    if (exists && !values.force) console.error(`exists   ${replace}`);
    return 1;
  }

  const warnings = coverageWarnings(corpus.coverage);
  const outcomeNotes = outcomeCounts(outcomes)?.notes ?? [];
  const summary = [
    `sections ${rendered.sections}, charts ${rendered.charts.join(", ") || "none"}, session refs ${refs.length}`,
    `history  ${carried.length} earlier recommendations followed up` +
      (latest ? `, all ${latest.sidecar.recommendations?.length ?? 0} of the ${latest.key} report` : ", no earlier sidecar"),
    `window   ${facts.window.since} to ${facts.window.until}`,
    `coverage ${warnings.length ? `WARN: ${warnings.join("; ")}` : "ok"}`,
    ...outcomeNotes.map((n) => `outcomes ${n}`),
    ...(note ? [`note     ${note}`] : []),
    ...(generator.model ? [] : ["warning  PI_MODEL is not set, so the footer names no model; run render.mjs from inside pi"]),
    ...(exists && !values.force ? [`exists   ${replace}`] : []),
  ];
  if (values.check) {
    console.log([`check ok, would write ${short(htmlFile)}`, ...summary].join("\n"));
    return 0;
  }
  if (exists && !values.force) throw new PissError(replace);
  mkdirSync(outDir, { recursive: true });
  // Sidecar first: history lists reports by their HTML, so a failure between
  // the writes leaves an unlisted sidecar, never a report without one.
  const record = sidecar({ date, generatedAt, generator, facts, outcomes, findings, refs, reportFile: basename(htmlFile) });
  writeFileSync(jsonFile, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(htmlFile, rendered.html);
  console.log([`wrote    ${short(htmlFile)}`, `         ${short(jsonFile)}`, ...summary].join("\n"));
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof PissError || String(err?.code).startsWith("ERR_PARSE_ARGS")) console.error(`render: ${err.message}`);
  else console.error(String(err?.stack ?? err).slice(0, 4000));
  process.exitCode = 1;
}
