/**
 * Pure string core of the memory extension: store-key encoding, entry
 * parsing/formatting, duplicate detection, size accounting, and assembly of the
 * injected context block.
 *
 * Deliberately free of fs, git, and pi imports - `index.ts` owns every side
 * effect and passes file contents through these helpers - so all of this is
 * unit testable without a repo, a temp dir, or a running agent.
 */

import { createHash } from "node:crypto";

/** Directory under pi's agent dir that holds one subdirectory per project root. */
export const STORE_DIR_NAME = "memory";
export const MEMORY_FILE_NAME = "memory.md";

/**
 * Above this the file is injected into every session at a real token cost, so
 * the user gets a prune nudge. ~8KB is roughly 2k tokens.
 */
export const SIZE_WARN_BYTES = 8192;

export interface MemoryEntry {
	date: string;
	lesson: string;
	/** Verbatim source line, so callers can echo back what is already stored. */
	line: string;
}

const ENTRY_PATTERN = /^-\s+(\d{4}-\d{2}-\d{2}):\s*(\S.*?)\s*$/;

/**
 * Encode an absolute project root the way pi encodes session directories
 * (`getDefaultSessionDirPath`): drop the leading separator, replace separators
 * and colons with `-`, wrap in `--`. Keeps memory dirs navigable 1:1 with the
 * session dirs of the same project.
 *
 * The single-character leading strip is pi's, quirks included (a `//host/share`
 * path keeps one dash). Fidelity to pi's formula is the point; do not "fix" it.
 */
export function encodeRootKey(absRoot: string): string {
	return `--${absRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Local-time date stamp; entries are dated in the user's timezone, not UTC. */
export function formatDate(now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatEntry(lesson: string, date: string): string {
	return `- ${date}: ${collapseWhitespace(lesson)}`;
}

export function parseEntries(content: string): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	for (const line of content.split("\n")) {
		const match = ENTRY_PATTERN.exec(line);
		if (match) entries.push({ date: match[1], lesson: match[2], line: line.trim() });
	}
	return entries;
}

/**
 * Comparison key for duplicate detection: case, spacing, and trailing
 * punctuation are noise. Reworded re-teachings are the model's job to catch
 * (it has the whole file in context); this only stops literal repeats.
 */
export function normalizeLesson(lesson: string): string {
	return collapseWhitespace(lesson)
		.toLowerCase()
		.replace(/[.!?;,]+$/, "");
}

export function findDuplicate(content: string, lesson: string): MemoryEntry | undefined {
	const target = normalizeLesson(lesson);
	if (!target) return undefined;
	return parseEntries(content).find((entry) => normalizeLesson(entry.lesson) === target);
}

/**
 * Append one entry, normalizing trailing whitespace to a single newline.
 * Entries stack directly on each other, but the first one is separated from the
 * header prose by a blank line so a freshly created file reads as markdown.
 */
export function appendEntry(content: string, line: string): string {
	const base = content.replace(/\s+$/, "");
	if (base.length === 0) return `${line}\n`;
	const lastLine = base.slice(base.lastIndexOf("\n") + 1);
	const separator = ENTRY_PATTERN.test(lastLine) ? "\n" : "\n\n";
	return `${base}${separator}${line}\n`;
}

export function contentBytes(content: string): number {
	return Buffer.byteLength(content, "utf8");
}

export function exceedsSizeWarning(content: string): boolean {
	return contentBytes(content) > SIZE_WARN_BYTES;
}

/**
 * Stable identity of an injected copy, stored in the custom message's details so
 * a resumed session can tell whether the file changed since it was last shown.
 */
export function contentDigest(content: string): string {
	return createHash("sha1").update(content.trim()).digest("hex").slice(0, 16);
}

export function memoryFileHeader(): string {
	return `# Project memory

Durable lessons the user has taught the agent about this project. Loaded into
context at the start of every session here, so keep it short and curated.

Maintained by pi's memory extension: the agent appends entries via \`add_memory\`,
the user prunes and rewrites them via \`/edit-memory\`.

Format, one entry per line, newest last:

    - YYYY-MM-DD: <one-line lesson in imperative voice>
`;
}

const REFRESH_NOTE =
	"This is a refreshed copy of the project memory (the file changed, or earlier context was compacted away). It supersedes any earlier memory block in this conversation.";

/**
 * Assemble the message injected into context: protocol preamble, then the
 * memory file verbatim inside a tagged block that names its path.
 */
export function buildInjectedMessage(
	preamble: string,
	content: string,
	opts: { path?: string; refreshed?: boolean } = {},
): string {
	const parts: string[] = [];
	const trimmedPreamble = preamble.trim();
	if (trimmedPreamble) parts.push(trimmedPreamble);
	if (opts.refreshed) parts.push(REFRESH_NOTE);
	const attr = opts.path ? ` path="${opts.path.replace(/"/g, "'")}"` : "";
	parts.push(`<project-memory${attr}>\n${content.trim()}\n</project-memory>`);
	return parts.join("\n\n");
}
