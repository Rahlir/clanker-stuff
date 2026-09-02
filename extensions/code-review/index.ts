/**
 * Code Review extension - spawns a read-only pi subprocess to review changes.
 *
 * Two ways to run a review, over one shared job registry:
 *   - Blocking (default): `code_review` starts a subprocess and awaits it, streaming
 *     progress into the tool row and returning the full report. This is the original
 *     workflow, unchanged.
 *   - Async: `code_review` with `wait: false` returns a job id immediately; the review
 *     keeps running in the background. Collect it later by blocking on
 *     `code_review_await`, peek without blocking via `code_review_status`, or stop it
 *     with `code_review_cancel`.
 *
 * Concurrency comes from starting several reviews (native parallel tool calls run
 * them at once), one model per job.
 *
 * Configuration resolution (highest precedence first):
 *   model/thinking: tool param -> env (CODE_REVIEW_MODEL / CODE_REVIEW_THINKING)
 *     -> user config (${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review.json)
 *     -> bundled config.json next to this file -> hardcoded fallback
 *   reviewer prompt: env (CODE_REVIEW_PROMPT_FILE)
 *     -> user file (${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review-reviewer-prompt.md)
 *     -> bundled reviewer-prompt.md next to this file
 *
 * User config lives outside the package so package updates never clobber it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionUIContext,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatElapsed, formatToolCall, formatUsage, stepCount } from "./format.ts";
import {
  ABORTED,
  type ActivityItem,
  appendStderr,
  applyEventLine,
  createReviewState,
  getFinalOutput,
  MAX_ACTIVITY_ITEMS,
  parseFailureSummary,
  raceAbort,
  type ReviewState,
  type ReviewUsage,
} from "./review-state.ts";

interface ReviewConfig {
  model?: string;
  thinking?: string;
}

const SIGKILL_DELAY_MS = 3000;
const PROGRESS_THROTTLE_MS = 100;
/** Ceiling on concurrently running reviews so async starts can't spawn unboundedly. */
const MAX_RUNNING_JOBS = 4;

type ReviewMode = "review" | "await" | "started" | "status" | "cancel";
type JobStatus = "running" | "done" | "failed" | "cancelled";

interface JobSnapshot {
  id: string;
  model: string;
  status: JobStatus;
  elapsedMs: number;
  activityCount: number;
}

interface ReviewDetails {
  mode: ReviewMode;
  jobId?: string;
  model?: string;
  usage?: ReviewUsage;
  exitCode?: number;
  running?: boolean;
  task?: string;
  activity?: ActivityItem[];
  streamingText?: string;
  jobs?: JobSnapshot[];
  cancelled?: boolean;
  notFound?: boolean;
}

interface ReviewResult {
  content: { type: "text"; text: string }[];
  details: ReviewDetails;
  isError?: boolean;
}

type ReviewUpdate = AgentToolUpdateCallback<ReviewDetails>;

/**
 * A background review subprocess and everything derived from it. Owned by the
 * module-scoped registry, not by any single `execute` call, so it outlives the
 * turn that started it.
 */
interface Job {
  id: string;
  model: string;
  task: string;
  child: ChildProcess;
  status: JobStatus;
  state: ReviewState;
  /** Final result, set once the subprocess closes. */
  outcome?: ReviewResult;
  /** Resolves (never rejects) with the outcome when the subprocess closes. */
  done: Promise<ReviewResult>;
  /** Attached `onUpdate` callbacks from executes currently blocking on this job. */
  listeners: Set<ReviewUpdate>;
  /** Schedule a throttled progress notification to all listeners. */
  notify: () => void;
  startedAt: number;
  endedAt?: number;
  cancelReason?: string;
  killTimer?: ReturnType<typeof setTimeout>;
  errorBeforeClose?: Error;
  /** True once the terminal outcome has been handed to the agent; only then is it prunable. */
  delivered?: boolean;
}

