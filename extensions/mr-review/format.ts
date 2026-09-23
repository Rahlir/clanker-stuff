/**
 * Shared formatting helpers for the MR review UI (widget, post/issues TUIs, and
 * the annotator adapter) plus the posted note body. Centralized here to avoid
 * the copies that previously lived in each file.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Issue, isInlineAnchor, type Severity } from "./state.ts";

export function severityColor(severity: Severity): ThemeColor {
	if (severity === "critical") return "error";
	if (severity === "major") return "warning";
	return "muted";
}

/** `src/a.ts:88-95`, `src/a.ts`, or undefined when the issue has no position. */
export function anchorRef(issue: Issue): string | undefined {
	if (!issue.file) return undefined;
	if (!issue.startLine) return issue.file;
	const range =
		issue.endLine && issue.endLine !== issue.startLine ? `${issue.startLine}-${issue.endLine}` : `${issue.startLine}`;
	return `${issue.file}:${range}`;
}

export function locationLabel(issue: Issue): string {
	const ref = anchorRef(issue);
	if (!ref) return "general";
	// The suffix is the only cue that a positioned issue will not appear on the
	// diff, which changes how the note has to be worded.
	return isInlineAnchor(issue) ? ref : `${ref} (general)`;
}

/**
 * The body as posted: the approved note, prefixed with the position whenever we
 * know one but cannot attach the note to it.
 *
 * Without this a demoted note arrives with no hint of what it is about, since
 * the reviewee never sees the anchor we recorded. The prefix is added at post
 * time rather than folded into the note so the approved text stays the user's.
 */
export function composeBody(issue: Issue): string {
	const body = issue.note ?? "";
	if (isInlineAnchor(issue)) return body;
	const ref = anchorRef(issue);
	return ref ? `**\`${ref}\`**\n\n${body}` : body;
}

export function stateView(issue: Issue): { icon: string; label: string; color: ThemeColor } {
	if (issue.state === "rejected") return { icon: "\u2717", label: "rejected", color: "error" };
	if (issue.state === "commented") {
		return issue.posted
			? { icon: "\u2713", label: "posted", color: "success" }
			: { icon: "\u25d0", label: "commented", color: "accent" };
	}
	return { icon: "\u25cb", label: "open", color: "muted" };
}
