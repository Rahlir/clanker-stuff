// Read-only git queries. Every helper returns null instead of throwing when
// git fails (not a repo, unknown ref), so callers decide what absence means.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function repoRoot(cwd) {
  return (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim() || null;
}

// Branch names that describe HEAD: the checked-out branch, or, for a detached
// HEAD (review worktrees), every local or remote branch pointing at it.
export async function headBranches(root) {
  const current = (await git(root, ["branch", "--show-current"]))?.trim();
  if (current) return { names: [current], detached: false };
  const out = await git(root, [
    "for-each-ref",
    "--points-at",
    "HEAD",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  ]);
  const names = new Set();
  for (const ref of (out ?? "").split("\n").filter(Boolean)) {
    // refs/remotes/<remote>/<branch>; the symbolic <remote>/HEAD is not a branch.
    const name = ref.startsWith("refs/heads/") ? ref.slice(11) : ref.split("/").slice(3).join("/");
    if (name && name !== "HEAD") names.add(name);
  }
  return { names: [...names], detached: true };
}

export async function headCommitDate(root) {
  const iso = (await git(root, ["log", "-1", "--format=%cI"]))?.trim();
  return iso ? new Date(iso) : null;
}

export async function hasUncommittedChanges(root) {
  const out = await git(root, ["status", "--porcelain", "--untracked-files=no"]);
  return Boolean(out?.trim());
}

// Zero-context diff of `text` (e.g. the file as Sonar analyzed it) against a
// file on disk, for line mapping. Whitespace and CR-at-EOL changes are
// ignored: Sonar's issue hash ignores whitespace too, so a reformatted line
// still counts as the same line. Returns "" when they match.
export async function diffTextAgainstFile(text, file) {
  const dir = await mkdtemp(join(tmpdir(), "pi-sonarqube-"));
  const analyzed = join(dir, "analyzed");
  try {
    await writeFile(analyzed, text);
    // --inter-hunk-context=0 overrides a user's diff.interHunkContext, which
    // would merge hunks across unchanged lines and make them look added.
    const args = ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U0", "--inter-hunk-context=0", "-w", "--ignore-cr-at-eol", analyzed, file];
    try {
      await execFileAsync("git", args, { maxBuffer: 64 * 1024 * 1024 });
      return "";
    } catch (e) {
      // --no-index exits 1 when the files differ; only other codes are errors.
      if (e.code === 1 && typeof e.stdout === "string") return e.stdout;
      throw new Error(`git diff failed: ${e.stderr || e.message}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// URLs of every remote, not just origin: forks and mirrors often keep the
// canonical repo under another remote name.
export async function remoteUrls(cwd) {
  const out = await git(cwd, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
}
