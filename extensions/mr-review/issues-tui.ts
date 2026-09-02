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
import { withUiLock } from "../../lib/ui-lock.ts";
import { clampToBudget, moreIndicator, viewportBudget, windowLines } from "../../lib/viewport.ts";
import { locationLabel, severityColor, stateView } from "./format.ts";
import type { Issue, ReviewStore } from "./state.ts";

// List: two borders + title + help, plus a row for SelectList's scroll counter.
const LIST_CHROME_ROWS = 5;
// Detail: border + head + blank above the body, blank + help + border below.
const DETAIL_CHROME_ROWS = 6;

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

function renderDetail(
	issue: Issue,
	theme: Theme,
	width: number,
	budget: number,
	scroll: number,
): { lines: string[]; scroll: number } {
	const body = wrapBlock(issue.summary, theme, width, "text");
	if (issue.details.trim()) {
		body.push("");
		body.push(...wrapBlock(issue.details, theme, width, "muted"));
	}
	const windowed = windowLines(body, Math.max(0, budget - DETAIL_CHROME_ROWS), {
		scroll,
		indicator: moreIndicator(theme),
	});

	const head =
		`${theme.fg("accent", theme.bold(`Issue #${issue.id}`))} ` +
		`${theme.fg(severityColor(issue.severity), `[${issue.severity}]`)} ` +
		theme.fg("muted", `\u00b7 ${stateLabel(issue)} \u00b7 ${locationLabel(issue)}`);
	const lines = [theme.fg("accent", "\u2500".repeat(width))];
	lines.push(` ${truncateToWidth(head, width - 1)}`);
	lines.push("");
	lines.push(...windowed.lines);
	lines.push("");
	lines.push(theme.fg("dim", " \u2191\u2193 scroll \u00b7 esc back"));
	lines.push(theme.fg("accent", "\u2500".repeat(width)));
	return { lines: clampToBudget(lines, budget), scroll: windowed.scroll };
}

export function openIssueList(ctx: ExtensionContext, store: ReviewStore): Promise<void> {
	if (!store.hasReview() || store.list().length === 0) {
		ctx.ui.notify("No issues registered yet.", "info");
		return Promise.resolve();
	}

	// Exclusive while on screen; see lib/ui-lock.ts.
	return withUiLock("MR issue list", () => runComponent(ctx, store));
}

function runComponent(ctx: ExtensionContext, store: ReviewStore): Promise<void> {
	return ctx.ui.custom<void>((tui: TUI, theme: Theme, _kb, done) => {
		let detailId: number | null = null;
		let detailScroll = 0;

		const items: SelectItem[] = store.list().map((i) => ({
			value: String(i.id),
			label: `#${i.id} [${i.severity}] ${stateLabel(i)}  ${oneLine(i.summary)}`,
			description: oneLine(i.details),
		}));

		// SelectList takes maxVisible only at construction and exposes no setter, so this
		// is the one budget in the package that cannot be recomputed per render; a resize
		// or TUI-mode switch while the list is open will not reflow it.
		const maxVisible = Math.max(5, Math.min(items.length, viewportBudget(tui) - LIST_CHROME_ROWS));
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
				const detail = renderDetail(issue, theme, w, viewportBudget(tui), detailScroll);
				detailScroll = detail.scroll;
				return detail.lines;
			},
			invalidate: () => listContainer.invalidate(),
			handleInput: (data: string) => {
				if (detailId !== null) {
					if (matchesKey(data, Key.escape)) {
						detailId = null;
						detailScroll = 0;
						tui.requestRender();
						return;
					}
					// windowLines clamps the offset, so no bound is needed here.
					if (matchesKey(data, Key.up)) detailScroll = Math.max(0, detailScroll - 1);
					else if (matchesKey(data, Key.down)) detailScroll += 1;
					else return;
					tui.requestRender();
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
