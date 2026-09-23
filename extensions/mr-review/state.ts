/**
 * In-memory model and store for an MR review session.
 *
 * Pure data: no pi dependency. The extension drives persistence by calling
 * `serialize()` into `pi.appendEntry` and rehydrating with `load()` on
 * session start. Issue ids are stable auto-increment integers so the user can
 * refer to them in conversation ("reject #3").
 */

export type Severity = "critical" | "major" | "minor";

// `commented` is reached only through draft-note approval; `open`/`rejected`
// are user/agent driven. `posted` is tracked separately so the list can show a
// post marker without adding a fourth lifecycle state.
export type IssueState = "open" | "commented" | "rejected";

export interface Issue {
	id: number;
	severity: Severity;
	summary: string;
	details: string;
	file?: string;
	startLine?: number;
	endLine?: number;
	/**
	 * Post as a general note even though a position is recorded.
	 *
	 * Set when GitLab rejects the anchor. The position is kept rather than
	 * deleted so the issue list still shows where the finding is and the posted
	 * body can name it (see `composeBody`).
	 */
	postAsGeneral?: boolean;
	state: IssueState;
	/** Posted comment body; set when the issue becomes `commented`. */
	note?: string;
	posted?: boolean;
}

export interface AnchorFields {
	file?: string;
	startLine?: number;
	endLine?: number;
}

/**
 * Whether the note posts as an inline diff comment.
 *
 * A line without a file cannot be anchored, and glab must never receive
 * `--file` without `--line`: it silently anchors such a note to the first line
 * of the file's first diff hunk (verified against GitLab 19.3 CE and EE), which
 * pins the comment to code it is not about.
 */
export function isInlineAnchor(issue: Issue): boolean {
	return !issue.postAsGeneral && !!issue.file && !!issue.startLine;
}

/**
 * Reject anchors that carry line information we cannot act on.
 *
 * An anchor is either complete (file plus startLine, endLine optional) or
 * absent.
 *
 * Returns an agent-facing message, or undefined when the anchor is usable.
 */
export function validateAnchor(a: AnchorFields): string | undefined {
	const hasFile = !!a.file?.trim();
	if (a.startLine !== undefined) {
		if (!Number.isInteger(a.startLine) || a.startLine < 1) {
			return `startLine must be a positive integer, got ${a.startLine}.`;
		}
		if (!hasFile) {
			return "startLine requires file: a line number alone cannot be anchored. Pass the file too, or drop the line.";
		}
	}
	if (a.endLine !== undefined) {
		if (!Number.isInteger(a.endLine) || a.endLine < 1) {
			return `endLine must be a positive integer, got ${a.endLine}.`;
		}
		if (a.startLine === undefined) {
			return "endLine requires startLine: the end of a range alone cannot be anchored. Pass startLine too, or drop endLine to comment on the file as a whole.";
		}
		if (a.endLine < a.startLine) {
			return `endLine (${a.endLine}) must not be before startLine (${a.startLine}).`;
		}
	}
	return undefined;
}

export interface ReviewData {
	mr: string;
	issues: Issue[];
	nextId: number;
}

export interface IssueInput {
	severity: Severity;
	summary: string;
	details: string;
	file?: string;
	startLine?: number;
	endLine?: number;
}

export type UpdateOutcome =
	| { ok: true; issue: Issue }
	| { ok: false; reason: "not-found" }
	| { ok: false; reason: "invalid-anchor"; error: string };

export interface IssueCounts {
	total: number;
	open: number;
	commented: number;
	rejected: number;
	posted: number;
}

// An empty or blank path is the same as no path, and is the only way a caller
// can take a wrong file back off an issue.
function normalizeFile(file?: string): string | undefined {
	return file?.trim() || undefined;
}

function mergeAnchor(issue: Issue, fields: AnchorFields): AnchorFields {
	const merged: AnchorFields = { file: issue.file, startLine: issue.startLine, endLine: issue.endLine };
	if (fields.file !== undefined) merged.file = normalizeFile(fields.file);
	if (fields.startLine !== undefined) {
		merged.startLine = fields.startLine;
		if (fields.endLine === undefined) merged.endLine = undefined;
	}
	if (fields.endLine !== undefined) merged.endLine = fields.endLine;
	return merged;
}

export class ReviewStore {
	private mr: string | null = null;
	private issues: Issue[] = [];
	private nextId = 1;

	get activeMr(): string | null {
		return this.mr;
	}

	hasReview(): boolean {
		return this.mr !== null;
	}

	start(mr: string): void {
		this.mr = mr;
		this.issues = [];
		this.nextId = 1;
	}

