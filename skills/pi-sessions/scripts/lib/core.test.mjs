import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCorrections, loadInteractiveTools, loadPromptPatterns, parseJiraProjectKey } from "./config.mjs";
import {
  assignRefs,
  classifyPrompt,
  compileTemplate,
  createCopyLedger,
  extractSession,
  inferProvider,
  parseLines,
  parseWhen,
  priceUsage,
} from "./core.mjs";

process.env.TZ = "UTC";

const fixturePath = (name) => fileURLToPath(new URL(`../fixtures/${name}.jsonl`, import.meta.url));

// The active branch walks parentId from the last entry, which is how pi picks
// the leaf of a loaded session; production code gets it from pi itself.
function load(name) {
  const parsed = parseLines(readFileSync(fixturePath(name), "utf8"));
  const [header, ...entries] = parsed.entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const activeIds = new Set();
  for (let e = entries.at(-1); e; e = byId.get(e.parentId)) activeIds.add(e.id);
  return { ...parsed, header, entries, activeIds, version: header.version };
}

// Same pattern as pi's parseSkillBlock.
function parseSkillBlock(text) {
  const m = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  return m ? { name: m[1], location: m[2], content: m[3], userMessage: m[4]?.trim() || undefined } : null;
}

const REVIEW_TEMPLATE = "---\ndescription: Review\n---\nReview the staged changes. Focus on ${1:-correctness}.\n\nTicket keys look like HSCTR-1.\n";

