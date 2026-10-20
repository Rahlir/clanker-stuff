/**
 * Pure state core for the code-review extension: the accumulator that turns a
 * reviewer subprocess's JSON event stream into displayable state, plus a couple
 * of dependency-free control-flow helpers.
 *
 * Kept free of pi runtime imports (only `import type`) so it can be unit-tested
 * without booting the agent. The impure job registry in `index.ts` drives a real
 * child process into `applyEventLine` / `appendStderr` and blocks on `raceAbort`.
 */

import type { Message, Usage } from "@earendil-works/pi-ai";

/**
 * Usage summary persisted in tool-result `details`. Old sessions render it on resume and
 * session analysis reads it as the cost source for logs that predate top-level `usage`,
 * so keep its shape stable.
 */
export interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export type ActivityItem =
  | { type: "toolCall"; name: string; args: Record<string, unknown> }
  | { type: "text"; text: string };

/** Everything accumulated from one reviewer subprocess. */
export interface ReviewState {
  messages: Message[];
  /** Reviewer spend in pi's shape, handed to pi as the tool result's `usage`. */
  usage: Usage;
  turns: number;
  activity: ActivityItem[];
  streamingText: string;
  stderr: string;
  /** Model reported by the subprocess, falling back to the requested model. */
  resolvedModel: string;
  /** Lines of reviewer stdout that were not valid JSON. */
  parseFailures: number;
  /** Newest parse error, kept for diagnostics. */
  lastParseError: string | null;
}

export const MAX_ACTIVITY_ITEMS = 10;
export const MAX_STDERR_LENGTH = 10_000;
const STDERR_TRUNCATION_SUFFIX = "\n... (truncated)";

export function createReviewState(model: string): ReviewState {
  return {
    messages: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    turns: 0,
    activity: [],
    streamingText: "",
    stderr: "",
    resolvedModel: model,
    parseFailures: 0,
    lastParseError: null,
  };
}

/**
 * Add one message's usage into `total`, mirroring pi's `combineUsage`: the optional
 * token splits appear once any message reports them. Missing fields count as zero
 * because reviewer events are untyped JSON, and `total` must stay complete since pi
 * reads e.g. `usage.cost.total` without checks.
 */
function addUsage(total: Usage, u: Partial<Usage>): void {
  total.input += u.input || 0;
  total.output += u.output || 0;
  total.cacheRead += u.cacheRead || 0;
  total.cacheWrite += u.cacheWrite || 0;
  if (u.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + u.cacheWrite1h;
  if (u.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + u.reasoning;
  total.totalTokens += u.totalTokens || 0;
  total.cost.input += u.cost?.input || 0;
  total.cost.output += u.cost?.output || 0;
  total.cost.cacheRead += u.cost?.cacheRead || 0;
  total.cost.cacheWrite += u.cost?.cacheWrite || 0;
  total.cost.total += u.cost?.total || 0;
}

/** The `details.usage` summary of `state`. */
export function reviewUsage(state: ReviewState): ReviewUsage {
  const { input, output, cacheRead, cacheWrite, cost } = state.usage;
  return { input, output, cacheRead, cacheWrite, cost: cost.total, turns: state.turns };
}

/**
 * Mark a finished job as handed to the agent and return the usage that delivery should
 * report. Only the first delivery gets it, so the spend counts once in pi's session
 * totals (footer, `/session`) even when the result is fetched again (status, a second
 * await, cancel after the fact).
 */
export function claimUsage(job: { delivered?: boolean; state: ReviewState }): Usage | undefined {
  if (job.delivered) return undefined;
  job.delivered = true;
  return structuredClone(job.state.usage);
}

export type ParsedLine = { ok: true; event: Record<string, unknown> } | { ok: false; error: string };

/**
 * Parse one line of reviewer stdout; null for the blank lines between events.
 * Malformed JSON comes back as an error rather than a log line: a console write
 * from here paints over pi's fullscreen viewport and is then lost on the next
 * repaint, and the failure is more useful counted in the job's diagnostics.
 */
export function parseEventLine(line: string): ParsedLine | null {
  if (!line.trim()) return null;
  try {
    return { ok: true, event: JSON.parse(line) as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Fold one parsed JSON event into `state`. Mutates in place; callers decide when
 * to surface the change (throttled progress, widget, etc.). Mirrors the subset of
 * pi's `--mode json` events the reviewer emits.
 */
export function applyEvent(state: ReviewState, event: Record<string, unknown>): void {
  if (event.type === "tool_execution_start") {
    const name = event.toolName as string;
    const args = (event.args ?? {}) as Record<string, unknown>;
    state.activity.push({ type: "toolCall", name, args });
    // Bound growth; keep a trailing window that comfortably covers what the UI shows.
    if (state.activity.length > MAX_ACTIVITY_ITEMS * 2) {
      state.activity.splice(0, state.activity.length - MAX_ACTIVITY_ITEMS);
    }
    return;
  }

  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (ame?.type === "text_delta" && typeof ame.delta === "string") {
      state.streamingText += ame.delta;
    }
    return;
  }

  if (event.type === "message_end" && event.message) {
    const msg = event.message as Message;
    state.messages.push(msg);
    if (msg.role === "assistant") {
      state.turns++;
      if (msg.usage) addUsage(state.usage, msg.usage);
      if (msg.model) state.resolvedModel = msg.model;
      // Finalize the streamed text as a discrete activity item.
      if (state.streamingText) {
        state.activity.push({ type: "text", text: state.streamingText });
        state.streamingText = "";
      }
    }
  }
}

export function applyEventLine(state: ReviewState, line: string): void {
  const parsed = parseEventLine(line);
  if (!parsed) return;
  if (parsed.ok) {
    applyEvent(state, parsed.event);
    return;
  }
  state.parseFailures++;
  state.lastParseError = parsed.error;
}

/** One-line summary of malformed reviewer output, or null when there was none. */
export function parseFailureSummary(state: ReviewState): string | null {
  if (state.parseFailures === 0) return null;
  const noun = state.parseFailures === 1 ? "line" : "lines";
  return `${state.parseFailures} unparsable output ${noun} (last: ${state.lastParseError})`;
}

/** Append reviewer stderr, capped so a runaway process can't blow up memory. */
export function appendStderr(state: ReviewState, data: string): void {
  if (state.stderr.length >= MAX_STDERR_LENGTH) return;
  state.stderr = (state.stderr + data).slice(0, MAX_STDERR_LENGTH - STDERR_TRUNCATION_SUFFIX.length);
  if (state.stderr.length >= MAX_STDERR_LENGTH - STDERR_TRUNCATION_SUFFIX.length) {
    state.stderr += STDERR_TRUNCATION_SUFFIX;
  }
}

/** The reviewer's final answer: text of the last assistant message with content. */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const part of content) {
      if (part.type === "text") texts.push(part.text);
    }
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

/** Sentinel returned by `raceAbort` when the signal fires before the promise settles. */
export const ABORTED: unique symbol = Symbol("aborted");

/**
 * Await `promise`, but resolve to `ABORTED` if `signal` aborts first. Rejections
 * from `promise` propagate. Cleans up its own abort listener either way.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      resolve(ABORTED);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}
