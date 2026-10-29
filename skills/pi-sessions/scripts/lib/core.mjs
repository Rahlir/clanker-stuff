// Pure session-log logic for the pi-sessions skill: parsed session entries in,
// corpus rows out. Nothing here imports pi or touches the file system, so the
// tests run it on fixtures. The two pi-owned pieces, the session tree and the
// skill-block format, arrive as inputs (`activeIds`, `parseSkillBlock`).

// Idle gaps at or above this length are breaks, not work.
export const GAP_CAP_MS = 30 * 60 * 1000;

// clanker-stuff 6df6f15 made code_review report reviewer spend as the tool
// result's top-level `usage`. Older results carry it only in `details.usage`.
export const REVIEW_USAGE_FIX_MS = Date.parse("2026-10-20T15:21:25Z");

const KNOWN_TYPES = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "usage",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "context_edit",
  "label",
  "session_info",
]);

// Entries that end a gap the user spent (typing, picking a model), as opposed
// to a gap spent waiting for the agent.
const USER_SIDE_TYPES = new Set(["model_change", "thinking_level_change", "session_info", "label"]);
const USER_SIDE_ROLES = new Set(["user", "bashExecution"]);

// Work is conversation and spend. Everything else is housekeeping that also
// happens when an old session is merely reopened or renamed (memory
// re-injection, model switches, session names), so it must not make a
// session look active.
const WORK_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

const REVIEW_TOOLS = new Set(["code_review", "code_review_await", "code_review_status", "code_review_cancel"]);

const ARGS_CAP = 64 * 1024;
const RESULT_CAP = 4000;
const PAYLOAD_CAP = 8000;
const KEY_ARG_CAP = 300;

// ---------------------------------------------------------------------------
// Lines, times, refs
// ---------------------------------------------------------------------------

/** Parse JSONL text, counting what could not be parsed instead of hiding it. */
export function parseLines(text) {
  const entries = [];
  let lines = 0;
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (value && typeof value === "object" && typeof value.type === "string") entries.push(value);
    else malformed++;
  }
  return { entries, lines, malformed, missingFinalNewline: text.length > 0 && !text.endsWith("\n") };
}

/**
 * Resolve a CLI time argument. Relative values count back from `now` in local
 * calendar units; a bare date means local midnight.
 */
export function parseWhen(value, now = new Date()) {
  const text = String(value).trim();
  if (text === "all") return new Date(0);
  if (text === "now") return new Date(now);
  const rel = /^(\d+)([hdwm])$/.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date(now);
    if (rel[2] === "h") d.setTime(d.getTime() - n * 3_600_000);
    else if (rel[2] === "d") d.setDate(d.getDate() - n);
    else if (rel[2] === "w") d.setDate(d.getDate() - 7 * n);
    else d.setMonth(d.getMonth() - n);
    return d;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const ms = Date.parse(text);
  if (!Number.isNaN(ms)) return new Date(ms);
  throw new Error(`cannot read time "${value}": use 90d, 2w, 3m, 12h, YYYY-MM-DD, an ISO timestamp, now, or all`);
}

const pad = (n) => String(n).padStart(2, "0");

