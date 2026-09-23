/**
 * Posting MR notes via the glab CLI.
 *
 * Uses execFile (no shell), so the note body is passed as a single argv
 * element and backticks / $ / quotes are never interpreted. This sidesteps the
 * entire heredoc/escaping minefield documented in the glab skill. The only
 * remaining bound is ARG_MAX, which review-sized notes never approach.
 *
 * Inline vs general is decided by `isInlineAnchor`; a general note carries its
 * position in the body instead (`composeBody`).
 *
 * `--unique` (idempotent re-runs) is added ONLY for general notes: glab treats
 * `--file` and `--unique` as mutually exclusive, so passing both makes every
 * inline post fail. Inline re-runs are instead guarded by the store's `posted`
 * flag + queued() filter, which already skip already-posted issues.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { composeBody } from "./format.ts";
import { type Issue, isInlineAnchor } from "./state.ts";

const run = promisify(execFile);

/**
 * Both anchor kinds mean the position is unusable and retrying the same call is
 * pointless, but they differ in the remedy: a rejected line can be repointed at
 * another line of the same file, while a file outside the diff can only become
 * a general note.
 */
export type PostErrorKind = "anchor-line" | "anchor-file" | "other";

export type AnchorErrorKind = Exclude<PostErrorKind, "other">;

export interface PostResult {
	ok: boolean;
	error?: string;
	/** Set whenever `ok` is false. */
	kind?: PostErrorKind;
}

export function isAnchorFailure(kind?: PostErrorKind): kind is AnchorErrorKind {
	return kind === "anchor-line" || kind === "anchor-file";
}

// glab resolves --file/--line against the latest diff version itself and rejects
// unknown positions client-side; GitLab rejects the rest server-side with a
// line-code complaint.

// glab: `file "src/a.ts" not found in MR diff`. Tested first, because no line in
// that file can ever be anchored and the line-level advice would waste a round
// trip.
const FILE_ERROR_PATTERN = /not found in MR diff/i;

const ANCHOR_ERROR_PATTERNS = [
	/not found in diff/i, // glab: "line 88 not found in diff for src/a.ts"
	/invalid line (range|number)/i,
	/line number must be positive/i,
	// GitLab 400s on an unresolvable position. Deliberately broad, because the
	// wording varies ("must be a valid line code", "Line code is missing",
	// a raw `line_code` key in the error payload) and the costs are asymmetric:
	// a false positive sends the agent to re-anchor one note, a false negative
	// puts it back in the retry loop this classifier exists to break.
	/line[_ ]code/i,
	/position is (incomplete|invalid)/i,
];

export function classifyPostError(detail: string): PostErrorKind {
	if (FILE_ERROR_PATTERN.test(detail)) return "anchor-file";
	return ANCHOR_ERROR_PATTERNS.some((p) => p.test(detail)) ? "anchor-line" : "other";
}

/**
 * Build the glab argv for a note. Exported for testing.
 *
 * `--file` is only ever passed together with `--line`. glab documents `--file`
 * alone as a "file-level comment", but it actually anchors the note to the first
 * line of the file's first diff hunk (confirmed on GitLab 19.3 CE and EE), and
 * the REST `position_type: "file"` both instances accept is silently dropped.
 * There is no way to comment on a file as a whole, so those notes go out as
 * general ones with the path in the body.
 */
export function buildNoteArgs(mr: string, issue: Issue, body: string): string[] {
	const isInline = isInlineAnchor(issue);
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
	// Emptiness is judged on the approved note, before composeBody can pad it with
	// a position prefix.
	if (!(issue.note ?? "").trim()) {
		return { ok: false, error: "empty note body", kind: "other" };
	}

	const args = buildNoteArgs(mr, issue, composeBody(issue));

	try {
		await run("glab", args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// glab writes the useful part to stderr; surface the first meaningful line.
		const stderr = (err as { stderr?: string }).stderr;
		const detail = (stderr && stderr.trim().split("\n").find((l) => l.trim())) || message.split("\n")[0];
		// Classify against the whole stderr, not just the surfaced line: glab prints
		// the API body on a later line for server-side rejections.
		return { ok: false, error: detail, kind: classifyPostError(`${stderr ?? ""}\n${message}`) };
	}
}
