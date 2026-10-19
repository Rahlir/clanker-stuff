// Maps issue locations from the code Sonar analyzed onto the local checkout.
// Sonar's own copy of each file (api/sources/raw, honoring branch/MR) is
// diffed against the local file, so mapping needs neither the analyzed commit
// (Sonar does not expose it for MRs) nor that commit being present locally.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { diffTextAgainstFile } from "./git.mjs";

// Sonar's issue `hash`: MD5 of the line with all whitespace removed. Many
// lines share a hash (`raise HTTPException(`), so it verifies a line but
// cannot find one on its own.
export const lineHash = (line) => createHash("md5").update(line.replace(/\s/g, "")).digest("hex");

export function parseHunks(diff) {
  const hunks = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm))
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  return hunks;
}

// Old line -> { line } when it lies outside every hunk, or { hunk } when the
// line itself was changed or removed. A pure insertion (`-a,0`) sits after
// old line a, so lines up to a keep their offset.
export function mapLine(hunks, old) {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      if (old <= h.oldStart) return { line: old + delta };
    } else {
      if (old < h.oldStart) return { line: old + delta };
      if (old < h.oldStart + h.oldCount) return { hunk: h };
    }
    delta += h.newCount - h.oldCount;
  }
  return { line: old + delta };
}

// Nearest local line with `hash` to `expected`, within lines [from, to].
function nearestHash(lines, hash, expected, from, to) {
  let best = null;
  for (let n = Math.max(1, from); n <= Math.min(lines.length, to); n++)
    if (lineHash(lines[n - 1]) === hash && (best === null || Math.abs(n - expected) < Math.abs(best - expected)))
      best = n;
  return best;
}

// How far around the analyzed line to look when Sonar's copy is unavailable,
// and how far an edited line may travel within added content.
const BLIND_WINDOW = 50;
const MOVE_WINDOW = 10;

// Local line numbers the diff marks as added or replaced.
function addedLines(hunks) {
  const added = new Set();
  for (const h of hunks) for (let n = h.newStart; n < h.newStart + h.newCount; n++) added.add(n);
  return added;
}

export function createLocator({ client, root, scopeParams }) {
  const files = new Map();

  function load(component, path) {
    if (!files.has(component)) files.set(component, loadFile(component, path));
    return files.get(component);
  }

  async function loadFile(component, path) {
    let local;
    try {
      local = await readFile(join(root, path), "utf8");
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EISDIR") return { missing: true };
      throw e;
    }
    const lines = local.split("\n");
    const analyzed = await client.get("/api/sources/raw", { key: component, ...scopeParams }, { optional: true, text: true });
    if (analyzed == null) return { lines, hunks: null };
    const hunks = analyzed === local ? [] : parseHunks(await diffTextAgainstFile(analyzed, join(root, path)));
    return { lines, hunks, added: addedLines(hunks) };
  }

  // Returns { path, sonarLine, line, status }: line is the local line or
  // null; status is one of exact, moved, changed (the line was edited since
  // the analysis, possibly fixed), stale (mapped but the hash disagrees),
  // unverified (Sonar's copy is unavailable, so the line is a best guess),
  // missing, file-level, no-checkout.
  async function locate({ component, path, line, hash }) {
    const base = { path, sonarLine: line, line: null };
    if (path == null) return { ...base, status: "missing" };
    if (line == null) return { ...base, status: "file-level" };
    if (!root) return { ...base, status: "no-checkout" };
    const file = await load(component, path);
    if (file.missing) return { ...base, status: "missing" };

    const inBounds = (n) => n >= 1 && n <= file.lines.length;
    const hashAt = (n) => inBounds(n) && lineHash(file.lines[n - 1]) === hash;
    const found = (n) => ({ ...base, line: n, status: n === line ? "exact" : "moved" });
    const changed = { ...base, status: "changed" };

    // Without Sonar's copy nothing proves the line survived (an identical line
    // may stand where a deleted one was), so any guess stays unverified.
    if (file.hunks === null) {
      const n = hash ? nearestHash(file.lines, hash, line, line - BLIND_WINDOW, line + BLIND_WINDOW) : inBounds(line) ? line : null;
      return n ? { ...base, line: n, status: "unverified" } : changed;
    }
    const mapped = mapLine(file.hunks, line);
    if (mapped.line !== undefined) {
      if (!inBounds(mapped.line)) return changed;
      return !hash || hashAt(mapped.line) ? found(mapped.line) : { ...base, line: mapped.line, status: "stale" };
    }
    // The line itself was edited or removed. If it moved, it reappears as added
    // content nearby; unchanged lines are never candidates, so a surviving twin
    // (another `return null;`) cannot adopt the issue.
    if (!hash) return changed;
    const h = mapped.hunk;
    const expected = h.newStart + (line - h.oldStart);
    let best = null;
    for (const n of file.added)
      if (Math.abs(n - expected) <= MOVE_WINDOW && hashAt(n) && (best === null || Math.abs(n - expected) < Math.abs(best - expected)))
        best = n;
    return best ? found(best) : changed;
  }

  async function linesOf(component, path) {
    if (!root || path == null) return null;
    const file = await load(component, path);
    return file.missing ? null : file.lines;
  }

  return { locate, linesOf };
}

// Lines around `line` as [number, text] pairs, clipped to the file.
export function excerpt(lines, line, context) {
  const out = [];
  for (let n = Math.max(1, line - context); n <= Math.min(lines.length, line + context); n++) out.push([n, lines[n - 1]]);
  return out;
}
