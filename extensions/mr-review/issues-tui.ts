/**
 * Scrollable full issue-list view (/mr-issues).
 *
 * The above-editor widget self-caps to the viewport, so this is the overflow
 * surface. Two views in one component:
 *   - list:   scrollable SelectList of every issue (summary truncated)
 *   - detail: full summary + details for the selected issue
 * Enter on the list opens detail; Esc in detail returns to the list; Esc in the
 * list closes.
 */

import { DynamicBorder, type ExtensionContext, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { locationLabel, severityColor, stateView } from "./format.ts";
import type { Issue, ReviewStore } from "./state.ts";

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function stateLabel(issue: Issue): string {
	return stateView(issue).label;
}

function wrapBlock(text: string, theme: Theme, width: number, color: "text" | "muted"): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (line === "") {
			out.push("");
			continue;
		}
		for (const piece of wrapTextWithAnsi(line, width - 2)) out.push(theme.fg(color, ` ${piece}`));
	}
	return out;
}

function renderDetail(issue: Issue, theme: Theme, width: number): string[] {
	const lines = [theme.fg("accent", "\u2500".repeat(width))];
	const head =
		`${theme.fg("accent", theme.bold(`Issue #${issue.id}`))} ` +
		`${theme.fg(severityColor(issue.severity), `[${issue.severity}]`)} ` +
		theme.fg("muted", `\u00b7 ${stateLabel(issue)} \u00b7 ${locationLabel(issue)}`);
	lines.push(` ${truncateToWidth(head, width - 1)}`);
	lines.push("");
	lines.push(...wrapBlock(issue.summary, theme, width, "text"));
	if (issue.details.trim()) {
		lines.push("");
		lines.push(...wrapBlock(issue.details, theme, width, "muted"));
	}
	lines.push("");
	lines.push(theme.fg("dim", " esc back"));
	lines.push(theme.fg("accent", "\u2500".repeat(width)));
	return lines;
}

export function openIssueList(ctx: ExtensionContext, store: ReviewStore): Promise<void> {
	if (!store.hasReview() || store.list().length === 0) {
		ctx.ui.notify("No issues registered yet.", "info");
		return Promise.resolve();
	}

	return ctx.ui.custom<void>((tui: TUI, theme: Theme, _kb, done) => {
		let detailId: number | null = null;

		const items: SelectItem[] = store.list().map((i) => ({
			value: String(i.id),
			label: `#${i.id} [${i.severity}] ${stateLabel(i)}  ${oneLine(i.summary)}`,
			description: oneLine(i.details),
		}));

		const maxVisible = Math.max(5, Math.min(items.length, tui.terminal.rows - 8));
		const listContainer = new Container();
		listContainer.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		listContainer.addChild(
			new Text(theme.fg("accent", theme.bold(`MR #${store.activeMr} \u00b7 ${items.length} issues`)), 1, 0),
		);

		const list = new SelectList(items, maxVisible, getSelectListTheme());
		list.onSelect = (item) => {
			detailId = Number(item.value);
			tui.requestRender();
		};
		list.onCancel = () => done();
		listContainer.addChild(list);

		listContainer.addChild(new Text(theme.fg("dim", "\u2191\u2193 navigate \u00b7 enter details \u00b7 esc close"), 1, 0));
		listContainer.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => {
				if (detailId === null) return listContainer.render(w);
				const issue = store.getIssue(detailId);
				if (!issue) {
					detailId = null;
					return listContainer.render(w);
				}
				return renderDetail(issue, theme, w);
			},
			invalidate: () => listContainer.invalidate(),
			handleInput: (data: string) => {
				if (detailId !== null) {
					if (matchesKey(data, Key.escape)) {
						detailId = null;
						tui.requestRender();
					}
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