// Registry is module-scoped: on /reload a fresh module instance starts empty, and
// the old instance's children are killed by the session_shutdown handler. Finished
// jobs are retained so status/await can still fetch results, bounded by pruneFinishedJobs.
const jobs = new Map<string, Job>();
let jobCounter = 0;

const WIDGET_KEY = "code-review";
/** Cap on retained finished jobs so a long session's registry stays bounded. */
const MAX_FINISHED_JOBS = 20;

// Captured at session_start so background job callbacks (which run outside any turn)
// can update the widget. Undefined outside interactive UI.
let uiHandle: ExtensionUIContext | undefined;

function runningJobs(): Job[] {
  return [...jobs.values()].filter((job) => job.status === "running");
}

/**
 * Running jobs with no execute attached: the ones only the widget surfaces. A
 * blocking or awaited call attaches its onUpdate listener, so it renders in its
 * tool row instead. (In non-TUI modes uiHandle is undefined and the widget is inert,
 * so a blocking call that ran without an onUpdate can't leak into a visible widget.)
 */
function backgroundJobs(): Job[] {
  return runningJobs().filter((job) => job.listeners.size === 0);
}

/** Show detached running reviews in a widget above the editor; clear it when none. */
function refreshWidget(): void {
  if (!uiHandle) return;
  const background = backgroundJobs();
  if (background.length === 0) {
    uiHandle.setWidget(WIDGET_KEY, undefined);
    return;
  }
  const theme = uiHandle.theme;
  const lines = [theme.fg("muted", `Background code reviews (${background.length}):`)];
  for (const job of background) {
    const snap = snapshotJob(job);
    const steps = stepCount(snap.activityCount);
    lines.push(
      theme.fg("warning", "\u23f3 ") +
        theme.fg("accent", snap.id) +
        theme.fg("dim", `  ${formatElapsed(snap.elapsedMs)}  ${steps}  ${snap.model}`),
    );
  }
  uiHandle.setWidget(WIDGET_KEY, lines);
}

/**
 * Drop the oldest *collected* finished jobs once retention exceeds the cap.
 * Uncollected results are kept indefinitely so a pending await/status never loses
 * a report it hasn't returned yet.
 */
function pruneFinishedJobs(): void {
  const prunable = [...jobs.values()]
    .filter((job) => job.status !== "running" && job.delivered)
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (let i = 0; i < prunable.length - MAX_FINISHED_JOBS; i++) {
    jobs.delete(prunable[i].id);
  }
}

function getExtensionDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function getUserConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "pi-clanker");
}

/**
 * Report a non-fatal problem. Prefers the session UI because a bare console write
 * lands on pi's alternate screen in fullscreen mode, painting over the viewport
 * and vanishing on the next repaint. Falls back to stderr before session_start
 * and in headless modes, where there is no UI to notify.
 */
function warn(message: string): void {
  if (uiHandle) uiHandle.notify(`[code_review] ${message}`, "warning");
  else console.error(`[code_review] ${message}`);
}

function readJsonConfig(file: string): ReviewConfig {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    const config: ReviewConfig = {};
    if (typeof parsed.model === "string") config.model = parsed.model;
    if (typeof parsed.thinking === "string") config.thinking = parsed.thinking;
    return config;
  } catch (e) {
    const isNotFound = (e as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) warn(`Failed to read ${file}: ${(e as Error).message}`);
    return {};
  }
}

// Bundled defaults shipped with the package, overlaid by the user's external
// config so package updates never clobber user settings.
function readConfig(): ReviewConfig {
  const bundled = readJsonConfig(path.join(getExtensionDir(), "config.json"));
  const user = readJsonConfig(path.join(getUserConfigDir(), "code-review.json"));
  return { ...bundled, ...user };
}

