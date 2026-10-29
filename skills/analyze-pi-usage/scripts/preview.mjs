#!/usr/bin/env node
// Render assets/example-body.html against the live corpus, to review the report
// design: scripts/preview.mjs [--outcomes] [--since 30d] [--out FILE]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { factsDocument } from "../../pi-sessions/scripts/lib/commands/facts.mjs";
import { localStamp } from "../../pi-sessions/scripts/lib/format.mjs";
import { openCorpus, resolveWindow } from "../../pi-sessions/scripts/lib/query.mjs";
import { historyIndex, loadHistory } from "./lib/history.mjs";
import { findingsRefs, resolveCarried } from "./lib/publish.mjs";
import { colophon, renderReport } from "./lib/render.mjs";
import { refInfo } from "./lib/refs.mjs";
import { REQUIRED_SECTIONS } from "./lib/spec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skill = resolve(here, "..");
const piss = resolve(skill, "..", "pi-sessions", "scripts", "piss.mjs");

const { values } = parseArgs({
  options: {
    outcomes: { type: "boolean", default: false },
    since: { type: "string", default: "30d" },
    out: { type: "string" },
  },
});

const corpus = openCorpus();
const w = resolveWindow(corpus, { since: values.since });
let facts;
try {
  facts = factsDocument(corpus, w, { compare: true });
} catch {
  facts = factsDocument(corpus, w);
}
const outcomes = values.outcomes
  ? JSON.parse(execFileSync(piss, ["outcomes", "--since", values.since, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))
  : null;

const body = readFileSync(join(skill, "assets", "example-body.html"), "utf8");
const findings = JSON.parse(readFileSync(join(skill, "assets", "example-findings.json"), "utf8"));
const refs = [...new Set([...[...body.matchAll(/\[\[(S[^\]]+)\]\]/g)].map((m) => m[1]), ...findingsRefs(findings)])];
// The example follows up real earlier reports, so it renders against the
// sidecars in the sessions directory.
const reports = corpus.meta.sessions_root;
const history = loadHistory(existsSync(reports) ? readdirSync(reports) : [], (name) =>
  existsSync(join(reports, name)) ? JSON.parse(readFileSync(join(reports, name), "utf8")) : undefined,
);
const { carried, reportInfo } = resolveCarried(findings, historyIndex(history.entries));
const { html, errors } = renderReport({
  shell: readFileSync(join(skill, "assets", "report-shell.html"), "utf8"),
  body,
  facts,
  outcomes,
  refInfo: refInfo(corpus.db, refs),
  reportInfo,
  carried,
  title: "pi field notes (design preview)",
  requiredSections: REQUIRED_SECTIONS.map((s) => s.id),
  colophon: colophon({
    generatedAt: localStamp(new Date().toISOString()),
    model: process.env.PI_PROVIDER && process.env.PI_MODEL ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : null,
    thinking: process.env.PI_REASONING_LEVEL,
    corpus: { ...facts.corpus, built_at_local: localStamp(facts.corpus.built_at) },
  }),
});

const out = values.out ?? join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "pi-clanker", "analyze-pi-usage", "preview.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
for (const e of errors) console.error(`preview: ${e}`);
console.log(out);
