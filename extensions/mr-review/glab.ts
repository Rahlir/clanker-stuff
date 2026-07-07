/**
 * Posting MR notes via the glab CLI.
 *
 * Uses execFile (no shell), so the note body is passed as a single argv
 * element and backticks / $ / quotes are never interpreted. This sidesteps the
 * entire heredoc/escaping minefield documented in the glab skill. The only
 * remaining bound is ARG_MAX, which review-sized notes never approach.
 *
 * Inline vs general is decided purely by whether the issue carries a position
 * (file + startLine).
 *
 * `--unique` (idempotent re-runs) is added ONLY for general notes: glab treats
 * `--file` and `--unique` as mutually exclusive, so passing both makes every
 * inline post fail. Inline re-runs are instead guarded by the store's `posted`
 * flag + queued() filter, which already skip already-posted issues.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Issue } from "./state.ts";

const run = promisify(execFile);

export interface PostResult {
	ok: boolean;
	error?: string;
}

/** Build the glab argv for a note. Exported for testing. */
export function buildNoteArgs(mr: string, issue: Issue, body: string): string[] {
	const isInline = !!(issue.file && issue.startLine);
	const args = ["mr", "note", "create", mr];
	if (isInline) {
		// Multi-line issues use glab's START:END range syntax; single-line issues
		// just pass the one line.
		const line =
			issue.endLine && issue.endLine !== issue.startLine
				? `${issue.startLine}:${issue.endLine}`
				: String(issue.startLine);
		args.push("--file", issue.file as string, "--line", line);
	}
	args.push("-m", body);
	// --unique is incompatible with --file; only safe for general notes.
	if (!isInline) args.push("--unique");
	return args;
}

export async function postNote(mr: string, issue: Issue, cwd: string): Promise<PostResult> {
	const body = issue.note ?? "";
	if (!body.trim()) {
		return { ok: false, error: "empty note body" };
	}

	const args = buildNoteArgs(mr, issue, body);

	try {
		await run("glab", args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// glab writes the useful part to stderr; surface the first meaningful line.
		const stderr = (err as { stderr?: string }).stderr;
		const detail = (stderr && stderr.trim().split("\n").find((l) => l.trim())) || message.split("\n")[0];
		return { ok: false, error: detail };
	}
}
