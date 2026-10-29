// Where piss keeps its files and which local configuration it reads.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTemplate } from "./core.mjs";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const xdg = (name, fallback) => process.env[name]?.trim() || join(homedir(), fallback);

// The corpus is derived from session logs and safe to delete; tags are agent
// judgment that a rebuild cannot recreate, so they live in the state dir.
export const cacheDir = () => join(xdg("XDG_CACHE_HOME", ".cache"), "pi-clanker", "pi-sessions");
export const stateDir = () => join(xdg("XDG_STATE_HOME", ".local/state"), "pi-clanker", "pi-sessions");
// PISS_CORPUS (or --corpus on any command) gives a run its own corpus, so a
// build in another session cannot replace the data mid-analysis.
export const corpusPath = () => (process.env.PISS_CORPUS?.trim() ? resolve(process.env.PISS_CORPUS.trim()) : join(cacheDir(), "corpus.db"));

/**
 * Remove `--corpus PATH` (or `--corpus=PATH`) from argv, wherever it appears,
 * and point PISS_CORPUS at it. Returns the remaining arguments.
 */
export function takeCorpusFlag(argv) {
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus" && i + 1 < argv.length) process.env.PISS_CORPUS = argv[++i];
    else if (argv[i].startsWith("--corpus=")) process.env.PISS_CORPUS = argv[i].slice("--corpus=".length);
    else rest.push(argv[i]);
  }
  return rest;
}
export const tagsPath = () => join(stateDir(), "tags.db");

export function loadCorrections() {
  const file = join(SKILL_DIR, "assets", "price-corrections.json");
  return JSON.parse(readFileSync(file, "utf8")).corrections;
}

/** Names of tools whose execution is the user answering a UI, so their time is the user's. */
export function loadInteractiveTools() {
  const file = join(SKILL_DIR, "assets", "interactive-tools.json");
  return new Set(JSON.parse(readFileSync(file, "utf8")).tools.map((t) => t.name));
}