/** ISO timestamp of the UTC hour containing `ms`: the active-time bucket key. */
export function hourStart(ms) {
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function toMs(ts) {
  const ms = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

const toIso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * Stable session refs: `S` + local creation time as YYMMDD-HHMM, with b, c, ...
 * for sessions created in the same minute. Pass every known session, not just
 * the ones in a build range, so a ref never depends on the range.
 */
export function assignRefs(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const ms = new Date(s.created).getTime();
    let base;
    if (Number.isNaN(ms)) base = `Sx${String(s.id).slice(0, 8)}`;
    else {
      const d = new Date(ms);
      base = `S${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    }
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push({ path: s.path, id: String(s.id), ms });
  }
  const refs = new Map();
  for (const [base, group] of groups) {
    group.sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    group.forEach((s, i) => {
      const suffix = i === 0 ? "" : i < 26 ? String.fromCharCode(97 + i) : `x${i}`;
      refs.set(s.path, base + suffix);
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Prompt templates and skills
// ---------------------------------------------------------------------------

// pi's template substitutions: $1, $@, $ARGUMENTS, ${1:-default}, ${@:N:L}.
const PLACEHOLDER = /\$(?:\d+|@|ARGUMENTS)|\$\{(?:\d+|@)(?::-[^}]*|:\d+(?::\d+)?)?\}/g;

function stripFrontmatter(markdown) {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  return m ? markdown.slice(m[0].length) : markdown;
}

/**
 * Compile a prompt template file into a matcher. `segments` are the literal
 * pieces between placeholders, whitespace collapsed, used to recover the
 * arguments from an expanded prompt; `prefix` still names the template when
 * its text has changed since the prompt was sent (arguments are then unknown).
 */
export function compileTemplate(name, markdown) {
  const body = stripFrontmatter(markdown).trim();
  if (!body) return null;
  const parts = body.split(PLACEHOLDER);
  const firstLine = (parts[0].split("\n").find((l) => l.trim()) ?? "").trim();
  return {
    name,
    lines: new Set(body.split("\n").map(lineKey).filter(Boolean)),
    segments: parts.map((p) => p.replace(/\s+/g, " ")),
    prefix: firstLine.length >= 16 ? firstLine : null,
    head: parts[0].trim().split(/\s+/)[0] || null,
    hasArgs: parts.length > 1,
    weight: parts.reduce((n, p) => n + p.length, 0),
  };
}

const lineKey = (line) => line.replace(/\s+/g, " ").trim();

// Whitespace runs become one space; `map[i]` is the original index of norm[i].
function normalizeSpace(text) {
  const chars = [];
  const map = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text[i]);
    if (space && inSpace) continue;
    chars.push(space ? " " : text[i]);
    map.push(i);
    inSpace = space;
  }
  map.push(text.length);
  return { norm: chars.join(""), map };
}

// Match literal segments left to right (each placeholder takes the shortest
// span, the last segment must end the prompt) and return the original text of
// each placeholder, or null. Linear in the prompt length, unlike a regex built
// from a long template.
//
// An empty argument between two literals that both carry whitespace leaves
// one collapsed space, which the previous literal already consumed; `at` may
// then sit one before `pos`.
function matchSegments({ norm, map }, text, segments) {
  const start = norm.startsWith(" ") ? 1 : 0;
  const end = norm.trimEnd().length;
  if (!norm.startsWith(segments[0], start)) return null;
  let pos = start + segments[0].length;
  const sharesSpace = (seg, at) => at === pos - 1 && seg.startsWith(" ") && norm[at] === " ";
  const capture = (at) => (at > pos ? text.slice(map[pos], map[at]) : "");
  const captures = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (i === segments.length - 1) {
      const tail = seg.trimEnd();
      if (!tail) {
        captures.push(capture(end));
        return captures;
      }
      const at = end - tail.length;
      if ((at < pos && !sharesSpace(tail, at)) || norm.slice(at, end) !== tail) return null;
      captures.push(capture(at));
      return captures;
    }
    const at = sharesSpace(seg, pos - 1) && norm.startsWith(seg.slice(1), pos) ? pos - 1 : norm.indexOf(seg, pos);
    if (at < 0) {
      // A template ending in "literal $arg" can be expanded and trimmed with
      // an empty arg, losing the literal's trailing space.
      const trimmed = seg.trimEnd();
      const tailAt = end - trimmed.length;
      if (i === segments.length - 2 && !segments[i + 1].trim() && trimmed !== seg && tailAt >= pos) {
        if (norm.slice(tailAt, end) === trimmed) return [...captures, capture(tailAt), ""];
      }
      return null;
    }
    captures.push(capture(at));
    pos = at + seg.length;
  }
  return pos >= end ? captures : null;
}

/**
 * Name the template or skill a prompt came from. `scanText` is the part the
 * user actually wrote, used for ticket detection and search: template and
 * skill bodies are boilerplate and would only produce false matches.
 * `match` is "full" when the template text was recovered exactly (so `args`
 * is reliable), "pattern" for a prompt an extension composed (see
 * assets/prompt-patterns.json), and "prefix" when only a template's first line
 * matched.
 */
export function classifyPrompt(text, { templates = [], patterns = [], parseSkillBlock } = {}) {
  const none = { template: null, skill: null, args: null, match: null, scanText: text };
  const skill = parseSkillBlock?.(text);
  if (skill) {
    const args = skill.userMessage ?? null;
    return { ...none, skill: skill.name, args, match: "full", scanText: args ?? "" };
  }
  for (const p of patterns) {
    if (p.contains && !text.includes(p.contains)) continue;
    const m = p.re.exec(text);
    if (!m) continue;
    const args = m.slice(1).map((s) => s?.trim()).filter(Boolean).join("\n") || null;
    return { ...none, template: p.name, args, match: "pattern", scanText: args ?? "" };
  }
  const trimmed = text.trimStart();
  let normalized = null;
  let full = null;
  let partial = null;
  for (const t of templates) {
    if (t.head && !trimmed.startsWith(t.head)) continue;
    normalized ??= normalizeSpace(text);
    const captures = matchSegments(normalized, text, t.segments);
    if (captures) {
      if (!full || t.weight > full.t.weight) full = { t, captures };
    } else if (t.prefix && trimmed.startsWith(t.prefix)) {
      if (!partial || t.prefix.length > partial.prefix.length) partial = t;
    }
  }
  if (full) {
    const captured = full.t.hasArgs ? [...new Set(full.captures.map((s) => s.trim()).filter(Boolean))] : [];
    const args = captured.length ? captured.join("\n") : null;
    return { ...none, template: full.t.name, args, match: "full", scanText: args ?? "" };
  }
  if (partial) {
    // The prompt was sent with a template version that is not committed, so
    // the arguments cannot be cut out exactly. Keep the lines that appear in
    // no known version: the user's words plus whatever the template changed.
    const known = new Set(templates.filter((t) => t.name === partial.name).flatMap((t) => [...t.lines]));
    const residual = text
      .split("\n")
      .filter((l) => lineKey(l) && !known.has(lineKey(l)))
      .join("\n");
    return { ...none, template: partial.name, match: "prefix", scanText: residual };
  }
  return none;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= Math.max(Math.abs(b) * tolerance, 1e-12);

/**
 * Apply a known price correction when the recorded cost was computed with the
 * wrong rate table. Detection compares the recorded cost with what the wrong
 * rates would give, so a late /reload after the rate fix is handled per entry.
 * With per-bucket costs (pi's Usage) one differing bucket decides; with only a
 * total (legacy review receipts) the totals must differ by more than 2% to
 * tell the tables apart.
 */
export function correctCost({ provider, model, tokens, components, recorded }, corrections = []) {
  if (recorded == null) return { corrected: null, correction: null };
  const c = corrections.find((x) => x.provider === provider && x.model === model);
  if (!c) return { corrected: recorded, correction: null };
  if (components) {
    const probe = RATE_KEYS.find((k) => (tokens[k] ?? 0) > 0 && c.wrong[k] !== c.right[k]);
    if (!probe || !near(components[probe] ?? 0, (tokens[probe] * c.wrong[probe]) / 1e6)) {
      return { corrected: recorded, correction: null };
    }
    let delta = 0;
    for (const k of RATE_KEYS) {
      if (c.wrong[k]) delta += (components[k] ?? 0) * (c.right[k] / c.wrong[k] - 1);
    }
    return { corrected: recorded + delta, correction: c.id };
  }
  const price = (rates) => RATE_KEYS.reduce((sum, k) => sum + ((tokens[k] ?? 0) * rates[k]) / 1e6, 0);
  const wrong = price(c.wrong);
  const right = price(c.right);
  if (!near(wrong, right, 0.02) && near(recorded, wrong)) return { corrected: right, correction: c.id };
  return { corrected: recorded, correction: null };
}

/** Turn a usage row from `extractSession` into its corpus row, with corrections applied. */
export function priceUsage(row, corrections = []) {
  const { tokens, components, recorded, ...rest } = row;
  const { corrected, correction } = correctCost(
    { provider: row.provider, model: row.model, tokens, components, recorded },
    corrections,
  );
  return {
    ...rest,
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cache_read: tokens.cacheRead ?? 0,
    cache_write: tokens.cacheWrite ?? 0,
    cost_recorded: recorded,
    cost_corrected: corrected,
    correction,
  };
}

/** Identity of an entry across the sessions a fork or clone copied it into. */
export const entryKey = (e) => `${e.id}\u0000${e.timestamp}`;

/**
 * Counts each copied entry once across sessions fed to it oldest first. A
 * fork or clone's entries older than the session itself are copies; one is
 * skipped when an earlier session already counted it, so the original, or the
 * oldest surviving copy when the original was deleted, holds it. pi's /import
 * copies a session file verbatim (same id, no parentSession), so a second file
 * with a session id already seen skips every entry already counted.
 */
export function createCopyLedger() {
  const counted = new Set();
  const ids = new Set();
  return {
    skipFor(header) {
      const imported = header.id != null && ids.has(header.id);
      ids.add(header.id);
      if (imported) return (e) => counted.has(entryKey(e));
      const created = header.parentSession ? Date.parse(header.timestamp) : Number.NaN;
      return (e) => Date.parse(e.timestamp) < created && counted.has(entryKey(e));
    },
    record(entries, inherited) {
      const skipped = new Set(inherited.map((r) => r.entry_id));
      for (const e of entries) if (!skipped.has(e.id)) counted.add(entryKey(e));
    },
  };
}

/** Most frequent provider seen answering with `model`, from a model -> provider -> count tally. */
export function inferProvider(model, tally) {
  const counts = tally.get(model);
  if (!counts) return null;
  let best = null;
  for (const [provider, n] of counts) if (!best || n > best.n) best = { provider, n };
  return best?.provider ?? null;
}

function usageParts(usage) {
  const tokens = {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  };
  if (usage.cost && typeof usage.cost === "object") {
    return { tokens, components: usage.cost, recorded: usage.cost.total ?? null };
  }
  return { tokens, components: null, recorded: typeof usage.cost === "number" ? usage.cost : null };
}

function splitModel(value) {
  if (typeof value !== "string" || !value) return [null, null];
  const i = value.indexOf("/");
  return i > 0 ? [value.slice(0, i), value.slice(i + 1)] : [null, value];
}

// ---------------------------------------------------------------------------
// Session extraction
// ---------------------------------------------------------------------------

/** The text blocks of a message's content, joined. */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();

const KEY_ARGS = ["command", "path", "file_path", "url", "query", "pattern", "jobId", "task", "lesson"];

/** The one argument that best identifies a tool call in a one-line listing. */
export function keyArg(args) {
  if (!args || typeof args !== "object") return null;
  const pick = (v) => typeof v === "string" && v.trim();
  const value = KEY_ARGS.map((k) => args[k]).find(pick) ?? Object.values(args).find(pick);
  return value ? collapse(value).slice(0, KEY_ARG_CAP) : null;
}

function cap(text, limit) {
  return text.length > limit ? text.slice(0, limit) : text;
}

function ticketMatcher(projects) {
  const keys = (projects ?? []).filter((p) => /^[A-Z][A-Z0-9_]*$/.test(p));
  return keys.length ? new RegExp(`\\b(?:${keys.join("|")})-\\d{1,7}\\b`, "g") : null;
}

/**
 * Build every corpus row for one session.
 *
 * `input.entries` are pi's (already migrated) entries in file order and
 * `input.activeIds` the ids on the active branch; abandoned branches still
 * count for cost and time but are flagged everywhere else. Usage rows come back
 * unpriced (see `priceUsage`); rows whose provider is unknown have
 * `provider: null` so the caller can infer it from the whole corpus.
 *
 * `ctx.skipCopy(entry)` says whether an entry is a fork or clone's copy that
 * another session already counts (see the callers for the rule). Skipped
 * copies produce no rows but still carry state forward (model, thinking level,
 * name) and are listed in `inherited`.
 */
export function extractSession(input, ctx = {}) {
  const { ref, path, header, entries, activeIds } = input;
  const onActive = (e) => (activeIds.has(e.id) ? 1 : 0);
  const tickets = ticketMatcher(ctx.jiraProjects);

  const out = {
    session: null,
    usage: [],
    turns: [],
    prompts: [],
    toolCalls: [],
    events: [],
    activeTime: [],
    tickets: [],
    fts: [],
    inherited: [],
    stats: {
      types: new Map(),
      unknown: new Map(),
      orphanResults: 0,
      repeatedReceipts: 0,
      lateReceipts: 0,
      // No readable time: kept, but outside every window and the timeline.
      badTimestamps: 0,
      modelProviders: [],
    },
  };

  const resultsByCall = new Map();
  const callIds = new Set();
  let firstTopLevelReviewMs = Number.POSITIVE_INFINITY;
  for (const e of entries) {
    if (e.type !== "message") continue;
    const m = e.message ?? {};
    if (m.role === "toolResult") {
      resultsByCall.set(m.toolCallId, e);
      if (REVIEW_TOOLS.has(m.toolName) && m.usage) {
        firstTopLevelReviewMs = Math.min(firstTopLevelReviewMs, toMs(e.timestamp) ?? Number.POSITIVE_INFINITY);
      }
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === "toolCall") callIds.add(b.id);
    }
  }

  const ticketHits = new Map();
  const scanTickets = (text, source, e) => {
    if (!tickets || !text) return;
    for (const key of text.match(tickets) ?? []) {
      const k = `${key}\u0000${source}\u0000${e.id}`;
      const hit = ticketHits.get(k);
      if (hit) hit.count++;
      else ticketHits.set(k, { ref, key, source, entry_id: e.id, ts: toIso(toMs(e.timestamp)), count: 1 });
    }
  };

  const callsById = new Map();
  const jobModels = new Map();
  // Before the fix, code_review returned the finished job's receipt again on
  // every await or status call. Receipts already counted, per job id; a new
  // "started" receipt clears its job id, because ids restart at cr-1 after a
  // reload and a new job may legitimately cost the same.
  const legacySeen = new Map();
  // Jobs whose usage arrived top-level (the fixed extension), and late legacy
  // receipts already reported.
  const deliveredJobs = new Set();
  const lateSeen = new Set();
  // Review bookkeeping for one code_review result: "counted" for a legacy
  // receipt seen for the first time, "repeat" for one already counted, "late"
  // for a legacy receipt after the fix that is reported but not counted, else
  // null. Copied entries replay it too, so a fork does not recount a receipt
  // its parent owns.
  const trackReview = (m, d, ms) => {
    if (d.mode === "started" && d.jobId) {
      if (typeof d.model === "string") jobModels.set(d.jobId, d.model);
      legacySeen.delete(d.jobId);
      deliveredJobs.delete(d.jobId);
    }
    if (m.usage && d.jobId) deliveredJobs.add(d.jobId);
    const legacyShape =
      !m.usage && (d.mode === "review" || d.mode === "status") && d.running !== true && d.usage && typeof d.usage === "object" && ms != null;
    if (!legacyShape) return null;
    const u = d.usage;
    const receipt = JSON.stringify([d.model ?? null, u.input, u.output, u.cacheRead, u.cacheWrite, u.cost]);
    if (ms >= REVIEW_USAGE_FIX_MS) {
      // The fixed extension puts usage on a job's first delivery, so a
      // details-only result for a job never delivered that way comes from an
      // extension loaded before the fix. Its spend is not counted (that could
      // double count), but it is reported, once per job.
      if (d.jobId && deliveredJobs.has(d.jobId)) return null;
      const key = `${d.jobId ?? ""}\u0000${receipt}`;
      if (lateSeen.has(key)) return null;
      lateSeen.add(key);
      return "late";
    }
    if (ms >= firstTopLevelReviewMs) return null;
    const seen = legacySeen.get(d.jobId ?? null) ?? new Set();
    if (seen.has(receipt)) return "repeat";
    seen.add(receipt);
    legacySeen.set(d.jobId ?? null, seen);
    return "counted";
  };
  const timeline = [];
  let currentModel = { provider: null, model: null };
  let thinking = null;
  let lastAssistantMs = null;
  let name = null;
  let firstPrompt = null;
  let lastWorkMs = null;
  let work = false;

  const pushUsage = (e, source, provider, model, providerSource, usage, tool = null) => {
    out.usage.push({
      ref,
      entry_id: e.id,
      ts: toIso(toMs(e.timestamp)),
      source,
      tool,
      provider,
      model,
      provider_source: provider ? providerSource : null,
      on_active_branch: onActive(e),
      ...usageParts(usage),
    });
  };

  const pushEvent = (e, type, subtype) => {
    const payload = JSON.stringify(e);
    out.events.push({
      ref,
      entry_id: e.id ?? null,
      ts: toIso(toMs(e.timestamp)),
      type,
      subtype: subtype ?? null,
      payload_json: cap(payload, PAYLOAD_CAP),
      payload_chars: payload.length,
      on_active_branch: onActive(e),
    });
  };

  for (const e of entries) {
    const types = out.stats.types;
    types.set(e.type, (types.get(e.type) ?? 0) + 1);
    const ms = toMs(e.timestamp);
    if (ms == null) out.stats.badTimestamps++;
    const ts = toIso(ms);
    if (ctx.skipCopy?.(e)) {
      out.inherited.push({ ref, entry_id: e.id, ts });
      if (e.type === "model_change") currentModel = { provider: e.provider ?? null, model: e.modelId ?? null };
      else if (e.type === "thinking_level_change") thinking = e.thinkingLevel ?? thinking;
      else if (e.type === "session_info") name = e.name?.trim() || null;
      else if (e.type === "message" && e.message?.role === "assistant") {
        currentModel = { provider: e.message.provider ?? null, model: e.message.model ?? null };
      } else if (e.type === "message" && e.message?.role === "toolResult" && REVIEW_TOOLS.has(e.message.toolName)) {
        const d = e.message.details && typeof e.message.details === "object" ? e.message.details : {};
        trackReview(e.message, d, ms);
      }
      continue;
    }

    let userSide = USER_SIDE_TYPES.has(e.type);
    let timed = true;
    work = false;

    if (e.type === "message") {
      const m = e.message ?? {};
      userSide = USER_SIDE_ROLES.has(m.role);
      work = WORK_ROLES.has(m.role);

      if (m.role === "user") {
        const text = textOf(m.content);
        const cls = classifyPrompt(text, ctx);
        const hasImages = Array.isArray(m.content) && m.content.some((b) => b?.type === "image");
        out.prompts.push({
          ref,
          entry_id: e.id,
          ts,
          template: cls.template,
          skill: cls.skill,
          template_match: cls.match,
          args: cls.args,
          text,
          has_images: hasImages ? 1 : 0,
          gap_before_s: lastAssistantMs != null && ms != null ? (ms - lastAssistantMs) / 1000 : null,
          on_active_branch: onActive(e),
        });
        firstPrompt ??= { text, template: cls.template, skill: cls.skill };
        scanTickets(cls.scanText, "prompt", e);
        const marker = cls.template ? `[/${cls.template}]` : cls.skill ? `[/skill:${cls.skill}]` : null;
        const searchable = marker ? `${marker} ${cls.scanText}`.trim() : text;
        if (searchable) out.fts.push({ text: searchable, ref, entry_id: e.id, kind: "prompt", ts });
      } else if (m.role === "assistant") {
        const provider = m.provider ?? null;
        const model = m.model ?? null;
        currentModel = { provider, model };
        if (model) out.stats.modelProviders.push([model, provider]);
        if (m.usage) pushUsage(e, "assistant", provider, model, "recorded", m.usage);
        const blocks = Array.isArray(m.content) ? m.content : [];
        const text = textOf(blocks);
        const calls = blocks.filter((b) => b?.type === "toolCall");
        out.turns.push({
          ref,
          entry_id: e.id,
          ts,
          provider,
          model,
          thinking_level: m.thinkingLevel ?? thinking,
          stop_reason: m.stopReason ?? null,
          error: typeof m.errorMessage === "string" ? cap(m.errorMessage, 500) : null,
          duration_ms: m.durationMs ?? null,
          text_chars: text.length,
          tool_calls: calls.length,
          on_active_branch: onActive(e),
        });
        for (const b of calls) {
          callsById.set(b.id, b);
          const r = resultsByCall.get(b.id);
          const rm = r?.message;
          const argsJson = JSON.stringify(b.arguments ?? {});
          const resultText = rm ? textOf(rm.content) : null;
          out.toolCalls.push({
            ref,
            call_id: b.id ?? null,
            entry_id: e.id,
            ts,
            name: b.name ?? null,
            key_arg: keyArg(b.arguments),
            args_json: cap(argsJson, ARGS_CAP),
            args_chars: argsJson.length,
            result_entry_id: r?.id ?? null,
            result_ts: r ? toIso(toMs(r.timestamp)) : null,
            is_error: rm ? (rm.isError ? 1 : 0) : null,
            result_text: resultText == null ? null : cap(resultText, RESULT_CAP),
            result_chars: resultText?.length ?? null,
            duration_ms: rm?.durationMs ?? null,
            on_active_branch: onActive(e),
          });
          scanTickets(argsJson, "tool_args", e);
        }
        if (text) out.fts.push({ text, ref, entry_id: e.id, kind: "assistant", ts });
        if (ms != null) lastAssistantMs = ms;
      } else if (m.role === "toolResult") {
        // An interactive tool's run time is the user answering its UI.
        userSide = Boolean(ctx.interactiveTools?.has(m.toolName));
        if (!callIds.has(m.toolCallId)) {
          // No call to join it to, so keep it as an event instead of dropping it.
          out.stats.orphanResults++;
          pushEvent(e, "message", "toolResult");
        }
        const d = m.details && typeof m.details === "object" ? m.details : {};
        if (REVIEW_TOOLS.has(m.toolName)) {
          const receipt = trackReview(m, d, ms);
          if (receipt === "repeat") out.stats.repeatedReceipts++;
          if (receipt === "late") out.stats.lateReceipts++;
          const legacy = receipt === "counted";
          if (m.usage || legacy) {
            const who = reviewModel(d, callsById.get(m.toolCallId)?.arguments, jobModels);
            const source = m.usage ? "tool_result" : "review_legacy";
            pushUsage(e, source, who.provider, who.model, who.source, m.usage ?? d.usage, m.toolName);
          }
        } else if (m.usage) {
          const [provider, model] = splitModel(d.model);
          pushUsage(e, "tool_result", provider, model, "recorded", m.usage, m.toolName ?? null);
        }
      } else {
        pushEvent(e, "message", m.role ?? null);
      }
    } else {
      let subtype = null;
      if (e.type === "model_change") {
        currentModel = { provider: e.provider ?? null, model: e.modelId ?? null };
        subtype = e.provider && e.modelId ? `${e.provider}/${e.modelId}` : (e.modelId ?? null);
      } else if (e.type === "thinking_level_change") {
        thinking = e.thinkingLevel ?? thinking;
        subtype = e.thinkingLevel ?? null;
      } else if (e.type === "usage") {
        // Spend, not activity: pi records background calls here, such as cache
        // warming pings every few minutes of idle. Kept off the timeline, or the
        // pings would bridge a break into one long active stretch.
        timed = false;
        subtype = e.kind ?? null;
        if (e.usage) pushUsage(e, `usage:${e.kind ?? "unknown"}`, e.provider ?? null, e.model ?? null, "recorded", e.usage);
      } else if (e.type === "compaction" || e.type === "branch_summary") {
        // A summary is work whoever wrote it; one an extension supplied has no usage.
        subtype = e.type === "branch_summary" ? (e.fromId ?? null) : null;
        work = true;
        if (e.usage) pushUsage(e, e.type, currentModel.provider, currentModel.model, "session", e.usage);
      } else if (e.type === "custom" || e.type === "custom_message") {
        subtype = e.customType ?? null;
      } else if (e.type === "label") {
        subtype = e.label ?? null;
      } else if (e.type === "session_info") {
        name = e.name?.trim() || null;
        subtype = name;
        scanTickets(name, "session_name", e);
        if (name) out.fts.push({ text: name, ref, entry_id: e.id, kind: "name", ts });
      } else if (e.type === "context_edit") {
        subtype = e.targetId ?? null;
      } else if (!KNOWN_TYPES.has(e.type)) {
        const unknown = out.stats.unknown;
        unknown.set(e.type, (unknown.get(e.type) ?? 0) + 1);
      }
      pushEvent(e, e.type, subtype);
    }

    if (ms != null && timed) {
      timeline.push({ ms, userSide, work });
      if (work) lastWorkMs = Math.max(lastWorkMs ?? ms, ms);
    }
  }

  out.activeTime = activeTime(ref, timeline);
  out.tickets = [...ticketHits.values()];
  out.session = {
    ref,
    id: header.id,
    path,
    cwd: header.cwd || null,
    repo: ctx.repo ?? header.cwd ?? null,
    name,
    parent_path: header.parentSession ?? null,
    created: toIso(toMs(header.timestamp)),
    last_activity: toIso(lastWorkMs ?? toMs(header.timestamp)),
    first_prompt: firstPrompt ? cap(firstPrompt.text, 500) : null,
    first_template: firstPrompt?.template ?? null,
    first_skill: firstPrompt?.skill ?? null,
    version: input.version ?? header.version ?? 1,
    lines: input.lines ?? null,
    malformed_lines: input.malformed ?? 0,
    entries: entries.length,
    abandoned_entries: entries.filter((e) => !activeIds.has(e.id)).length,
    inherited_entries: out.inherited.length,
  };
  return out;
}

// In "review" mode code_review records the bare model id, so the provider
// comes from the job's "started" result or the call's `model` argument; when
// neither names it, the caller infers it from the corpus.
function reviewModel(details, callArgs, jobModels) {
  let [provider, model] = splitModel(details.model);
  let source = provider ? "recorded" : null;
  for (const [candidate, from] of [
    [details.jobId ? jobModels.get(details.jobId) : undefined, "job"],
    [callArgs?.model, "args"],
  ]) {
    if (provider) break;
    const [p, m] = splitModel(candidate);
    if (p && (!model || m === model)) {
      provider = p;
      model ??= m;
      source = from;
    }
  }
  return { provider, model, source };
}

/**
 * Attention time per UTC hour, in the hour each gap ends.
 *
 * The timeline splits into stretches at breaks of GAP_CAP_MS or more. A
 * stretch counts only if it contains work, so reopening an old session (memory
 * re-injection, model switches, a rename) adds nothing, while opening one,
 * picking a model and typing the first prompt all count.
 *
 * A gap is the user's when the next work entry is theirs (a prompt, a `!`
 * command, or the result of an interactive tool such as a questionnaire) and
 * the agent's otherwise. Looking ahead matters because extensions
 * write housekeeping entries (settings markers, memory, system prompt updates)
 * at the moment a prompt is submitted, so the typing gap ends at one of those.
 * Trailing housekeeping with no work after it, such as renaming the session,
 * goes by its own side.
 *
 * Hourly buckets keep window edges within an hour; local days and weeks are
 * derived at query time.
 */
export function activeTime(ref, timeline) {
  const sorted = [...timeline].sort((a, b) => a.ms - b.ms);
  const hours = new Map();
  const add = (ms, gap, user) => {
    const hour = hourStart(ms);
    const slot = hours.get(hour) ?? { userMs: 0, agentMs: 0 };
    if (user) slot.userMs += gap;
    else slot.agentMs += gap;
    hours.set(hour, slot);
  };
  let start = 0;
  for (let end = 1; end <= sorted.length; end++) {
    if (end < sorted.length && sorted[end].ms - sorted[end - 1].ms < GAP_CAP_MS) continue;
    const stretch = sorted.slice(start, end);
    start = end;
    if (!stretch.some((x) => x.work)) continue;
    const userWaits = new Array(stretch.length);
    let nextWork = null;
    for (let i = stretch.length - 1; i >= 0; i--) {
      if (stretch[i].work) nextWork = stretch[i];
      userWaits[i] = (nextWork ?? stretch[i]).userSide;
    }
    for (let i = 1; i < stretch.length; i++) {
      const gap = stretch[i].ms - stretch[i - 1].ms;
      if (gap > 0) add(stretch[i].ms, gap, userWaits[i]);
    }
  }
  return [...hours].map(([hour, s]) => ({ ref, hour, user_s: s.userMs / 1000, agent_s: s.agentMs / 1000 }));
}
