/**
 * Shared formatting helpers for the MR review UI (widget, post/issues TUIs, and
 * the annotator adapter). Centralized here to avoid the copies that previously
 * lived in each file.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Issue, Severity } from "./state.ts";

export function severityColor(severity: Severity): ThemeColor {
	if (severity === "critical") return "error";
	if (severity === "major") return "warning";
	return "muted";
}

export function locationLabel(issue: Issue): string {
	if (!issue.file) return "general";
	if (!issue.startLine) return issue.file;
	const range =
		issue.endLine && issue.endLine !== issue.startLine ? `${issue.startLine}-${issue.endLine}` : `${issue.startLine}`;
	return `${issue.file}:${range}`;
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
