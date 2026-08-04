/**
 * memory: a durable, user-curated `memory.md` per project.
 *
 *   - injected into context at session start (and refreshed after compaction,
 *     after `/edit-memory`, and on resume when the file changed underneath);
 *   - appended to by the agent via the `add_memory` tool, but only when the
 *     user explicitly teaches a lesson;
 *   - pruned by the user via `/edit-memory`.
 *
 * File resolution (once per session, from ctx.cwd):
 *   1. project root = outermost git working tree (submodules climb to the
 *      superproject, linked worktrees collapse onto the main checkout),
 *      falling back to ctx.cwd outside a repo;
 *   2. `<root>/.pi/memory.md` when it exists AND the project is trusted -
 *      the deliberate, team-shared escape hatch;
 *   3. otherwise `<agent-dir>/memory/<encoded-root>/memory.md`, keyed the same
 *      way pi keys session directories.
 *
 * All IO (git, fs, config lookup) lives here; the string logic lives in
 * store.ts and is unit tested.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	appendEntry,
	buildInjectedMessage,
	contentBytes,
	contentDigest,
	encodeRootKey,
	exceedsSizeWarning,
	findDuplicate,
	formatDate,
	formatEntry,
	MEMORY_FILE_NAME,
	memoryFileHeader,
	parseEntries,
	STORE_DIR_NAME,
} from "./store.ts";

const MESSAGE_TYPE = "memory";
/** Guards against a pathological submodule chain; real nesting is 1-2 deep. */
const MAX_SUPERPROJECT_CLIMBS = 8;

interface MemoryLocation {
	root: string;
	file: string;
	scope: "repo" | "store";
}

interface AddMemoryDetails {
	line?: string;
	path?: string;
	error?: boolean;
	duplicate?: string;
}

interface InjectedDetails {
	path: string;
	entryCount: number;
	digest: string;
	refreshed: boolean;
}

function getExtensionDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function getUserConfigDir(): string {
	const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
	return path.join(base, "pi-clanker");
}

/** User override wins over the bundled default so `pi update` never clobbers it. */
function loadPreamble(): string {
	const candidates = [
		path.join(getUserConfigDir(), "memory-preamble.md"),
		path.join(getExtensionDir(), "preamble.md"),
	];
	for (const file of candidates) {
		try {
			return fs.readFileSync(file, "utf-8");
		} catch {
			// try next
		}
	}
	return "";
}