function extract(name, ctx = {}) {
  return extractSession(
    { ...load(name), path: `/sessions/${name}.jsonl`, ref: "S1" },
    {
      jiraProjects: ["HSCTR"],
      parseSkillBlock,
      templates: [compileTemplate("review", REVIEW_TEMPLATE)],
      ...ctx,
    },
  );
}

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${expected}, got ${actual}`);

test("parseLines counts malformed lines and a missing final newline", () => {
  const parsed = parseLines(readFileSync(fixturePath("misc"), "utf8"));
  assert.equal(parsed.lines, 12);
  assert.equal(parsed.malformed, 1);
  assert.equal(parsed.entries.length, 11);
  assert.equal(parsed.missingFinalNewline, true);
  assert.equal(parseLines("42\n").malformed, 1);
});

test("prompts name their template or skill and keep only the user's own words as args", () => {
  const { prompts, session } = extract("basic", { repo: "/work/nba2" });
  assert.deepEqual(
    prompts.map((p) => [p.template, p.skill, p.template_match, p.args]),
    [
      ["review", null, "full", "HSCTR-12 and API compatibility"],
      [null, "jira", "full", "show me HSCTR-56"],
      [null, null, null, null],
    ],
  );
  assert.deepEqual(
    prompts.map((p) => p.gap_before_s),
    [null, 300, 54400],
  );
  assert.equal(prompts[2].has_images, 1);
  assert.equal(session.first_template, "review");
  assert.equal(session.name, "Fixture basic");
  assert.equal(session.repo, "/work/nba2");
  assert.equal(session.abandoned_entries, 0);
});

test("ticket mentions skip template and skill boilerplate and keep each entry's time", () => {
  const { tickets } = extract("basic");
  assert.deepEqual(
    tickets.map((t) => [t.key, t.source, t.entry_id, t.ts]).sort(),
    [
      ["HSCTR-12", "prompt", "b03", "2026-10-01T08:00:30.000Z"],
      ["HSCTR-34", "tool_args", "b04", "2026-10-01T08:01:00.000Z"],
      ["HSCTR-56", "prompt", "b07", "2026-10-01T08:06:10.000Z"],
      ["HSCTR-77", "prompt", "b10", "2026-10-01T23:58:00.000Z"],
    ],
  );
  assert.deepEqual(extract("basic", { jiraProjects: [] }).tickets, []);
});

test("tool calls are joined with their results", () => {
  const { toolCalls, turns } = extract("basic");
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(
    {
      name: toolCalls[0].name,
      key_arg: toolCalls[0].key_arg,
      is_error: toolCalls[0].is_error,
      result_text: toolCalls[0].result_text,
      duration_ms: toolCalls[0].duration_ms,
      result_entry_id: toolCalls[0].result_entry_id,
    },
    {
      name: "bash",
      key_arg: "jira issue view HSCTR-34 --plain",
      is_error: 1,
      result_text: "error: issue not found",
      duration_ms: 1500,
      result_entry_id: "b05",
    },
  );
  assert.deepEqual(
    turns.map((t) => t.thinking_level),
    ["high", "high", "high", "high"],
  );
});

test("active time drops long gaps, splits user and agent time, and credits the hour a gap ends", () => {
  const { activeTime } = extract("basic");
  // User: opening the session and typing the first prompt (0.1 + 29.8 s),
  // the pause before the skill prompt (300 s), naming the session (10 s).
  assert.deepEqual(activeTime, [
    { ref: "S1", hour: "2026-10-01T08:00:00.000Z", user_s: 339.9, agent_s: 40 },
    { ref: "S1", hour: "2026-10-02T00:00:00.000Z", user_s: 0, agent_s: 300 },
  ]);
});

test("cache warming pings are spend, not activity, and do not bridge a long break", () => {
  const { activeTime, session, usage } = extract("cachewarm");
  // User: the 19 min 20 s pause before the second prompt, pings and all.
  // Agent: three 30 s answers. The 44 min 30 s pause before the third
  // prompt is a break even though pings arrived every 4.6 min.
  assert.deepEqual(activeTime, [
    { ref: "S1", hour: "2026-10-20T10:00:00.000Z", user_s: 1160, agent_s: 60 },
    { ref: "S1", hour: "2026-10-20T11:00:00.000Z", user_s: 0, agent_s: 30 },
  ]);
  assert.equal(session.last_activity, "2026-10-20T11:05:30.000Z");
  assert.equal(usage.filter((u) => u.source === "usage:cache_warm").length, 12, "their spend still counts");
});

test("typing after a model change and answering a questionnaire are the user's time", () => {
  const { activeTime } = extract("markers", { interactiveTools: loadInteractiveTools() });
  // User: 100 s picking a thinking level, 30 s typing until the settings
  // marker the prompt brought along, 60 s answering the questionnaire.
  // Agent: 20 s and 30 s of answers, 5 s until the extension saved its state,
  // 5 s to call the questionnaire, 10 s for the final answer.
  assert.deepEqual(activeTime, [{ ref: "S1", hour: "2026-10-06T10:00:00.000Z", user_s: 190, agent_s: 70 }]);

  const unaware = extract("markers", { interactiveTools: new Set() }).activeTime[0];
  assert.deepEqual([unaware.user_s, unaware.agent_s], [130, 130]);
});

test("reopening a session is housekeeping: no activity, no time, but the entries are kept", () => {
  const { activeTime, session, events, tickets } = extract("resume");
  assert.deepEqual(activeTime, [{ ref: "S1", hour: "2026-09-01T09:00:00.000Z", user_s: 19.9, agent_s: 40 }]);
  assert.equal(session.last_activity, "2026-09-01T09:01:00.000Z");
  assert.equal(events.filter((e) => e.ts >= "2026-10-01").length, 5);
  assert.deepEqual(
    tickets.map((t) => [t.key, t.source, t.ts]),
    [["HSCTR-321", "session_name", "2026-10-01T08:01:00.000Z"]],
  );
});

test("abandoned branches count for cost but are flagged", () => {
  const { turns, prompts, usage, session } = extract("branched");
  assert.deepEqual(
    turns.map((t) => [t.entry_id, t.on_active_branch]),
    [
      ["r02", 1],
      ["r04", 0],
      ["r07", 1],
    ],
  );
  assert.equal(prompts.find((p) => p.entry_id === "r03").on_active_branch, 0);
  close(
    usage.reduce((sum, u) => sum + u.recorded, 0),
    0.65,
  );
  const summary = usage.find((u) => u.source === "branch_summary");
  assert.deepEqual([summary.provider, summary.model, summary.provider_source], ["anthropic", "claude-opus-5", "session"]);
  assert.equal(session.abandoned_entries, 2);
});

test("an entry without a readable timestamp is kept and counted", () => {
  const input = load("basic");
  const odd = { type: "label", id: "zz", parentId: input.entries.at(-1).id, timestamp: "not a time", label: "x" };
  const rows = extractSession({ ...input, entries: [...input.entries, odd], ref: "S1", path: "S1" }, { jiraProjects: ["HSCTR"] });
  assert.equal(rows.stats.badTimestamps, 1);
  assert.ok(rows.events.some((e) => e.entry_id === "zz"));
});

test("an imported copy of a session counts only what was added after the import", () => {
  const original = load("basic");
  const added = { type: "message", id: "imp1", parentId: original.entries.at(-1).id, timestamp: "2026-10-03T09:00:00.000Z", message: { role: "user", content: "after import" } };
  const copy = { ...original, entries: [...original.entries, added] };
  const ledger = createCopyLedger();
  const run = (input, ref) => {
    const rows = extractSession({ ...input, ref, path: ref }, { jiraProjects: ["HSCTR"], skipCopy: ledger.skipFor(input.header) });
    ledger.record(input.entries, rows.inherited);
    return rows;
  };
  const first = run(original, "S1");
  const second = run(copy, "S2");
  assert.ok(first.usage.length > 0);
  assert.deepEqual(second.usage, []);
  assert.deepEqual(second.prompts.map((p) => p.entry_id), ["imp1"]);
  assert.equal(second.inherited.length, original.entries.length);
});

test("fork copies count once: in the original, else in the oldest surviving copy", () => {
  const fork = load("fork");
  const copied = fork.entries.slice(0, 2);
  const sibling = {
    ...fork,
    header: { ...fork.header, id: "sibling", timestamp: "2026-10-09T08:00:00.000Z" },
    entries: copied,
    activeIds: new Set(copied.map((e) => e.id)),
  };
  const run = (ledger, input) => {
    const rows = extractSession({ ...input, ref: input.header.id }, { jiraProjects: ["HSCTR"], skipCopy: ledger.skipFor(input.header) });
    ledger.record(input.entries, rows.inherited);
    return rows;
  };

  // The parent was deleted: the older fork holds the copies, its sibling skips them.
  const ledger = createCopyLedger();
  const first = run(ledger, fork);
  assert.deepEqual(first.usage.map((u) => u.recorded), [0.5, 0.1]);
  assert.equal(first.session.inherited_entries, 0);
  const second = run(ledger, sibling);
  assert.deepEqual(second.usage, []);
  assert.deepEqual(second.inherited.map((r) => r.entry_id), ["f01", "f02"]);

  // The original survives: it is older, so the fork skips what it copied.
  const original = { ...fork, header: { id: "parent", timestamp: "2026-10-07T08:00:00.000Z" }, entries: copied, activeIds: new Set() };
  const withParent = createCopyLedger();
  run(withParent, original);
  const child = run(withParent, fork);
  assert.deepEqual(child.usage.map((u) => u.recorded), [0.1]);
  assert.deepEqual(child.prompts.map((p) => p.entry_id), ["f03"]);
  assert.equal(child.session.first_prompt, "own prompt");
  assert.deepEqual(child.activeTime, [{ ref: "0199aaaa-0000-7000-8000-000000000009", hour: "2026-10-08T12:00:00.000Z", user_s: 0, agent_s: 30 }]);

  // Skipped copies still carry state: a compaction before the fork's first own
  // turn is attributed to the model of the copied turn.
  const compaction = {
    type: "compaction",
    id: "c1",
    timestamp: "2026-10-08T12:00:05.000Z",
    usage: { input: 100, output: 10, cost: { total: 0.02 } },
  };
  const compacted = { ...fork, entries: [...copied, compaction, ...fork.entries.slice(2)] };
  const summary = run(withParent, compacted).usage.find((u) => u.source === "compaction");
  assert.deepEqual([summary.provider, summary.model], ["anthropic", "claude-sonnet-5"]);
});

test("every non-conversation entry becomes an event and unknown types are reported", () => {
  const { events, usage, stats } = extract("misc");
  assert.deepEqual(
    events.map((e) => [e.type, e.subtype]),
    [
      ["compaction", null],
      ["context_edit", "m01"],
      ["usage", "cache_warm"],
      ["custom", "mr-review"],
      ["custom_message", "memory"],
      ["future_thing", null],
      ["label", "checkpoint"],
      ["message", "system"],
    ],
  );
  assert.deepEqual([...stats.unknown], [["future_thing", 1]]);
  assert.deepEqual(
    usage.map((u) => [u.source, u.provider, u.model, u.recorded]),
    [
      ["assistant", "openai-codex", "gpt-6-astra", 0.01],
      ["compaction", "openai-codex", "gpt-6-astra", 0.02],
      ["usage:cache_warm", "anthropic", "claude-sonnet-5", 0.003],
    ],
  );
});

test("review spend: top-level usage, legacy receipts before the fix, never copies", () => {
  const corrections = loadCorrections();
  const review = extract("review")
    .usage.filter((u) => u.source !== "assistant")
    .map((u) => priceUsage(u, corrections));
  assert.deepEqual(
    review.map((u) => [u.entry_id, u.source, u.tool, u.provider, u.model, u.provider_source]),
    [
      ["v05", "review_legacy", "code_review_await", "keystone", "claude-opus-5", "job"],
      ["v07", "review_legacy", "code_review", "openai-codex", "gpt-6-astra", "args"],
      ["v11", "tool_result", "code_review", null, "claude-sonnet-5", null],
    ],
  );
  close(review[0].cost_corrected, 0.0075);
  assert.equal(review[0].correction, "keystone-opus-5-2026-09-24");

  const lateRun = extract("review-late");
  const late = lateRun.usage.filter((u) => u.source !== "assistant");
  assert.deepEqual(
    late.map((u) => [u.entry_id, u.source, u.provider, u.provider_source]),
    [["w05", "tool_result", "openai-codex", "args"]],
  );
  // w03 is a details-only receipt after the fix for a job never delivered with
  // top-level usage: an extension loaded before the fix. Reported, not counted.
  assert.equal(lateRun.stats.lateReceipts, 1);
  assert.equal(extract("review").stats.lateReceipts, 0);
});

test("legacy receipts count once per job, including status-only jobs and jobs reusing an id after a reload", () => {
  const { usage, stats } = extract("review-repeat");
  assert.deepEqual(
    usage.map((u) => [u.entry_id, u.source, u.tool, u.recorded]),
    [
      ["q03", "review_legacy", "code_review_await", 0.004],
      ["q07", "review_legacy", "code_review_status", 0.002],
      ["q13", "review_legacy", "code_review_await", 0.004],
    ],
  );
  assert.equal(stats.repeatedReceipts, 1);
  assert.equal(extract("review").stats.repeatedReceipts, 1);

  // A fork whose first entries are copies the parent session already counts.
  const copied = new Set(["q01", "q02", "q03"]);
  const fork = extract("review-repeat", { skipCopy: (e) => copied.has(e.id) });
  assert.deepEqual(
    fork.usage.map((u) => u.entry_id),
    ["q07", "q13"],
  );
  assert.equal(fork.stats.repeatedReceipts, 1);
});

test("price corrections apply only when the recorded cost used the wrong rates", () => {
  const corrections = loadCorrections();
  const priced = extract("pricing").usage.map((u) => priceUsage(u, corrections));
  assert.deepEqual(
    priced.map((u) => u.correction),
    ["keystone-opus-5-2026-09-24", null, "keystone-opus-5-5-2026-09-30", null],
  );
  close(priced[0].cost_corrected, 0.025);
  close(priced[1].cost_corrected, 0.025);
  close(priced[2].cost_corrected, 0.0196);
  close(priced[3].cost_corrected, 0.075);
  assert.equal(priced[0].cost_recorded, 0.075);
});

test("refs are stable, minute-based, and suffixed for same-minute sessions", () => {
  const refs = assignRefs([
    { path: "a", id: "9", created: "2026-10-13T10:58:27.475Z" },
    { path: "b", id: "1", created: "2026-10-13T10:58:59.000Z" },
    { path: "c", id: "0", created: "2026-10-13T10:58:59.000Z" },
    { path: "d", id: "5", created: "2026-10-13T10:59:00.000Z" },
  ]);
  assert.deepEqual(Object.fromEntries(refs), {
    a: "S261013-1058",
    c: "S261013-1058b",
    b: "S261013-1058c",
    d: "S261013-1059",
  });
});

test("parseWhen reads relative, dated and absolute times", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const iso = (v) => parseWhen(v, now).toISOString();
  assert.equal(iso("90d"), "2026-07-22T12:00:00.000Z");
  assert.equal(iso("2w"), "2026-10-06T12:00:00.000Z");
  assert.equal(iso("1m"), "2026-09-20T12:00:00.000Z");
  assert.equal(iso("12h"), "2026-10-20T00:00:00.000Z");
  assert.equal(iso("2026-07-01"), "2026-07-01T00:00:00.000Z");
  assert.equal(iso("2026-07-01T10:00:00Z"), "2026-07-01T10:00:00.000Z");
  assert.equal(parseWhen("all", now).getTime(), 0);
  assert.throws(() => parseWhen("yesterday", now), /cannot read time/);
});

test("templates: multi-line args keep their text, edited templates still match by first line", () => {
  const swarm = compileTemplate("swarm", "Focus your review on:\n$@\n\nReport back.");
  const out = classifyPrompt("Focus your review on:\n- correctness\n-   naming\n\nReport back.", { templates: [swarm] });
  assert.deepEqual([out.template, out.match, out.args], ["swarm", "full", "- correctness\n-   naming"]);

  const edited = compileTemplate("review", "Review the staged changes. Focus on $1.\n\nA paragraph added later.");
  const old = classifyPrompt("Review the staged changes. Focus on naming.\n\nThe old paragraph.", { templates: [edited] });
  assert.deepEqual([old.template, old.match, old.args], ["review", "prefix", null]);

  const fixed = compileTemplate("squash", "Write the commit message.\n\nNo placeholders here.");
  const exact = classifyPrompt("Write the commit message.\n\nNo placeholders here.", { templates: [fixed] });
  assert.deepEqual([exact.template, exact.match, exact.args, exact.scanText], ["squash", "full", null, ""]);

  assert.equal(classifyPrompt("something else", { templates: [edited] }).template, null);
});

test("prompts from an uncommitted template version keep only the lines no version contains", () => {
  const v1 = compileTemplate("ship", "Ship the ticket.\nExample key: HSCTR-1.\nClosing: $1 please.");
  const v0 = compileTemplate("ship", "Ship the ticket.\nAn older line.\nClosing: $1 please.");
  const prompt = "Ship the ticket.\nExample key: HSCTR-1.\nAn uncommitted extra line.\nClosing: HSCTR-77 please.";
  const cls = classifyPrompt(prompt, { templates: [v1, v0] });
  assert.deepEqual([cls.template, cls.match, cls.args], ["ship", "prefix", null]);
  assert.equal(cls.scanText, "An uncommitted extra line.\nClosing: HSCTR-77 please.");

  const rows = extractSession(
    {
      ref: "S1",
      header: { id: "x", timestamp: "2026-10-01T00:00:00.000Z" },
      entries: [{ type: "message", id: "p1", timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: prompt } }],
      activeIds: new Set(["p1"]),
    },
    { templates: [v1, v0], jiraProjects: ["HSCTR"] },
  );
  assert.deepEqual(rows.tickets.map((t) => t.key), ["HSCTR-77"]);
  assert.equal(rows.fts[0].text, `[/ship] ${cls.scanText}`);
});

test("session names are searchable and orphan tool results are kept", () => {
  const { fts } = extract("basic");
  assert.deepEqual(
    fts.filter((f) => f.kind === "name").map((f) => [f.text, f.entry_id]),
    [["Fixture basic", "b08"]],
  );
  const orphan = { type: "message", id: "o1", timestamp: "2026-10-01T00:00:01.000Z" };
  orphan.message = { role: "toolResult", toolCallId: "missing", toolName: "bash", content: [{ type: "text", text: "x" }] };
  const rows = extractSession({ ref: "S1", header: { id: "x" }, entries: [orphan], activeIds: new Set(["o1"]) });
  assert.equal(rows.stats.orphanResults, 1);
  assert.deepEqual(rows.events.map((e) => [e.type, e.subtype, e.entry_id]), [["message", "toolResult", "o1"]]);
});

test("templates: empty arguments next to whitespace still match exactly", () => {
  const pickup = compileTemplate("pickup", "Pick up the task: $1\n\nThen work.\n\nOptional extra instructions: ${@:2}");
  const trailing = classifyPrompt("Pick up the task: reward-sync\n\nThen work.\n\nOptional extra instructions: ", {
    templates: [pickup],
  });
  assert.deepEqual([trailing.match, trailing.args], ["full", "reward-sync"]);
  const trimmed = classifyPrompt("Pick up the task: reward-sync\n\nThen work.\n\nOptional extra instructions:", {
    templates: [pickup],
  });
  assert.deepEqual([trimmed.match, trimmed.args], ["full", "reward-sync"]);

  const middle = compileTemplate("pair", "Compare $1 with $2 today.");
  const empty = classifyPrompt("Compare  with main today.", { templates: [middle] });
  assert.deepEqual([empty.match, empty.args], ["full", "main"]);
  const both = classifyPrompt("Compare feature with main today.", { templates: [middle] });
  assert.deepEqual([both.match, both.args], ["full", "feature\nmain"]);
});

test("extension-composed prompts collapse to their arguments", () => {
  const patterns = loadPromptPatterns();
  const instructions = "Review GitLab merge request #35.\n\nUse the glab skill to fetch the MR.\n\n---\n\nmore steps";
  const plain = classifyPrompt(`Focus your review on:\n\n- correctness\n\n---\n\n${instructions}`, { patterns });
  assert.deepEqual([plain.template, plain.match, plain.args], ["mr-review", "pattern", "35"]);

  const extra = `${instructions}\n\n---\n\nAdditional focus / context from the reviewer for this MR:\nCheck HSCTR-77 handling.`;
  const withContext = classifyPrompt(extra, { patterns, templates: [] });
  assert.deepEqual([withContext.args, withContext.scanText], ["35\nCheck HSCTR-77 handling.", "35\nCheck HSCTR-77 handling."]);

  assert.equal(classifyPrompt("Please review GitLab merge request #35 soon", { patterns }).template, null);
});

test("long templates match in linear time", () => {
  const words = Array.from({ length: 20000 }, (_, i) => `word${i}`).join(" ");
  const long = compileTemplate("init", `Set up the repo. The argument $@ selects a path.\n\n${words}\n\nIf $1 is set, skip questions.`);
  const prompt = `Set up the repo. The argument fast selects a path.\n\n${words}\n\nIf fast is set, skip questions.`;
  assert.deepEqual(classifyPrompt(prompt, { templates: [long] }).template, "init");
});

test("inferProvider picks the provider that most often answered with the model", () => {
  const tally = new Map([["claude-opus-5-5", new Map([["keystone", 10], ["anthropic-vertex", 2]])]]);
  assert.equal(inferProvider("claude-opus-5-5", tally), "keystone");
  assert.equal(inferProvider("unknown-model", tally), null);
});

test("parseJiraProjectKey reads block and inline forms", () => {
  assert.equal(parseJiraProjectKey("login: me\nproject:\n    key: HSCTR\n    type: \"\"\nserver: x\n"), "HSCTR");
  assert.equal(parseJiraProjectKey("project: ABC\n"), "ABC");
  assert.equal(parseJiraProjectKey("server: x\n"), null);
});

test("price corrections are well formed", () => {
  for (const c of loadCorrections()) {
    assert.ok(c.id && c.provider && c.model && c.source, `incomplete correction ${JSON.stringify(c)}`);
    for (const rates of [c.wrong, c.right]) {
      assert.deepEqual(Object.keys(rates).sort(), ["cacheRead", "cacheWrite", "input", "output"]);
    }
  }
});
