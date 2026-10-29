import { existsSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { loadCorrections, loadInteractiveTools, loadPromptPatterns, loadTemplates } from "../config.mjs";
import { assignRefs, extractSession, inferProvider, keyArg, priceUsage, textOf } from "../core.mjs";
import { hours, indent, localStamp, localTime, money, oneLine, short } from "../format.mjs";
import { createRepoResolver, inheritedBefore, loadPi, PissError, readSessionFile } from "../load.mjs";
import { all, findSession, openCorpus } from "../query.mjs";
import { displayText } from "./prompts.mjs";

export const summary = "One session's transcript, read fresh from its file: outline, full, raw entry, or model context.";

export const usage = `piss show <session> [options]

<session> is a ref (S261013-1058), a session id prefix, or a session file
path. The file is read through pi, so sessions outside the corpus work too.
Entries are numbered #1, #2, ... in file order; output is paged.

  --level outline|full   outline (default): your prompts and agent text, one line
                         per tool call. full: also tool results, thinking, and
                         expanded template text
  --branches active|all  abandoned branches collapsed to one line (default) or shown
  --from N               start at entry #N
  --max-chars N          stop the page before N characters (default 30000)
  --max-result N         in full level, cut each tool result after N characters
                         (default 2000)
  --entry ID|#N          print one raw entry as JSON
  --context              print what the model saw at the end of the session
                         (compaction and context edits applied)`;

const OUTLINE_TEXT_CAP = 2500;
const SUMMARY_CAP = 400;
const ENTRY_CAP = 100_000;

async function resolve(key) {
  let row = null;
  let corpus = null;
  try {
    corpus = openCorpus();
  } catch (err) {
    if (!(err instanceof PissError)) throw err;
  }
  // A path may be relative or go through a symlink; the corpus stores the
  // paths pi lists, so try each spelling before treating it as unknown.
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const spellings = existsSync(key) ? [...new Set([key, resolvePath(key), real(key)])] : [key];
  for (const k of corpus ? spellings : []) {
    row = findSession(corpus.db, k);
    if (row) break;
  }
  if (!row && existsSync(key)) row = { path: real(key), ref: null };
  const inCorpus = Boolean(corpus && row?.ref);
  const { pi } = await loadPi();
  if (!row) {
    // Not in the corpus (older than its range, or no corpus yet): refs are
    // assigned over every session, so the same ref still resolves.
    const listed = await pi.SessionManager.listAll();
    const refs = assignRefs(listed);
    const hit = listed.find((s) => refs.get(s.path) === key || s.id.startsWith(key));
    if (!hit) throw new PissError(`no session "${key}"`);
    row = { path: hit.path, ref: refs.get(hit.path) };
  } else if (!row.ref) {
    const listed = await pi.SessionManager.listAll();
    const hit = listed.find((s) => real(s.path) === row.path);
    if (hit) row.path = hit.path;
    row.ref = assignRefs(listed).get(row.path) ?? "S?";
  }
  return { pi, corpus, inCorpus, path: row.path, ref: row.ref, repo: row.repo ?? null };
}

// Copies a fork or clone holds that another session counts: the corpus's
// decision when the session is in it, else every copy while the parent file
// still exists.
function copyFilter(corpus, inCorpus, ref, header) {
  if (inCorpus) {
    const ids = new Set(all(corpus.db, "SELECT entry_id FROM inherited WHERE ref = $ref", { ref }).map((r) => r.entry_id));
    return (e) => ids.has(e.id);
  }
  const cutoff = inheritedBefore(header);
  return (e) => cutoff != null && Date.parse(e.timestamp) < cutoff;
}

// The same provider inference as piss build: the provider most often seen with
// a model, across the corpus when there is one, else within this session.
function providerTally(corpus, pairs) {
  const tally = new Map();
  const add = (model, provider, n) => {
    if (!model || !provider) return;
    if (!tally.has(model)) tally.set(model, new Map());
    tally.get(model).set(provider, (tally.get(model).get(provider) ?? 0) + n);
  };
  if (corpus) {
    for (const r of all(corpus.db, "SELECT model, provider, count(*) n FROM turns GROUP BY model, provider")) add(r.model, r.provider, r.n);
  } else {
    for (const [model, provider] of pairs) add(model, provider, 1);
  }
  return tally;
}

const cap = (text, limit, hint = "--level full or --entry shows all") =>
  limit && text.length > limit ? `${text.slice(0, limit)}\n… (+${text.length - limit} chars; ${hint})` : text;

function toolLine(call, result, cost, level, maxResult) {
  const args = call.arguments ?? {};
  let what = keyArg(args) ?? "";
  if ((call.name === "write" || call.name === "edit") && args.path) {
    const size = JSON.stringify(args).length;
    what = `${args.path} (${size} chars of arguments)`;
  }
  const rm = result?.message;
  let status = "(no result)";
  if (rm) {
    const secs = rm.durationMs != null ? ` ${(rm.durationMs / 1000).toFixed(1)} s` : "";
    status = rm.isError ? `✗${secs} ${oneLine(textOf(rm.content), 160)}` : `✓${secs}`;
  }
  const lines = [`  → ${call.name}  ${oneLine(what, 200)}  ${status}${cost ? ` · ${money(cost)}` : ""}`];
  if (level === "full" && rm) {
    const text = textOf(rm.content);
    if (text) {
      const body = cap(text, maxResult, "raise --max-result or use --entry");
      lines.push(body.split("\n").map((l) => `    │ ${l}`.trimEnd()).join("\n"));
    }
  }
  return lines.join("\n");
}

function renderEntry(e, n, ctx) {
  const { level, maxResult, prompts, turns, costs, results, callIds } = ctx;
  const at = `#${n} ${localTime(e.timestamp, { seconds: true })}`;
  if (e.type === "message") {
    const m = e.message ?? {};
    if (m.role === "user") {
      const p = prompts.get(e.id);
      const text = level === "full" || !p ? textOf(m.content) : displayText(p);
      const images = Array.isArray(m.content) ? m.content.filter((b) => b?.type === "image").length : 0;
      return `${at} you${images ? ` (+${images} images)` : ""}\n${indent(text || "(empty)")}`;
    }
    if (m.role === "assistant") {
      const t = turns.get(e.id);
      const meta = [`${m.provider ?? "?"}/${m.model ?? "?"}`, t?.thinking_level, costs.has(e.id) ? money(costs.get(e.id)) : null];
      if (m.durationMs != null) meta.push(`${(m.durationMs / 1000).toFixed(1)} s`);
      if (m.stopReason && !["stop", "toolUse"].includes(m.stopReason)) meta.push(`${m.stopReason}${m.errorMessage ? `: ${oneLine(m.errorMessage, 160)}` : ""}`);
      const lines = [`${at} agent · ${meta.filter(Boolean).join(" · ")}`];
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b?.type === "thinking" && level === "full" && b.thinking) lines.push(indent(cap(b.thinking, maxResult, "--entry shows all"), "  (thinking) "));
        else if (b?.type === "text" && b.text) lines.push(indent(level === "full" ? b.text : cap(b.text, OUTLINE_TEXT_CAP)));
        else if (b?.type === "toolCall") {
          const r = results.get(b.id);
          lines.push(toolLine(b, r, r ? costs.get(r.id) : null, level, maxResult));
        }
      }
      return lines.join("\n");
    }
    if (m.role === "toolResult") {
      // Results show under their call; one with no call would otherwise vanish.
      if (callIds.has(m.toolCallId)) return null;
      return `${at} result of ${m.toolName ?? "a tool"} with no matching call: ${oneLine(textOf(m.content), 200)}`;
    }
    if (m.role === "system") {
      const sections = Object.keys(m.sections ?? {});
      const tools = (m.toolsAdded ?? []).length;
      return `${at} system prompt (${sections.length ? `sections: ${sections.join(", ")}` : "no sections"}${tools ? `; +${tools} tools` : ""})`;
    }
    if (m.role === "bashExecution") return `${at} you ran !${oneLine(m.command ?? "", 200)}${m.exitCode ? ` (exit ${m.exitCode})` : ""}`;
    return `${at} ${m.role ?? "message"}: ${oneLine(textOf(m.content), 200)}`;
  }
  const full = level === "full";
  switch (e.type) {
    case "model_change":
      return `${at} model → ${e.provider}/${e.modelId}`;
    case "thinking_level_change":
      return `${at} thinking → ${e.thinkingLevel}`;
    case "compaction":
      return `${at} compaction (${e.tokensBefore ?? "?"} tokens before${costs.has(e.id) ? `, ${money(costs.get(e.id))}` : ""})\n${indent(cap(e.summary ?? "", full ? 0 : SUMMARY_CAP))}`;
    case "branch_summary":
      return `${at} branch summary of the path ending at ${e.fromId}\n${indent(cap(e.summary ?? "", full ? 0 : SUMMARY_CAP))}`;
    case "custom":
      return `${at} extension state: ${e.customType}${full ? `\n${indent(cap(JSON.stringify(e.data ?? null), maxResult))}` : ""}`;
    case "custom_message": {
      const text = typeof e.content === "string" ? e.content : textOf(e.content);
      return `${at} injected by ${e.customType}${e.display ? "" : " (hidden)"}\n${indent(cap(text, full ? maxResult : 300))}`;
    }
    case "label":
      return `${at} label ${e.label ? `"${e.label}"` : "cleared"} on ${e.targetId}`;
    case "session_info":
      return `${at} session named "${e.name ?? ""}"`;
    case "context_edit":
      return `${at} context edit: ${e.targetId} ${e.replacement ? "replaced" : "omitted"}`;
    case "usage":
      return `${at} usage ${e.kind} ${e.provider}/${e.model}${costs.has(e.id) ? ` · ${money(costs.get(e.id))}` : ""}`;
    default:
      return `${at} ${e.type} (entry type piss does not know)`;
  }
}

