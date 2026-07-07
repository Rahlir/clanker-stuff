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
	state: IssueState;
	/** Posted comment body; set when the issue becomes `commented`. */
	note?: string;
	posted?: boolean;
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

export interface IssueCounts {
	total: number;
	open: number;
	commented: number;
	rejected: number;
	posted: number;
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

	addIssue(input: IssueInput): Issue {
		const issue: Issue = {
			id: this.nextId++,
			severity: input.severity,
			summary: input.summary,
			details: input.details,
			file: input.file,
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

	/** Apply partial edits. `state` callers must restrict to open/rejected. */
	updateIssue(
		id: number,
		fields: Partial<Pick<Issue, "severity" | "summary" | "details" | "file" | "startLine" | "endLine">> & {
			state?: "open" | "rejected";
		},
	): Issue | undefined {
		const issue = this.getIssue(id);
		if (!issue) return undefined;
		if (fields.severity !== undefined) issue.severity = fields.severity;
		if (fields.summary !== undefined) issue.summary = fields.summary;
		if (fields.details !== undefined) issue.details = fields.details;
		if (fields.file !== undefined) issue.file = fields.file;
		if (fields.startLine !== undefined) issue.startLine = fields.startLine;
		if (fields.endLine !== undefined) issue.endLine = fields.endLine;
		if (fields.state !== undefined) {
			issue.state = fields.state;
			// Reopening clears a prior note/post so it can be re-drafted cleanly.
			if (fields.state === "open") {
				issue.note = undefined;
				issue.posted = undefined;
			}
		}
		return issue;
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
