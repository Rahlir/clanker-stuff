import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadTemplates } from "./config.mjs";

const dir = mkdtempSync(join(tmpdir(), "piss-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args], { stdio: "ignore" });
const template = (body) => `---\ndescription: d\n---\n${body}\n`;

test("templates deleted from a prompts dir still match, from git history, without shadowing current ones", () => {
  const agentDir = join(dir, "agent");
  const prompts = join(agentDir, "prompts");
  const extra = join(dir, "extra");
  mkdirSync(prompts, { recursive: true });
  mkdirSync(extra, { recursive: true });
  git(prompts, "init", "-q");
  writeFileSync(join(prompts, "kept.md"), template("Kept prompt."));
  writeFileSync(join(prompts, "gone.md"), template("First text of a deleted prompt."));
  writeFileSync(join(prompts, "dup.md"), template("Old dup."));
  git(prompts, "add", ".");
  git(prompts, "commit", "-q", "-m", "add");
  writeFileSync(join(prompts, "gone.md"), template("Second text of a deleted prompt."));
  git(prompts, "commit", "-q", "-am", "edit");
  git(prompts, "rm", "-q", "gone.md", "dup.md");
  git(prompts, "commit", "-q", "-m", "delete");
  // Deleted from the working tree only, not committed yet.
  writeFileSync(join(prompts, "pending.md"), template("A prompt about to be deleted."));
  git(prompts, "add", "pending.md");
  git(prompts, "commit", "-q", "-m", "pending");
  rmSync(join(prompts, "pending.md"));
  // A current dup.md elsewhere keeps the name; the deleted one must not shadow it.
  writeFileSync(join(extra, "dup.md"), template("Current dup."));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ prompts: [extra] }));

  const { templates, names } = loadTemplates(agentDir);
  assert.deepEqual(names.sort(), ["dup", "gone", "kept", "pending"]);
  const bodies = (name) => templates.filter((t) => t.name === name).map((t) => t.segments.join("").trim()).sort();
  assert.deepEqual(bodies("gone"), ["First text of a deleted prompt.", "Second text of a deleted prompt."]);
  assert.deepEqual(bodies("dup"), ["Current dup."]);
});
