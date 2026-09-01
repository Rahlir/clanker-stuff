/**
 * Confirm + preview screen for posting queued notes.
 *
 * Lists every approved-but-unposted note with a checkbox. The user navigates,
 * toggles individual notes out of this batch (they stay `commented`, just not
 * posted now), and confirms. Returns the selected issue ids, or null on
 * cancel.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { withUiLock } from "../../lib/ui-lock.ts";
import { severityColor } from "./format.ts";
import type { Severity } from "./state.ts";

export interface PreviewItem {
	id: number;
	severity: Severity;
	inline: boolean;
	location: string;
	body: string;
}

export function openPostConfirm(ctx: ExtensionContext, items: PreviewItem[]): Promise<number[] | null> {
	// Exclusive while on screen; see lib/ui-lock.ts.
	return withUiLock("MR post preview", () => runComponent(ctx, items));
}

function runComponent(ctx: ExtensionContext, items: PreviewItem[]): Promise<number[] | null> {
	return ctx.ui.custom<number[] | null>((tui, theme, _kb, done) => {
		let cursor = 0;
		const selected = new Set(items.map((i) => i.id));
		let cached: string[] | undefined;

		function refresh(): void {
			cached = undefined;
			tui.requestRender();
		}

		function handleInput(data: string): void {
			if (matchesKey(data, Key.up)) {
				cursor = Math.max(0, cursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = Math.max(0, Math.min(items.length - 1, cursor + 1));
				refresh();
				return;
			}
			if (matchesKey(data, Key.space)) {
				const item = items[cursor];
				if (!item) return;
				if (selected.has(item.id)) selected.delete(item.id);
				else selected.add(item.id);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				return done(items.filter((i) => selected.has(i.id)).map((i) => i.id));
			}
			if (matchesKey(data, Key.escape)) return done(null);
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const lines: string[] = [];
			lines.push(theme.fg("accent", "\u2500".repeat(width)));
			lines.push(
				` ${theme.fg("accent", theme.bold("Post review"))} ${theme.fg("muted", `\u00b7 ${selected.size}/${items.length} note${items.length === 1 ? "" : "s"} selected`)}`,
			);
			lines.push("");

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				const isCursor = i === cursor;
				const box = selected.has(item.id) ? theme.fg("success", "\u2611") : theme.fg("dim", "\u2610");
				const marker = isCursor ? theme.fg("accent", "\u25b8") : " ";
				const sev = theme.fg(severityColor(item.severity), `[${item.severity}]`);
				const kind = theme.fg("muted", `${item.inline ? "inline" : "general"} ${item.location}`);
				const head = `${marker} ${box} ${theme.fg("muted", `#${item.id}`)} ${sev} ${kind}`;
				lines.push(truncateToWidth(head, width));
				const excerpt = item.body.replace(/\s+/g, " ").trim();
				lines.push(`      ${truncateToWidth(theme.fg("text", excerpt), Math.max(1, width - 6))}`);
			}

			lines.push("");
			lines.push(
				theme.fg("dim", ` ${truncateToWidth("\u2191\u2193 move \u00b7 space toggle \u00b7 enter post \u00b7 esc cancel", width - 1)}`),
			);
			lines.push(theme.fg("accent", "\u2500".repeat(width)));
			cached = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});
}