function shortenPath(target: string): string {
	const home = os.homedir();
	return target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

function canonicalize(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function git(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const trimmed = out.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Outermost git working tree containing `cwd`, or `cwd` itself outside a repo.
 *
 * Order matters: a submodule's `--git-common-dir` points into
 * `<super>/.git/modules/...`, which is useless as a key, so climb out of
 * submodules first and only then collapse worktrees. `--git-common-dir` is
 * relative to cwd in a normal checkout and absolute inside a linked worktree;
 * resolving it and stripping a trailing `.git` yields the main checkout in both
 * cases (and the repo itself when it is bare).
 *
 * The result is canonicalized, so the same project reached through a symlink
 * always yields the same store key (git already reports canonical paths; this
 * matters for the no-repo fallback).
 *
 * Exported for tests.
 */
export function resolveProjectRoot(cwd: string): string {
	let root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) return canonicalize(cwd);

	for (let i = 0; i < MAX_SUPERPROJECT_CLIMBS; i++) {
		const superproject = git(root, ["rev-parse", "--show-superproject-working-tree"]);
		if (!superproject) break;
		root = superproject;
	}

	const commonDir = git(root, ["rev-parse", "--git-common-dir"]);
	if (commonDir) {
		const resolved = path.resolve(root, commonDir);
		root = path.basename(resolved) === ".git" ? path.dirname(resolved) : resolved;
	}
	return canonicalize(root);
}

/**
 * An in-repo memory file is content the agent reads and follows, so it is only
 * honored for trusted projects; untrusted repos silently fall back to the
 * personal store.
 */
function resolveMemoryLocation(ctx: ExtensionContext): MemoryLocation {
	const root = resolveProjectRoot(ctx.cwd);
	const inRepo = path.join(root, CONFIG_DIR_NAME, MEMORY_FILE_NAME);
	if (fs.existsSync(inRepo) && ctx.isProjectTrusted()) {
		return { root, file: inRepo, scope: "repo" };
	}
	return {
		root,
		file: path.join(getAgentDir(), STORE_DIR_NAME, encodeRootKey(root), MEMORY_FILE_NAME),
		scope: "store",
	};
}

function readMemory(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

function writeMemory(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

/** Digest of the most recent memory block on this branch, if any. */
function lastInjectedDigest(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE) {
			return (entry.details as InjectedDetails | undefined)?.digest;
		}
	}
	return undefined;
}

export default function memory(pi: ExtensionAPI): void {
	let location: MemoryLocation | null = null;

	function ensureLocation(ctx: ExtensionContext): MemoryLocation {
		if (!location) location = resolveMemoryLocation(ctx);
		return location;
	}

	/** Inject the file verbatim; no-op when there is nothing curated yet. */
	function inject(ctx: ExtensionContext, refreshed: boolean): boolean {
		const loc = ensureLocation(ctx);
		const content = readMemory(loc.file);
		return content ? injectContent(ctx, content, refreshed) : false;
	}

	/** Inject an already-read copy, so callers never read the file twice. */
	function injectContent(ctx: ExtensionContext, content: string, refreshed: boolean): boolean {
		const loc = ensureLocation(ctx);
		const entries = parseEntries(content);
		if (entries.length === 0) return false;

		const displayPath = shortenPath(loc.file);
		const details: InjectedDetails = {
			path: displayPath,
			entryCount: entries.length,
			digest: contentDigest(content),
			refreshed,
		};
		pi.sendMessage({
			customType: MESSAGE_TYPE,
			content: buildInjectedMessage(loadPreamble(), content, { path: displayPath, refreshed }),
			display: true,
			details,
		});
		return true;
	}

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		// "reload" keeps the current context and cwd: nothing to re-resolve, nothing
		// to re-inject, and no reason to nag about size again.
		if (event.reason === "reload") return;

		// Re-resolve per session: /new or /resume can land in a different project.
		location = resolveMemoryLocation(ctx);
		const content = readMemory(location.file);
		if (!content) return;
		const entryCount = parseEntries(content).length;
		if (entryCount === 0) return;

		if (event.reason === "resume") {
			// The restored context already carries a copy; refresh only if another
			// session (or an edit) changed the file since it was injected.
			const previous = lastInjectedDigest(ctx);
			if (previous && previous === contentDigest(content)) return;
			// Only claim to supersede something when there is an earlier copy.
			injectContent(ctx, content, previous !== undefined);
		} else {
			injectContent(ctx, content, false);
		}

		// Pruning is the user's call, so the nudge goes to them, not the model.
		if (exceedsSizeWarning(content) && ctx.hasUI) {
			const kb = Math.round(contentBytes(content) / 1024);
			ctx.ui.notify(
				`Project memory is large (${kb}KB, ${entryCount} entries) and loads every session. Consider /edit-memory to prune.`,
				"warning",
			);
		}
	});

	// Compaction summarizes the injected block away - it is the oldest message in
	// the session - so put a verbatim copy back.
	pi.on("session_compact", async (_event, ctx) => {
		inject(ctx, true);
	});

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as InjectedDetails | undefined;
		const count = details?.entryCount ?? 0;
		const label =
			theme.fg("accent", "memory") +
			theme.fg("muted", ` ${count} lesson${count === 1 ? "" : "s"}`) +
			theme.fg("dim", ` ${details?.path ?? ""}`) +
			(details?.refreshed ? theme.fg("dim", " (refreshed)") : "");
		const body =
			expanded && typeof message.content === "string" ? `${label}\n${theme.fg("dim", message.content)}` : label;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(body, 0, 0));
		return box;
	});

	pi.registerTool({
		name: "add_memory",
		label: "Remember",
		description:
			"Append a durable lesson to this project's memory file, which is loaded into context at the start of every session here. Call this ONLY when the user explicitly teaches or confirms a lasting lesson - they say 'remember this' / 'for next time', or they correct you on a recurring convention. Never call it for facts you inferred yourself, for transient task state, or for single-session decisions. Write one self-contained line in imperative voice.",
		// No promptGuidelines: a Guidelines bullet would restate the description's
		// restriction in the one place the model reads *before* it considers the
		// tool, spending system-prompt tokens in every project on a rule that only
		// bites at call time, where the description already sits.
		promptSnippet: "Append a durable, user-taught lesson to this project's memory file",
		parameters: Type.Object({
			lesson: Type.String({
				description:
					"The lesson as a single self-contained line in imperative voice, e.g. 'Use HSCTR-8566 as the epic for NBA 2 stories unless told otherwise.'",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const lesson = (params as { lesson: string }).lesson?.trim();
			if (!lesson) {
				return {
					content: [{ type: "text" as const, text: "add_memory requires a non-empty lesson." }],
					details: { error: true },
					isError: true,
				};
			}

			const loc = ensureLocation(ctx);
			const existing = readMemory(loc.file) ?? memoryFileHeader();

			const duplicate = findDuplicate(existing, lesson);
			if (duplicate) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Not appended: this lesson is already in memory as "${duplicate.line}". To refine it, tell the user to run /edit-memory.`,
						},
					],
					details: { error: true, duplicate: duplicate.line },
					isError: true,
				};
			}

			const line = formatEntry(lesson, formatDate());
			try {
				writeMemory(loc.file, appendEntry(existing, line));
			} catch (e) {
				return {
					content: [
						{ type: "text" as const, text: `Failed to write ${loc.file}: ${(e as Error).message}` },
					],
					details: { error: true },
					isError: true,
				};
			}
			return {
				content: [{ type: "text" as const, text: `Appended to project memory:\n${line}` }],
				details: { line, path: shortenPath(loc.file) },
			};
		},
		renderCall(args, theme) {
			const lesson = (args as { lesson?: string }).lesson ?? "";
			return new Text(theme.fg("toolTitle", theme.bold("remember")) + theme.fg("dim", ` ${lesson}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			const failed = (result.details as AddMemoryDetails | undefined)?.error === true;
			return new Text(theme.fg(failed ? "warning" : "muted", text), 0, 0);
		},
	});

	pi.registerCommand("edit-memory", {
		description: "Edit this project's memory file",
		handler: async (_args, ctx) => {
			const loc = ensureLocation(ctx);
			const existing = readMemory(loc.file) ?? memoryFileHeader();

			if (!ctx.hasUI) {
				console.error(`memory file: ${loc.file}`);
				return;
			}

			const edited = await ctx.ui.editor(`Edit memory (${shortenPath(loc.file)})`, existing);
			if (edited === undefined || edited.trim() === existing.trim()) return;

			try {
				writeMemory(loc.file, edited.endsWith("\n") ? edited : `${edited}\n`);
			} catch (e) {
				ctx.ui.notify(`Failed to write ${loc.file}: ${(e as Error).message}`, "error");
				return;
			}

			// The copy already in context is now wrong, which matters most right
			// after a prune; supersede it instead of waiting for the next session.
			const injected = inject(ctx, true);
			ctx.ui.notify(
				injected ? "Memory saved and refreshed in context." : `Memory saved: ${shortenPath(loc.file)}`,
				"info",
			);
		},
	});
}