	reset(): void {
		this.mr = null;
		this.issues = [];
		this.nextId = 1;
	}

	load(data: ReviewData): void {
		this.mr = data.mr || null;
		this.issues = Array.isArray(data.issues) ? data.issues : [];
		const maxId = this.issues.reduce((m, i) => Math.max(m, i.id), 0);
		this.nextId = data.nextId && data.nextId > maxId ? data.nextId : maxId + 1;
	}

	serialize(): ReviewData {
		// Clone so the persisted snapshot can't be mutated by later store edits,
		// regardless of whether the persistence layer copies it.
		return { mr: this.mr ?? "", issues: this.issues.map((i) => ({ ...i })), nextId: this.nextId };
	}

	/** Callers validate the anchor with `validateAnchor` first; this trusts it. */
	addIssue(input: IssueInput): Issue {
		const issue: Issue = {
			id: this.nextId++,
			severity: input.severity,
			summary: input.summary,
			details: input.details,
			file: normalizeFile(input.file),
			startLine: input.startLine,
			endLine: input.endLine,
			state: "open",
		};
		this.issues.push(issue);
		return issue;
	}

	getIssue(id: number): Issue | undefined {
		return this.issues.find((i) => i.id === id);
	}

	/**
	 * Apply partial edits. `state` callers must restrict to open/rejected.
	 *
	 * Validation runs on the merged anchor, not on the incoming fields: adding an
	 * `endLine` to an issue that already has a `startLine` is valid, the same call
	 * against an unanchored issue is not. A rejected update changes nothing, so
	 * the issue never keeps a half-applied anchor.
	 *
	 * A `startLine` without an `endLine` also drops any existing `endLine`. The
	 * anchor is one unit: repointing the start of an 88-95 range while keeping 95
	 * would post `--line 40:95`, re-raising the same out-of-diff rejection the
	 * caller was trying to fix. Restate `endLine` to keep a range.
	 *
	 * The drafted note is never touched by an anchor edit, so a queued issue stays
	 * queued after a repair.
	 */
	updateIssue(
		id: number,
		fields: Partial<Pick<Issue, "severity" | "summary" | "details" | "file" | "startLine" | "endLine">> & {
			state?: "open" | "rejected";
			postAsGeneral?: boolean;
		},
	): UpdateOutcome {
		const issue = this.getIssue(id);
		if (!issue) return { ok: false, reason: "not-found" };

		const anchor = mergeAnchor(issue, fields);
		const error = validateAnchor(anchor);
		if (error) return { ok: false, reason: "invalid-anchor", error };

		issue.file = anchor.file;
		issue.startLine = anchor.startLine;
		issue.endLine = anchor.endLine;
		// An explicit flag wins; otherwise a fresh startLine means "anchor it here",
		// which is the whole point of repointing a previously demoted issue.
		if (fields.postAsGeneral !== undefined) issue.postAsGeneral = fields.postAsGeneral || undefined;
		else if (fields.startLine !== undefined) issue.postAsGeneral = undefined;
		if (fields.severity !== undefined) issue.severity = fields.severity;
		if (fields.summary !== undefined) issue.summary = fields.summary;
		if (fields.details !== undefined) issue.details = fields.details;
		if (fields.state !== undefined) {
			issue.state = fields.state;
			// Reopening clears a prior note/post so it can be re-drafted cleanly.
			if (fields.state === "open") {
				issue.note = undefined;
				issue.posted = undefined;
			}
		}
		return { ok: true, issue };
	}

	setNote(id: number, body: string): Issue | undefined {
		const issue = this.getIssue(id);
		if (!issue) return undefined;
		issue.note = body;
		issue.state = "commented";
		return issue;
	}

	markRejected(id: number): Issue | undefined {
		const issue = this.getIssue(id);
		if (!issue) return undefined;
		issue.state = "rejected";
		// Drop any drafted/posted note so a rejected issue carries no stale body.
		issue.note = undefined;
		issue.posted = undefined;
		return issue;
	}

	markPosted(id: number): Issue | undefined {
		const issue = this.getIssue(id);
		if (!issue) return undefined;
		issue.posted = true;
		return issue;
	}

	list(): Issue[] {
		return this.issues;
	}

	/** Approved notes awaiting posting. */
	queued(): Issue[] {
		return this.issues.filter((i) => i.state === "commented" && !i.posted);
	}

	counts(): IssueCounts {
		return {
			total: this.issues.length,
			open: this.issues.filter((i) => i.state === "open").length,
			commented: this.issues.filter((i) => i.state === "commented").length,
			rejected: this.issues.filter((i) => i.state === "rejected").length,
			posted: this.issues.filter((i) => i.posted).length,
		};
	}
}