function getReviewerPromptPath(): string {
  const envPath = process.env.CODE_REVIEW_PROMPT_FILE?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  const userPath = path.join(getUserConfigDir(), "code-review-reviewer-prompt.md");
  if (fs.existsSync(userPath)) return userPath;
  return path.join(getExtensionDir(), "reviewer-prompt.md");
}

const FALLBACK_MODEL = "openai-codex/gpt-5.4";

function resolveModel(paramsModel?: string, configModel?: string): { model: string; isFallback: boolean } {
  const effective = paramsModel?.trim() || configModel?.trim() || FALLBACK_MODEL;
  const isFallback = !paramsModel?.trim() && !configModel?.trim();
  return { model: effective, isFallback };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  // Bun virtual filesystem - can't use script path directly
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  // Direct script invocation - reuse current runtime + script
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  // If execPath is a named binary (not node/bun), use it directly
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  // Fallback: assume `pi` is in PATH
  return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// Job registry
// ---------------------------------------------------------------------------

interface StartOptions {
  task: string;
  model: string;
  thinking?: string;
  promptPath: string;
  cwd: string;
}

/**
 * Spawn a reviewer subprocess and register it as a job. Returns immediately; the
 * job's `done` promise resolves when the subprocess closes. Does not await.
 */
function startJob(opts: StartOptions): Job {
  const piArgs = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-prompt-templates",
    "--tools", "read,grep,find,ls,bash",
    "--model", opts.model,
    ...(opts.thinking ? ["--thinking", opts.thinking] : []),
    "--append-system-prompt", opts.promptPath,
    opts.task,
  ];
  const invocation = getPiInvocation(piArgs);
  const state = createReviewState(opts.model);
  const child = spawn(invocation.command, invocation.args, {
    cwd: opts.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let resolveDone!: (result: ReviewResult) => void;
  const done = new Promise<ReviewResult>((resolve) => {
    resolveDone = resolve;
  });

  const id = `cr-${++jobCounter}`;
  const job: Job = {
    id,
    model: opts.model,
    task: opts.task,
    child,
    status: "running",
    state,
    done,
    listeners: new Set(),
    notify: () => {},
    startedAt: Date.now(),
    delivered: false,
  };
  jobs.set(id, job);
  pruneFinishedJobs();

  // Throttle progress so a chatty subprocess doesn't flood the renderer. Each flush
  // also refreshes the widget, so detached jobs (no listeners) still show progress.
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let progressPending = false;
  const flush = () => {
    progressTimer = null;
    progressPending = false;
    if (job.listeners.size > 0) {
      const partial = partialResult(job);
      for (const listener of job.listeners) listener(partial);
    }
    refreshWidget();
  };
  job.notify = () => {
    if (progressTimer) {
      progressPending = true;
      return;
    }
    flush();
    progressTimer = setTimeout(() => {
      if (progressPending) flush();
      else progressTimer = null;
    }, PROGRESS_THROTTLE_MS);
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let buffer = "";
  child.stdout?.on("data", (data: string) => {
    buffer += data;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) applyEventLine(state, line);
    job.notify();
  });
  child.stderr?.on("data", (data: string) => {
    appendStderr(state, data);
  });
  // 'close' still fires after 'error', so finalize happens there.
  child.on("error", (err) => {
    job.errorBeforeClose = err;
  });
  child.on("close", (code: number | null, closeSignal: string | null) => {
    if (buffer.trim()) applyEventLine(state, buffer);
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    if (job.killTimer) {
      clearTimeout(job.killTimer);
      job.killTimer = undefined;
    }
    if (job.errorBeforeClose) {
      state.stderr = `Spawn error: ${job.errorBeforeClose.message}\n${state.stderr}`.trim();
    }
    // Signal-based termination is a failure, not a clean exit.
    const exitCode = job.errorBeforeClose ? 1 : closeSignal ? 128 : (code ?? 0);
    finalizeJob(job, exitCode, resolveDone);
  });

  return job;
}

function finalizeJob(job: Job, exitCode: number, resolveDone: (result: ReviewResult) => void): void {
  const output = getFinalOutput(job.state.messages);
  job.endedAt = Date.now();

  let outcome: ReviewResult;
  if (job.cancelReason) {
    job.status = "cancelled";
    outcome = {
      content: [{ type: "text", text: `Code review ${job.id} was cancelled.` }],
      details: baseDetails(job, false, "review", { exitCode, cancelled: true }),
      isError: true,
    };
  } else if (exitCode !== 0 || !output) {
    job.status = "failed";
    const errorMsg = job.state.stderr || output || "(no output from reviewer)";
    // Malformed stdout often explains the failure, so it rides along with stderr.
    const parseNote = parseFailureSummary(job.state);
    outcome = {
      content: [
        { type: "text", text: `Code review failed (exit ${exitCode}): ${errorMsg}${parseNote ? `\n${parseNote}` : ""}` },
      ],
      details: baseDetails(job, false, "review", { exitCode }),
      isError: true,
    };
  } else {
    job.status = "done";
    outcome = {
      content: [{ type: "text", text: output }],
      details: baseDetails(job, false, "review", { exitCode }),
    };
  }

  job.outcome = outcome;
  resolveDone(outcome);
  // Deliver the terminal state to anyone still attached, then drop the finished job
  // from the background widget.
  for (const listener of job.listeners) listener(outcome);
  refreshWidget();
}

/** SIGTERM the job's subprocess, escalating to SIGKILL. No-op if not running. */
function killJob(job: Job, reason: string): boolean {
  if (job.status !== "running") return false;
  job.cancelReason ??= reason;
  // A kill is already in flight; don't send a second SIGTERM or orphan its timer.
  if (job.killTimer) return true;
  try {
    job.child.kill("SIGTERM");
  } catch {
    return false;
  }
  const timer = setTimeout(() => {
    try {
      job.child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, SIGKILL_DELAY_MS);
  timer.unref();
  job.killTimer = timer;
  return true;
}

/**
 * Block on a job's completion, streaming progress to `onUpdate`. On abort, either
 * kill the job (blocking `code_review`) or detach and leave it running (`await`).
 */
async function attachAndWait(
  job: Job,
  signal: AbortSignal | undefined,
  onUpdate: ReviewUpdate | undefined,
  onAbort: "kill" | "detach",
): Promise<ReviewResult> {
  // Already finished: hand back the stored outcome (marking it collected) regardless
  // of signal state.
  if (job.status !== "running" && job.outcome) {
    job.delivered = true;
    return job.outcome;
  }

  if (onUpdate) job.listeners.add(onUpdate);
  // Attaching hides the job from the widget; its tool row now shows progress.
  refreshWidget();
  try {
    const raced = await raceAbort(job.done, signal);
    if (raced === ABORTED) {
      if (onAbort === "kill") {
        killJob(job, "aborted");
        const outcome = await job.done;
        job.delivered = true;
        return outcome;
      }
      return stillRunningResult(job);
    }
    job.delivered = true;
    return raced;
  } finally {
    if (onUpdate) job.listeners.delete(onUpdate);
    // Detaching may return a still-running job to the widget.
    refreshWidget();
  }
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function baseDetails(
  job: Job,
  running: boolean,
  mode: ReviewMode,
  extra: Partial<ReviewDetails> = {},
): ReviewDetails {
  return {
    mode,
    jobId: job.id,
    model: job.state.resolvedModel,
    usage: { ...job.state.usage },
    running,
    task: job.task,
    activity: job.state.activity,
    streamingText: job.state.streamingText,
    ...extra,
  };
}

function partialResult(job: Job): ReviewResult {
  const output = getFinalOutput(job.state.messages);
  return {
    content: [{ type: "text", text: output || "(reviewing...)" }],
    details: baseDetails(job, true, "review"),
  };
}

function startedResult(job: Job): ReviewResult {
  return {
    content: [
      {
        type: "text",
        text:
          `Started review ${job.id} (${job.model}). It runs in the background; ` +
          `continue with other work. Block for the result with code_review_await "${job.id}", ` +
          `peek with code_review_status, or stop it with code_review_cancel "${job.id}".`,
      },
    ],
    details: { mode: "started", jobId: job.id, model: job.model, running: true, task: job.task },
  };
}

function stillRunningResult(job: Job): ReviewResult {
  return {
    content: [
      {
        type: "text",
        text:
          `Review ${job.id} is still running (detached by the abort). Call code_review_await "${job.id}" ` +
          `to keep waiting, code_review_status to peek, or code_review_cancel "${job.id}" to stop it.`,
      },
    ],
    details: baseDetails(job, true, "await"),
  };
}

function errorResult(text: string, details: ReviewDetails): ReviewResult {
  return { content: [{ type: "text", text }], details, isError: true };
}

function notFoundResult(jobId: string, mode: ReviewMode): ReviewResult {
  return errorResult(
    `Unknown review job "${jobId}". It may never have existed, was already collected and dropped from the registry, or the session was reloaded (which clears background reviews).`,
    { mode, jobId, notFound: true, running: false },
  );
}

function snapshotJob(job: Job): JobSnapshot {
  return {
    id: job.id,
    model: job.state.resolvedModel || job.model,
    status: job.status,
    elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
    activityCount: job.state.activity.length,
  };
}

function snapshotLine(snapshot: JobSnapshot): string {
  const steps = stepCount(snapshot.activityCount);
  return `${snapshot.id}  ${snapshot.status}  ${formatElapsed(snapshot.elapsedMs)}  ${steps}  ${snapshot.model}`;
}

function statusResult(job: Job): ReviewResult {
  if (job.status !== "running" && job.outcome) {
    job.delivered = true;
    return { ...job.outcome, details: { ...job.outcome.details, mode: "status" } };
  }
  const output = getFinalOutput(job.state.messages);
  const body = output ? `\n\n${output}` : "\n\n(no output yet)";
  return {
    content: [{ type: "text", text: snapshotLine(snapshotJob(job)) + body }],
    details: baseDetails(job, true, "status"),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderRunningFeed(
  container: Container,
  details: ReviewDetails,
  options: ToolRenderResultOptions,
  theme: Theme,
): void {
  const items = details.activity ?? [];
  const streaming = details.streamingText ?? "";
  const toShow = options.expanded ? items : items.slice(-MAX_ACTIVITY_ITEMS);
  const skipped = options.expanded ? 0 : items.length - toShow.length;

  if (skipped > 0) {
    container.addChild(new Text(theme.fg("muted", `... ${skipped} earlier items`), 0, 0));
  }
  for (const item of toShow) {
    if (item.type === "toolCall") {
      container.addChild(
        new Text(theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
      );
    } else {
      const preview = item.text.length > 80 ? `${item.text.slice(0, 80)}...` : item.text;
      container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
    }
  }
  if (streaming) {
    const lines = streaming.split("\n");
    const previewLines = options.expanded ? lines : lines.slice(-3);
    if (!options.expanded && lines.length > 3) {
      container.addChild(new Text(theme.fg("muted", `... ${lines.length - 3} earlier lines`), 0, 0));
    }
    container.addChild(new Text(theme.fg("toolOutput", previewLines.join("\n")), 0, 0));
  }
  if (items.length === 0 && !streaming) {
    container.addChild(new Text(theme.fg("muted", "(starting reviewer...)"), 0, 0));
  }
}

/** Shared renderer for the blocking `code_review` result and `code_review_await`. */
function renderReview(result: AgentToolResult<ReviewDetails>, options: ToolRenderResultOptions, theme: Theme): Container {
  const details = result.details;
  const firstContent = result.content[0];
  const output = firstContent?.type === "text" ? firstContent.text : "(no output)";

  const container = new Container();
  const isStarted = details?.mode === "started";
  const isRunning = !isStarted && details?.running === true;
  const isError =
    !isRunning &&
    !isStarted &&
    ((result as { isError?: boolean }).isError === true ||
      (typeof details?.exitCode === "number" && details.exitCode !== 0));

  const icon = isRunning
    ? theme.fg("warning", "\u23f3")
    : isStarted
      ? theme.fg("accent", "\u2192")
      : isError
        ? theme.fg("error", "\u2717")
        : theme.fg("success", "\u2713");
  let header = `${icon} ${theme.fg("toolTitle", theme.bold("Code Review"))}`;
  if (details?.jobId) header += theme.fg("muted", ` ${details.jobId}`);
  if (details?.model) header += theme.fg("muted", ` [${details.model}]`);
  container.addChild(new Text(header, 0, 0));

  // Async start: just confirm the job launched.
  if (isStarted) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
    return container;
  }

  if (options.expanded && details?.task) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", details.task), 0, 0));
  }
  container.addChild(new Spacer(1));

  if (isRunning) {
    renderRunningFeed(container, details, options, theme);
  } else {
    container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
  }

  if (details?.usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", formatUsage(details.usage, details.model ?? "")), 0, 0));
  }

  return container;
}

function statusColor(status: JobStatus): ThemeColor {
  if (status === "running") return "warning";
  if (status === "done") return "success";
  return "error";
}

function renderStatus(result: AgentToolResult<ReviewDetails>, _options: ToolRenderResultOptions, theme: Theme): Container {
  const details = result.details;
  const container = new Container();
  container.addChild(new Text(theme.fg("toolTitle", theme.bold("Code Reviews")), 0, 0));
  container.addChild(new Spacer(1));

  const snapshots = details?.jobs;
  if (snapshots && snapshots.length > 0) {
    for (const snapshot of snapshots) {
      const steps = stepCount(snapshot.activityCount);
      const line =
        theme.fg("accent", snapshot.id) +
        theme.fg(statusColor(snapshot.status), `  ${snapshot.status}`) +
        theme.fg("dim", `  ${formatElapsed(snapshot.elapsedMs)}  ${steps}  ${snapshot.model}`);
      container.addChild(new Text(line, 0, 0));
    }
    return container;
  }

  const firstContent = result.content[0];
  const output = firstContent?.type === "text" ? firstContent.text : "";
  container.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
  return container;
}

function renderSimple(result: AgentToolResult<ReviewDetails>, theme: Theme, title: string): Container {
  const details = result.details;
  const container = new Container();
  const isError = (result as { isError?: boolean }).isError === true;
  const icon = isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
  let header = `${icon} ${theme.fg("toolTitle", theme.bold(title))}`;
  if (details?.jobId) header += theme.fg("muted", ` ${details.jobId}`);
  container.addChild(new Text(header, 0, 0));
  const firstContent = result.content[0];
  const output = firstContent?.type === "text" ? firstContent.text : "";
  if (output) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
  }
  return container;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Cache config at registration time for use in renderCall.
  let cachedConfig = readConfig();

  // Capture the session UI so background job callbacks can drive the widget.
  pi.on("session_start", (_event, ctx) => {
    uiHandle = ctx.hasUI ? ctx.ui : undefined;
    refreshWidget();
  });

  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description:
      "Run a code review subagent on recent changes. Spawns a read-only pi subprocess that analyzes git diff output and returns structured feedback with severity levels (Critical, Major, Minor). Blocks and returns the report by default; pass wait=false to start it in the background and collect it later with code_review_await.",
    promptGuidelines: [
      "Only use code_review when the user explicitly asks to run a code review tool or subagent. Do not call code_review just because the user says 'review this code' - handle simple review requests yourself without spawning a subprocess.",
      "When calling code_review, always specify which files you changed and what the changes do in the task parameter. The reviewer has no context about your work.",
      "code_review returns issues categorized as Critical, Major, or Minor. Do not fix issues unless the user explicitly asks you to.",
      "To review with several models at once, issue multiple code_review calls in one message (they run concurrently), or start each with wait=false and collect them with code_review_await.",
      "Use code_review with wait=false only when you have other work to do while the review runs; otherwise keep the default blocking behavior.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          'What to review. Be specific: list the files you changed and what the changes do. E.g. "Review my changes to src/auth.ts and src/middleware.ts where I added rate limiting."',
      }),
      focus: Type.Optional(
        Type.String({
          description: 'Optional focus area for the review, e.g. "security", "error handling".',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            'Model to use for review, e.g. "anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.4". Defaults to configured model.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: 'Thinking level for the reviewer, e.g. "off", "medium", "high". Defaults to configured thinking level.',
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "Whether to block until the review finishes (default true). Set false to start the review in the background and get a job id to collect later with code_review_await.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<ReviewResult> {
      // Re-read config on each invocation so edits take effect without /reload.
      const config = readConfig();
      cachedConfig = config;
      const envModel = process.env.CODE_REVIEW_MODEL?.trim();
      const { model, isFallback } = resolveModel(params.model, envModel || config.model);
      if (isFallback) {
        ctx.ui.notify(
          `code_review: No model specified in params, env, or config, using fallback: ${FALLBACK_MODEL}`,
          "warning",
        );
      }

      const promptPath = getReviewerPromptPath();
      if (!fs.existsSync(promptPath)) {
        return errorResult(`Reviewer prompt not found: ${promptPath}`, { mode: "review", model, running: false });
      }

      if (runningJobs().length >= MAX_RUNNING_JOBS) {
        return errorResult(
          `Too many reviews already running (limit ${MAX_RUNNING_JOBS}). Collect one with code_review_await or stop one with code_review_cancel before starting another.`,
          { mode: "review", model, running: false },
        );
      }

      let task = params.task;
      if (params.focus) {
        task += `\n\nFocus especially on: ${params.focus}`;
      }
      const envThinking = process.env.CODE_REVIEW_THINKING?.trim();
      const thinking = params.thinking?.trim() || envThinking || config.thinking?.trim();

      const job = startJob({ task, model, thinking, promptPath, cwd: ctx.cwd });

      if (params.wait === false) {
        refreshWidget();
        return startedResult(job);
      }
      return attachAndWait(job, signal, onUpdate, "kill");
    },

    renderCall(args, theme) {
      const { model } = resolveModel(args.model, cachedConfig.model);
      let label = theme.fg("toolTitle", theme.bold("code_review"));
      label += theme.fg("muted", ` [${model}]`);
      if (args.wait === false) label += theme.fg("dim", " (async)");
      const taskPreview = args.task?.length > 80 ? `${args.task.slice(0, 80)}...` : args.task;
      if (taskPreview) {
        label += "\n  " + theme.fg("dim", taskPreview);
      }
      if (args.focus) {
        label += "\n  " + theme.fg("dim", `focus: ${args.focus}`);
      }
      return new Text(label, 0, 0);
    },

    renderResult(result, options, theme) {
      return renderReview(result, options, theme);
    },
  });

  pi.registerTool({
    name: "code_review_await",
    label: "Await Code Review",
    description:
      "Block until a previously started (wait=false) code review finishes, then return its report. Pressing Esc detaches and leaves the review running in the background; it does not stop it.",
    promptGuidelines: [
      "Use code_review_await to collect the result of a review you started with code_review wait=false, once you are ready to block for it.",
    ],
    parameters: Type.Object({
      jobId: Type.String({ description: 'The review job id returned by code_review, e.g. "cr-1".' }),
    }),

    async execute(_toolCallId, params, signal, onUpdate): Promise<ReviewResult> {
      const job = jobs.get(params.jobId);
      if (!job) return notFoundResult(params.jobId, "await");
      return attachAndWait(job, signal, onUpdate, "detach");
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("code_review_await")) + theme.fg("muted", ` ${args.jobId ?? ""}`),
        0,
        0,
      );
    },

    renderResult(result, options, theme) {
      return renderReview(result, options, theme);
    },
  });

  pi.registerTool({
    name: "code_review_status",
    label: "Code Review Status",
    description:
      "Report the status of background code reviews without blocking. With a jobId, returns that review's state (and its report if finished); without one, lists all reviews in this session.",
    promptGuidelines: [
      "Use code_review_status to check whether a background review is done. Do not call it repeatedly in a loop; when you actually want the result, use code_review_await instead.",
    ],
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({ description: 'Optional review job id. Omit to list every review in this session.' }),
      ),
    }),

    async execute(_toolCallId, params): Promise<ReviewResult> {
      if (params.jobId) {
        const job = jobs.get(params.jobId);
        if (!job) return notFoundResult(params.jobId, "status");
        return statusResult(job);
      }
      const all = [...jobs.values()];
      if (all.length === 0) {
        return {
          content: [{ type: "text", text: "No code reviews have been started in this session." }],
          details: { mode: "status", jobs: [] },
        };
      }
      const snapshots = all.map(snapshotJob);
      return {
        content: [{ type: "text", text: snapshots.map(snapshotLine).join("\n") }],
        details: { mode: "status", jobs: snapshots },
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("code_review_status")) + theme.fg("muted", args.jobId ? ` ${args.jobId}` : ""),
        0,
        0,
      );
    },

    renderResult(result, options, theme) {
      return renderStatus(result, options, theme);
    },
  });

  pi.registerTool({
    name: "code_review_cancel",
    label: "Cancel Code Review",
    description: "Stop a running background code review and discard its result.",
    promptGuidelines: ["Use code_review_cancel to stop a background review you no longer need."],
    parameters: Type.Object({
      jobId: Type.String({ description: 'The review job id to cancel, e.g. "cr-1".' }),
    }),

    async execute(_toolCallId, params): Promise<ReviewResult> {
      const job = jobs.get(params.jobId);
      if (!job) return notFoundResult(params.jobId, "cancel");
      if (job.status !== "running") {
        job.delivered = true;
        return {
          content: [{ type: "text", text: `Review ${job.id} already ${job.status}; nothing to cancel.` }],
          details: { mode: "cancel", jobId: job.id, model: job.state.resolvedModel, running: false },
        };
      }
      killJob(job, "cancelled");
      await job.done;
      job.delivered = true;
      return {
        content: [{ type: "text", text: `Cancelled review ${job.id}.` }],
        details: { mode: "cancel", jobId: job.id, model: job.state.resolvedModel, running: false, cancelled: true },
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("code_review_cancel")) + theme.fg("muted", ` ${args.jobId ?? ""}`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      return renderSimple(result, theme, "Cancel Code Review");
    },
  });

  // Background jobs are owned by this module instance; kill their subprocesses when
  // the session tears down (quit or /reload) so they don't leak. SIGKILL synchronously
  // rather than the graceful SIGTERM+timer path: the host may exit before a deferred
  // timer could fire, and the reviewer holds no state that needs a clean shutdown.
  pi.on("session_shutdown", async () => {
    const pending: Promise<unknown>[] = [];
    for (const job of jobs.values()) {
      if (job.status !== "running") continue;
      if (job.killTimer) {
        clearTimeout(job.killTimer);
        job.killTimer = undefined;
      }
      job.cancelReason ??= "shutdown";
      try {
        job.child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      pending.push(job.done);
    }
    // Wait for the killed children to close so the runtime isn't torn down mid-reap.
    await Promise.all(pending);
    uiHandle?.setWidget(WIDGET_KEY, undefined);
    uiHandle = undefined;
  });
}