function renderContext(pi, entries, out, { level, from, maxChars }) {
  const projection = pi.buildSessionProjection(entries, entries.at(-1)?.id ?? null);
  out.push(`model context at the leaf: ${projection.messages.length} messages, model ${projection.model ? `${projection.model.provider}/${projection.model.modelId}` : "-"}, thinking ${projection.thinkingLevel}`);
  let used = out.join("\n").length;
  let last = from - 1;
  for (let i = from - 1; i < projection.messages.length; i++) {
    const m = projection.messages[i];
    let text = typeof m.content === "string" ? m.content : textOf(m.content ?? []);
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const calls = m.content.filter((b) => b?.type === "toolCall").map((b) => `→ ${b.name} ${oneLine(keyArg(b.arguments) ?? "", 120)}`);
      if (calls.length) text = [text, ...calls].filter(Boolean).join("\n");
    }
    if (m.role === "compactionSummary" || m.role === "branchSummary") text = m.summary ?? text;
    if (m.role === "system") text = `(system prompt: ${Object.keys(m.sections ?? {}).join(", ")})`;
    const raw = `[${i + 1}] ${m.role}${m.toolName ? ` ${m.toolName}` : ""}\n${indent(level === "full" ? text : cap(text, 1500))}`;
    const chunk = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n… (message cut at --max-chars)` : raw;
    if (i > from - 1 && used + chunk.length > maxChars) break;
    out.push(chunk);
    used += chunk.length + 1;
    last = i + 1;
  }
  out.push("", `messages ${from}-${last} of ${projection.messages.length}${last < projection.messages.length ? `; next page: --context --from ${last + 1}` : ""}`);
}

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      level: { type: "string", default: "outline" },
      branches: { type: "string", default: "active" },
      from: { type: "string", default: "1" },
      "max-chars": { type: "string", default: "30000" },
      "max-result": { type: "string", default: "2000" },
      entry: { type: "string" },
      context: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (positionals.length !== 1) throw new PissError("show needs exactly one session: a ref, a session id prefix, or a path");
  if (!["outline", "full"].includes(values.level)) throw new PissError("--level must be outline or full");
  if (!["active", "all"].includes(values.branches)) throw new PissError("--branches must be active or all");
  const from = Number(values.from.replace(/^#/, ""));
  const maxChars = Number(values["max-chars"]);
  const maxResult = Number(values["max-result"]);
  if (![from, maxChars, maxResult].every((n) => Number.isInteger(n) && n >= 0) || from < 1) {
    throw new PissError("--from, --max-chars and --max-result must be whole numbers (--from at least 1)");
  }

  const { pi, corpus, inCorpus, path, ref, repo } = await resolve(positionals[0]);
  const read = readSessionFile(pi, path);
  if (read.error) throw new PissError(`${short(path)}: ${read.error}`);
  const { header, entries, activeIds } = read;
  const out = [];

  if (values.entry) {
    const key = values.entry.replace(/^#/, "");
    const e = /^\d+$/.test(key) && Number(key) <= entries.length ? entries[Number(key) - 1] : entries.find((x) => x.id === key);
    if (!e) throw new PissError(`no entry "${values.entry}" in ${ref}`);
    const json = JSON.stringify(e, null, 2);
    out.push(`${ref} entry #${entries.indexOf(e) + 1} (${e.id})`, cap(json, ENTRY_CAP, "see below"));
    if (json.length > ENTRY_CAP) out.push(`(truncated: ${json.length} chars; read ${short(path)} with jq for the rest)`);
    console.log(out.join("\n"));
    return 0;
  }

  const agentDir = pi.getAgentDir();
  const skipCopy = copyFilter(corpus, inCorpus, ref, header);
  const rows = extractSession(
    { ...read, path, ref },
    {
      skipCopy,
      templates: loadTemplates(agentDir).templates,
      patterns: loadPromptPatterns(),
      interactiveTools: loadInteractiveTools(),
      parseSkillBlock: pi.parseSkillBlock,
      jiraProjects: [],
      repo: repo ?? createRepoResolver()(header.cwd),
    },
  );
  const corrections = loadCorrections();
  const tally = providerTally(corpus, rows.stats.modelProviders);
  const costs = new Map();
  let costTotal = 0;
  let recordedTotal = 0;
  for (const u of rows.usage) {
    const provider = u.provider ?? (u.model ? inferProvider(u.model, tally) : null);
    const priced = priceUsage({ ...u, provider }, corrections);
    costs.set(u.entry_id, (costs.get(u.entry_id) ?? 0) + (priced.cost_corrected ?? 0));
    costTotal += priced.cost_corrected ?? 0;
    recordedTotal += priced.cost_recorded ?? 0;
  }
  const models = new Map();
  for (const t of rows.turns) models.set(`${t.provider}/${t.model}`, (models.get(`${t.provider}/${t.model}`) ?? 0) + 1);
  const userS = rows.activeTime.reduce((s, a) => s + a.user_s, 0);
  const agentS = rows.activeTime.reduce((s, a) => s + a.agent_s, 0);
  const s = rows.session;
  const count = (type) => entries.filter((e) => e.type === type).length;

  out.push(
    `${ref}  ${short(path)}`,
    `cwd ${short(s.cwd)} · repo ${s.repo === s.cwd ? "same" : short(s.repo)}${s.name ? ` · name "${s.name}"` : ""}${s.parent_path ? ` · forked from ${short(s.parent_path)}` : ""}`,
    `${localStamp(s.created)} to ${localStamp(s.last_activity)} · ${entries.length} entries (${s.abandoned_entries} on abandoned branches` +
      `${s.inherited_entries ? `, ${s.inherited_entries} copies counted in another session` : ""}) · ` +
      `${count("compaction")} compactions · ${count("branch_summary")} branch summaries`,
    `models ${[...models].map(([m, n]) => `${m} (${n} turns)`).join(", ") || "-"} · cost ${money(costTotal)} corrected (${money(recordedTotal)} recorded) · active you ${hours(userS)}, agent ${hours(agentS)}`,
    "",
  );

  if (values.context) {
    renderContext(pi, entries, out, { level: values.level, from, maxChars });
    console.log(out.join("\n"));
    return 0;
  }

  const ctx = {
    level: values.level,
    maxResult,
    prompts: new Map(rows.prompts.map((p) => [p.entry_id, p])),
    turns: new Map(rows.turns.map((t) => [t.entry_id, t])),
    costs,
    results: new Map(
      entries.filter((e) => e.type === "message" && e.message?.role === "toolResult").map((e) => [e.message.toolCallId, e]),
    ),
    callIds: new Set(
      entries
        .filter((e) => e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content))
        .flatMap((e) => e.message.content.filter((b) => b?.type === "toolCall").map((b) => b.id)),
    ),
  };
  let used = out.join("\n").length;
  let day = null;
  let last = from - 1;
  let hidden = null;
  const flush = () => {
    if (!hidden) return true;
    const h = hidden;
    hidden = null;
    const line = `… #${h.first}-#${h.last} abandoned branch: ${h.entries} entries, ${h.turns} agent turns, ${money(h.cost)} (--branches all shows them)`;
    if (emit(line)) return true;
    last = h.first - 1;
    return false;
  };
  const emit = (raw) => {
    if (raw == null) return true;
    // One entry larger than the whole page still goes out, cut to the budget.
    const chunk =
      raw.length > maxChars ? `${raw.slice(0, maxChars)}\n… (entry cut at --max-chars; --entry shows it whole)` : raw;
    if (used + chunk.length > maxChars && out.length > 5) return false;
    out.push(chunk);
    used += chunk.length + 1;
    return true;
  };
  let stopped = false;
  for (let i = from - 1; i < entries.length; i++) {
    const e = entries[i];
    const n = i + 1;
    const abandoned = !activeIds.has(e.id);
    if (abandoned && values.branches === "active") {
      hidden ??= { first: n, last: n, entries: 0, turns: 0, cost: 0 };
      hidden.last = n;
      hidden.entries++;
      if (e.type === "message" && e.message?.role === "assistant") hidden.turns++;
      hidden.cost += costs.get(e.id) ?? 0;
      last = n;
      continue;
    }
    if (!flush()) {
      stopped = true;
      break;
    }
    const thisDay = localStamp(e.timestamp).slice(0, 10);
    const dayLine = thisDay !== day ? `-- ${thisDay}` : null;
    let chunk = renderEntry(e, n, ctx);
    if (chunk != null && abandoned) chunk = `[abandoned] ${chunk}`;
    if (chunk != null && skipCopy(e)) chunk = `[inherited] ${chunk}`;
    if (chunk == null) {
      last = n;
      continue;
    }
    if (!emit(dayLine ? `${dayLine}\n${chunk}` : chunk)) {
      stopped = true;
      break;
    }
    day = thisDay;
    last = n;
  }
  if (!stopped) flush();
  out.push(
    "",
    `entries #${from}-#${last} of ${entries.length}${last < entries.length ? `; next page: --from ${last + 1}` : ""}`,
  );
  console.log(out.join("\n"));
  return 0;
}
