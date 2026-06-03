/**
* Code Review extension - spawns a read-only pi subprocess to review changes.
*
* The main agent calls the `code_review` tool, gets structured feedback,
* and can fix issues and re-review in a loop driven by prompt templates.
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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ReviewConfig {
  model?: string;
  thinking?: string;
}

interface ReviewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

const SIGKILL_DELAY_MS = 3000;
const MAX_STDERR_LENGTH = 10_000;
const MAX_ACTIVITY_ITEMS = 10;

type ActivityItem =
  | { type: "toolCall"; name: string; args: Record<string, unknown> }
  | { type: "text"; text: string };

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, fg: (color: string, text: string) => string): string {
  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return fg("muted", "$ ") + fg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return fg("muted", "read ") + fg("accent", shortenPath(rawPath));
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return fg("muted", "grep ") + fg("accent", `/${pattern}/`) + fg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return fg("muted", "find ") + fg("accent", pattern) + fg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return fg("muted", "ls ") + fg("accent", shortenPath(rawPath));
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return fg("accent", toolName) + fg("dim", ` ${preview}`);
    }
  }
}

function getExtensionDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function getUserConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "pi-clanker");
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
    if (!isNotFound) {
      console.error(`[code_review] Failed to read ${file}: ${(e as Error).message}`);
    }
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

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const texts = messages[i].content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return "";
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

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: ReviewUsage, model: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`\u2191${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`\u2193${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export default function (pi: ExtensionAPI) {
  // Cache config at registration time for use in renderCall
  let cachedConfig = readConfig();

  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description:
      "Run a code review subagent on recent changes. Spawns a read-only pi subprocess that analyzes git diff output and returns structured feedback with severity levels (Critical, Major, Minor).",
    promptGuidelines: [
      "Only use code_review when the user explicitly asks to run a code review tool or subagent. Do not call code_review just because the user says 'review this code' - handle simple review requests yourself without spawning a subprocess.",
      "When calling code_review, always specify which files you changed and what the changes do in the task parameter. The reviewer has no context about your work.",
      "code_review returns issues categorized as Critical, Major, or Minor. Do not fix issues unless the user explicitly asks you to.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          'What to review. Be specific: list the files you changed and what the changes do. E.g. "Review my changes to src/auth.ts and src/middleware.ts where I added rate limiting."',
      }),
      focus: Type.Optional(
        Type.String({
          description:
            'Optional focus area for the review, e.g. "security", "error handling".',
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
          description:
            'Thinking level for the reviewer, e.g. "off", "medium", "high". Defaults to configured thinking level.',
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Re-read config on each invocation so edits take effect without /reload
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
        return {
          content: [{ type: "text", text: `Reviewer prompt not found: ${promptPath}` }],
          isError: true,
        };
      }

      // Build the task description
      let task = params.task;
      if (params.focus) {
        task += `\n\nFocus especially on: ${params.focus}`;
      }

      // Build pi subprocess arguments
      const envThinking = process.env.CODE_REVIEW_THINKING?.trim();
      const thinking = params.thinking?.trim() || envThinking || config.thinking?.trim();
      const piArgs = [
        "--mode", "json",
        "-p",
        "--no-session",
        "--no-prompt-templates",
        "--tools", "read,grep,find,ls,bash",
        "--model", model,
        ...(thinking ? ["--thinking", thinking] : []),
        "--append-system-prompt", promptPath,
        task,
      ];

      const messages: Message[] = [];
      const usage: ReviewUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      const activity: ActivityItem[] = [];
      let streamingText = "";
      let stderr = "";
      let resolvedModel = model;

      const exitCode = await new Promise<number>((resolve) => {
        const invocation = getPiInvocation(piArgs);

        let exited = false;
        let errorBeforeClose: Error | null = null;
        let abortHandler: (() => void) | null = null;
        let pendingKillTimer: ReturnType<typeof setTimeout> | null = null;

        const proc = spawn(invocation.command, invocation.args, {
          cwd: ctx.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Register abort handler immediately after spawn, before any async work
        if (signal) {
          abortHandler = () => {
            if (exited) return;
            try {
              proc.kill("SIGTERM");
            } catch {
              return;
            }
            pendingKillTimer = setTimeout(() => {
              if (!exited) {
                try { proc.kill("SIGKILL"); } catch { /* already dead */ }
              }
            }, SIGKILL_DELAY_MS);
            pendingKillTimer.unref();
          };
          if (signal.aborted) abortHandler();
          else signal.addEventListener("abort", abortHandler, { once: true });
        }

        proc.stdout.setEncoding("utf8");
        proc.stderr.setEncoding("utf8");
        let buffer = "";

        const processLine = (line: string) => {
          if (!line.trim()) return;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line);
          } catch (e) {
            console.error(`[code_review] Failed to parse JSON event: ${(e as Error).message}`);
            return;
          }

          // Track tool calls for progress display
          if (event.type === "tool_execution_start") {
            const toolName = event.toolName as string;
            const args = (event.args ?? {}) as Record<string, unknown>;
            activity.push({ type: "toolCall", name: toolName, args });
            // Cap activity array to avoid unbounded growth
            if (activity.length > MAX_ACTIVITY_ITEMS * 2) {
              activity.splice(0, activity.length - MAX_ACTIVITY_ITEMS);
            }
            emitProgress();
          }

          // Track streaming assistant text
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
            if (ame?.type === "text_delta" && typeof ame.delta === "string") {
              streamingText += ame.delta;
              emitProgress();
            }
          }

          if (event.type === "message_end" && event.message) {
            const msg = event.message as Message;
            messages.push(msg);

            if (msg.role === "assistant") {
              usage.turns++;
              const u = msg.usage;
              if (u) {
                usage.input += u.input || 0;
                usage.output += u.output || 0;
                usage.cacheRead += u.cacheRead || 0;
                usage.cacheWrite += u.cacheWrite || 0;
                usage.cost += u.cost?.total || 0;
              }
              if (msg.model) resolvedModel = msg.model;
              // Finalize streaming text as activity item
              if (streamingText) {
                activity.push({ type: "text", text: streamingText });
                streamingText = "";
              }
            }

            emitProgress();
          }
        };

        let progressTimer: ReturnType<typeof setTimeout> | null = null;
        let progressPending = false;
        const PROGRESS_THROTTLE_MS = 100;

        const flushProgress = () => {
          progressPending = false;
          progressTimer = null;
          if (!onUpdate) return;
              const currentOutput = getFinalOutput(messages);
          onUpdate({
            content: [{ type: "text", text: currentOutput || "(reviewing...)" }],
            details: { model: resolvedModel, usage: { ...usage }, running: true, task, activity, streamingText },
          });
        };

        const emitProgress = () => {
          if (!onUpdate) return;
          if (progressTimer) {
            progressPending = true;
            return;
          }
          flushProgress();
          progressTimer = setTimeout(() => {
            if (progressPending) flushProgress();
            else progressTimer = null;
          }, PROGRESS_THROTTLE_MS);
        };

        proc.stdout.on("data", (data: string) => {
          buffer += data;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) processLine(line);
        });

        const TRUNCATION_SUFFIX = "\n... (truncated)";
        proc.stderr.on("data", (data: string) => {
          if (stderr.length >= MAX_STDERR_LENGTH) return;
          stderr = (stderr + data).slice(0, MAX_STDERR_LENGTH - TRUNCATION_SUFFIX.length);
          if (stderr.length >= MAX_STDERR_LENGTH - TRUNCATION_SUFFIX.length) {
            stderr += TRUNCATION_SUFFIX;
          }
        });

        proc.on("close", (code: number | null, closeSignal: string | null) => {
          exited = true;
          if (buffer.trim()) processLine(buffer);
          // Clean up progress throttle timer
          if (progressTimer) {
            clearTimeout(progressTimer);
            progressTimer = null;
          }
          if (errorBeforeClose) {
            stderr = `Spawn error: ${errorBeforeClose.message}\n${stderr}`.trim();
          }
          // Clean up abort listener and kill timer
          if (signal && abortHandler) {
            signal.removeEventListener("abort", abortHandler);
          }
          if (pendingKillTimer !== null) {
            clearTimeout(pendingKillTimer);
            pendingKillTimer = null;
          }
          // Treat signal-based termination as failure, not success
          if (errorBeforeClose) resolve(1);
          else if (closeSignal) resolve(128);
          else resolve(code ?? 0);
        });

        // 'close' still fires after 'error', so we resolve there
        proc.on("error", (err) => {
          errorBeforeClose = err;
        });
      });

      const reviewOutput = getFinalOutput(messages);

      if (exitCode !== 0 || !reviewOutput) {
        const errorMsg = stderr || reviewOutput || "(no output from reviewer)";
        return {
          content: [{ type: "text", text: `Code review failed (exit ${exitCode}): ${errorMsg}` }],
          details: { model: resolvedModel, usage, exitCode, task },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: reviewOutput }],
        details: { model: resolvedModel, usage, exitCode, task },
      };
    },

    renderCall(args, theme) {
      const { model } = resolveModel(args.model, cachedConfig.model);
      let label = theme.fg("toolTitle", theme.bold("code_review"));
      label += theme.fg("muted", ` [${model}]`);
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
      const details = result.details as { model?: string; usage?: ReviewUsage; exitCode?: number; running?: boolean; task?: string; activity?: ActivityItem[]; streamingText?: string } | undefined;
      const firstContent = result.content[0];
      const output = firstContent?.type === "text" ? firstContent.text : "(no output)";

      const container = new Container();

      // Status line: running -> hourglass, error -> cross, success -> tick
      const isRunning = details?.running === true;
      const isError = !isRunning && (result.isError || (details?.exitCode && details.exitCode !== 0));
      const icon = isRunning
        ? theme.fg("warning", "\u23f3")
        : isError
          ? theme.fg("error", "\u2717")
          : theme.fg("success", "\u2713");
      let header = `${icon} ${theme.fg("toolTitle", theme.bold("Code Review"))}`;
      if (details?.model) header += theme.fg("muted", ` [${details.model}]`);
      container.addChild(new Text(header, 0, 0));

      // Show full task in expanded view
      if (options.expanded && details?.task) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", details.task), 0, 0));
      }

      container.addChild(new Spacer(1));

      // Review content
      if (isRunning) {
        const items = details?.activity ?? [];
        const streaming = details?.streamingText ?? "";
        const toShow = options.expanded ? items : items.slice(-MAX_ACTIVITY_ITEMS);
        const skipped = options.expanded ? 0 : items.length - toShow.length;

        if (skipped > 0) {
          container.addChild(new Text(theme.fg("muted", `... ${skipped} earlier items`), 0, 0));
        }
        for (const item of toShow) {
          if (item.type === "toolCall") {
            container.addChild(new Text(
              theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0, 0,
            ));
          } else {
            const preview = item.text.length > 80 ? `${item.text.slice(0, 80)}...` : item.text;
            container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
          }
        }
        // Show streaming text (current partial assistant output)
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
      } else {
        // Finished: full markdown
        container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
      }

      // Usage stats
      if (details?.usage) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", formatUsage(details.usage, details.model ?? "")), 0, 0));
      }

      return container;
    },
  });
}
