// The pi adapter. Session discovery, format migration and the session tree come
// from the installed pi, so files are read with the same version that wrote
// them. Only read-only pi APIs are used: SessionManager.open() and friends can
// append to or rewrite session files, which an analysis tool must never do.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLines } from "./core.mjs";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const SUPPORTED_SESSION_VERSION = 3;

export class PissError extends Error {}

function packageName(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
  } catch {
    return null;
  }
}

// Resolve the global install behind `pi` on PATH. A bare import would find
// this repo's own node_modules copy first, which can be older than the pi that
// wrote the logs.
function findPiPackage(pathVar) {
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, "pi");
    if (!existsSync(bin)) continue;
    let p = dirname(realpathSync(bin));
    while (p !== dirname(p)) {
      if (packageName(p) === PI_PACKAGE) return p;
      p = dirname(p);
    }
  }
  return null;
}

export async function loadPi(env = process.env) {
  const pkgDir = env.PI_PACKAGE_DIR?.trim() || findPiPackage(env.PATH);
  if (!pkgDir || packageName(pkgDir) !== PI_PACKAGE) {
    throw new PissError(`pi not found: put pi on PATH or set PI_PACKAGE_DIR to the ${PI_PACKAGE} package directory`);
  }
  const pi = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);
  const missing = ["getAgentDir", "parseSkillBlock", "buildSessionProjection"].filter((k) => typeof pi[k] !== "function");
  if (typeof pi.SessionManager?.listAll !== "function") missing.push("SessionManager.listAll");
  if (typeof pi.SessionManager?.inMemory !== "function") missing.push("SessionManager.inMemory");
  if (missing.length) {
    throw new PissError(`pi ${pi.VERSION ?? "?"} lacks ${missing.join(", ")}; piss needs updating for this pi version`);
  }
  if (pi.CURRENT_SESSION_VERSION !== SUPPORTED_SESSION_VERSION) {
    throw new PissError(
      `pi ${pi.VERSION} writes session format v${pi.CURRENT_SESSION_VERSION}; piss understands v${SUPPORTED_SESSION_VERSION} and needs updating`,
    );
  }
  return { pi, pkgDir, version: pi.VERSION ?? null };
}

/**
 * Every .jsonl under the sessions root, to catch files pi's listing skips, and
 * the directories that could not be read (pi skips those silently too).
 */
export function scanSessionFiles(root) {
  const files = [];
  const unreadable = [];
  if (!existsSync(root)) return { files, unreadable };
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, d.name);
    if (d.isFile() && d.name.endsWith(".jsonl")) files.push(p);
    else if (d.isDirectory() || d.isSymbolicLink()) {
      try {
        for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) files.push(join(p, f));
      } catch (err) {
        unreadable.push({ path: p, reason: err.code ?? err.message });
      }
    }
  }
  return { files, unreadable };
}

/**
 * Read one session file without writing to it: parse the lines here (counting
 * malformed ones, which pi skips silently) and hand the entries to an
 * in-memory SessionManager for migration and the active branch.
 */
export function readSessionFile(pi, path) {
  const parsed = parseLines(readFileSync(path, "utf8"));
  const header = parsed.entries[0];
  if (header?.type !== "session" || typeof header.id !== "string") {
    return { ...parsed, error: "first entry is not a session header" };
  }
  const version = header.version ?? 1;
  const sm = pi.SessionManager.inMemory(header.cwd || homedir(), undefined, parsed.entries);
  return {
    lines: parsed.lines,
    malformed: parsed.malformed,
    missingFinalNewline: parsed.missingFinalNewline,
    header: sm.getHeader() ?? header,
    version,
    entries: sm.getEntries(),
    activeIds: new Set(sm.getBranch().map((e) => e.id)),
  };
}

/**
 * For a fork or clone whose parent file still exists, the creation time before
 * which its entries are copies the parent already counts (see extractSession).
 * Null when nothing is inherited or the parent is gone, so the copies are the
 * only record and count here.
 */
export function inheritedBefore(header) {
  if (!header.parentSession || !existsSync(header.parentSession)) return null;
  const ms = Date.parse(header.timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Map a working directory to its repository root, grouping worktrees under the
 * main checkout. Directories that are gone or not in git map to themselves.
 */
export function createRepoResolver() {
  const cache = new Map();
  return (cwd) => {
    if (!cwd) return null;
    if (cache.has(cwd)) return cache.get(cwd);
    let repo = cwd;
    if (existsSync(cwd)) {
      try {
        const [top, common] = execFileSync(
          "git",
          ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
        )
          .trim()
          .split("\n");
        repo = common?.endsWith("/.git") ? dirname(common) : top || cwd;
      } catch {
        // not a git checkout
      }
    }
    cache.set(cwd, repo);
    return repo;
  };
}
