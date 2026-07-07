/**
 * Passive issue-list widget rendered above the editor.
 *
 * Uses the component (factory) form of setWidget rather than the string[] form
 * for two reasons:
 *   1. The string[] form is hard-capped at 10 lines by pi (MAX_WIDGET_LINES);
 *      the component form is not, so we can show more issues.
 *   2. render(width) receives the real viewport width, so summaries use the
 *      full terminal width instead of a fixed cap.
 *
 * We are then responsible for not overflowing the viewport, so the widget caps
 * itself to a fraction of the terminal height (read live from tui.terminal.rows)
 * and shows a "+N more" notice pointing at /mr-issues for the full list.
 *
 * Strings are pre-colored; pad plain text BEFORE coloring so ANSI codes never
 * count toward column width.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { severityColor, stateView } from "./format.ts";
import type { Issue, ReviewStore } from "./state.ts";

// Rows kept clear below/around the widget (editor, footer, transcript breathing room).
const VIEWPORT_RESERVE = 12;
const MIN_ISSUE_ROWS = 4;
// Visible columns consumed by " #id  [severity]   state " before the summary.
const PREFIX_COLS = 1 + 4 + 1 + 11 + 1 + 12 + 1;

function issueLine(issue: Issue, theme: Theme, width: number): string {
	const id = theme.fg("muted", `#${issue.id}`.padEnd(4));
	const sev = theme.fg(severityColor(issue.severity), `[${issue.severity}]`.padEnd(11));
	const s = stateView(issue);
	const state = theme.fg(s.color, `${s.icon} ${s.label}`.padEnd(12));
	const summaryText = issue.summary.replace(/\s+/g, " ").trim();
	const summary = truncateToWidth(summaryText, Math.max(4, width - PREFIX_COLS), "\u2026");
	return ` ${id} ${sev} ${state} ${theme.fg("text", summary)}`;
}

function renderLines(store: ReviewStore, theme: Theme, width: number, rows: number): string[] {
	const c = store.counts();
	const head =
		`${theme.fg("accent", theme.bold(`MR #${store.activeMr}`))} ` +
		theme.fg(
			"muted",
			`\u00b7 ${c.total} issue${c.total === 1 ? "" : "s"} \u00b7 ${c.open} open \u00b7 ${c.commented} commented \u00b7 ${c.rejected} rejected \u00b7 ${c.posted} posted`,
		);
	const lines = [truncateToWidth(head, width)];

	const issues = store.list();
	const maxRows = Math.max(MIN_ISSUE_ROWS, rows - VIEWPORT_RESERVE);
	if (issues.length <= maxRows) {
		for (const issue of issues) lines.push(issueLine(issue, theme, width));
	} else {
		const shown = maxRows - 1; // reserve a row for the overflow notice
		for (let i = 0; i < shown; i++) lines.push(issueLine(issues[i], theme, width));
		lines.push(theme.fg("muted", ` \u2026 +${issues.length - shown} more \u00b7 /mr-issues to view all`));
	}
	return lines;
}

/** Factory for ctx.ui.setWidget's component form; reads the store live on render. */
export function issueWidgetFactory(store: ReviewStore) {
	return (tui: TUI, theme: Theme): Component => ({
		render: (width: number) => renderLines(store, theme, width, tui.terminal.rows),
		invalidate: () => {},
	});
}