/** Prompts that extensions compose (not template files), as regexes whose groups are the arguments. */
export function loadPromptPatterns() {
  const file = join(SKILL_DIR, "assets", "prompt-patterns.json");
  return JSON.parse(readFileSync(file, "utf8")).patterns.map((p) => ({ ...p, re: new RegExp(p.regex) }));
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

/** The default project key from a jira-cli config, in block or inline form. */
export function parseJiraProjectKey(yaml) {
  const inline = /^project:[ \t]*["']?([A-Z][A-Z0-9_]*)["']?[ \t]*$/m.exec(yaml);
  if (inline) return inline[1];
  const block = /^project:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(yaml);
  const key = block && /^[ \t]+key:[ \t]*["']?([A-Z][A-Z0-9_]*)["']?[ \t]*$/m.exec(block[1]);
  return key?.[1] ?? null;
}

/** Ticket projects to detect: the explicit list, else the jira CLI's default project. */
export function jiraProjects(explicit) {
  if (explicit) {
    return explicit
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }
  const file = process.env.JIRA_CONFIG_FILE?.trim() || join(xdg("XDG_CONFIG_HOME", ".config"), ".jira", ".config.yml");
  try {
    const key = parseJiraProjectKey(readFileSync(file, "utf8"));
    return key ? [key] : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const expandHome = (p) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

// Local paths resolve from the settings file; git sources are checked out
// under <agentDir>/git/<host>/<path>. npm installs are not located here.
function packageRoot(agentDir, source) {
  if (/^(\.{1,2}\/|\/|~)/.test(source)) return resolve(agentDir, expandHome(source));
  const git = /^(?:git:|https?:\/\/)([^/@]+)\/([^@]+?)(?:\.git)?(?:@.*)?$/.exec(source);
  if (git) return join(agentDir, "git", git[1], git[2]);
  return null;
}

function markdownFiles(entry) {
  if (entry.startsWith("!")) return [];
  if (entry.includes("*")) {
    const dir = dirname(entry);
    const pattern = globPattern(basename(entry));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && pattern.test(f))
      .map((f) => join(dir, f));
  }
  if (!existsSync(entry)) return [];
  if (statSync(entry).isDirectory()) {
    return readdirSync(entry)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(entry, f));
  }
  return entry.endsWith(".md") ? [entry] : [];
}

function globPattern(glob) {
  return new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

// Templates deleted from a prompts dir, in a commit or only in the working
// tree, still name the prompts sent while they existed; without their history
// those prompts would read as free text.
function deletedMarkdown(entry) {
  let dir = entry;
  let pattern = null;
  if (entry.includes("*")) {
    dir = dirname(entry);
    pattern = globPattern(basename(entry));
  } else if (!existsSync(entry) || !statSync(entry).isDirectory()) {
    return [];
  }
  if (!existsSync(dir)) return [];
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }).toString("utf8");
  let listed;
  try {
    listed = git("log", "--diff-filter=D", "--name-only", "--format=", "--relative", "--", ".") + git("ls-files", "--deleted", "--", ".");
  } catch {
    return [];
  }
  const names = new Set(listed.split("\n").map((f) => f.trim()));
  return [...names]
    .filter((f) => f.endsWith(".md") && !f.includes("/") && (!pattern || pattern.test(f)))
    .map((f) => join(dir, f))
    .filter((f) => !existsSync(f));
}

// Every committed version of a file, oldest renames included. Prompts sent
// before a template was edited only match its older text.
function gitVersions(file) {
  const git = (args, input) =>
    execFileSync("git", ["-C", dirname(file), ...args], {
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  let log;
  try {
    log = git(["log", "--follow", "--format=", "--raw", "--no-abbrev", "--", basename(file)]).toString("utf8");
  } catch {
    return [];
  }
  const blobs = new Set();
  for (const line of log.split("\n")) {
    const m = /^:\d{6} \d{6} [0-9a-f]+ ([0-9a-f]+) [A-Z]/.exec(line);
    if (m && !/^0+$/.test(m[1])) blobs.add(m[1]);
  }
  if (!blobs.size) return [];
  const out = git(["cat-file", "--batch"], `${[...blobs].join("\n")}\n`);
  const versions = [];
  let pos = 0;
  while (pos < out.length) {
    const eol = out.indexOf(10, pos);
    if (eol < 0) break;
    const [, type, size] = out.toString("utf8", pos, eol).split(" ");
    const start = eol + 1;
    if (type !== "blob") {
      pos = start;
      continue;
    }
    versions.push(out.toString("utf8", start, start + Number(size)));
    pos = start + Number(size) + 1;
  }
  return versions;
}

/**
 * Prompt templates pi would load from user configuration: the personal prompts
 * dir, `prompts` in settings.json, and each configured package's prompts, each
 * with its committed history so older prompts still match. Templates since
 * deleted from those dirs come from git history alone, after every existing
 * one, so a current template keeps its name. Project-local templates
 * (.pi/prompts) are not included.
 */
export function loadTemplates(agentDir) {
  const settings = readJson(join(agentDir, "settings.json")) ?? {};
  const entries = [join(agentDir, "prompts")];
  const skipped = [];
  for (const p of Array.isArray(settings.prompts) ? settings.prompts : []) {
    if (typeof p === "string") entries.push(isAbsolute(p) ? p : resolve(agentDir, expandHome(p)));
  }
  for (const pkg of Array.isArray(settings.packages) ? settings.packages : []) {
    const source = typeof pkg === "string" ? pkg : pkg?.source;
    if (typeof source !== "string") continue;
    const root = packageRoot(agentDir, source);
    if (!root || !existsSync(root)) {
      skipped.push(source);
      continue;
    }
    const manifest = readJson(join(root, "package.json"))?.pi;
    const declared = Array.isArray(manifest?.prompts) ? manifest.prompts : ["prompts"];
    for (const e of declared) entries.push(resolve(root, e));
  }
  const templates = [];
  const names = new Set();
  const dirs = new Set();
  const files = [...entries.flatMap(markdownFiles), ...entries.flatMap(deletedMarkdown)];
  for (const file of files) {
    const name = basename(file, ".md");
    if (names.has(name)) continue;
    const current = existsSync(file) ? [readFileSync(file, "utf8")] : [];
    const texts = new Set([...current, ...gitVersions(file)]);
    const compiled = [...texts].map((text) => compileTemplate(name, text)).filter(Boolean);
    if (!compiled.length) continue;
    names.add(name);
    dirs.add(dirname(file));
    templates.push(...compiled);
  }
  return { templates, names: [...names], dirs: [...dirs], skipped };
}
