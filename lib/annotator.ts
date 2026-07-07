/**
 * Reusable draft-review / annotation TUI.
 *
 * A neutral module (not a pi extension): it registers nothing and holds no
 * state. Extensions import openAnnotator and drive it. Used by the `annotate`
 * extension (generic annotate_text tool, /annotate-last) and by `mr-review`
 * (per-issue note review).
 *
 * Two screens in one custom component:
 *   - main:     the text under review + the enabled actions
 *   - annotate: per-line and per-line-range comments + an overall note,
 *               compiled into structured feedback for the caller/agent
 *
 * Manual full-text editing happens OUTSIDE the component via ctx.ui.editor (a
 * native multi-line dialog); the component returns { action: "edit" } and the
 * wrapper re-enters. This keeps multi-line editing out of the custom component,
 * where Enter is needed for actions.
 *
 * Esc is always an escape hatch: it resolves to `skip` even when "skip" is not
 * in the visible action set, so callers should always handle the skip outcome.
 *
 * Viewport safety: pi's differential renderer degrades to full-screen repaints
 * (heavy flicker) when a component emits more lines than the terminal height,
 * because changes then land above the viewport. So the component NEVER emits
 * more than the viewport: fixed chrome (border/header/help) is pinned, the
 * middle (context/body/annotations) scrolls, the cursor is kept in view, and a
 * final clamp guarantees the total fits even on tiny terminals.
 */

import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type AnnotatorAction = "approve" | "annotate" | "edit" | "reject" | "skip";

export interface AnnotatorOptions {
	/** The text to review / annotate. */
	body: string;
	/** Header title. Default "Review". */
	title?: string;
	/** Optional colored tag next to the title, e.g. { text: "[major]", color: "warning" }. */
	tag?: { text: string; color?: ThemeColor };
	/** Optional location shown in the header, e.g. "src/x.ts:42-48". */
	location?: string;
	/** Optional one-line subtitle under the header (main screen). */
	subtitle?: string;
	/** Optional muted context block under the subtitle (main screen). */
	context?: string;
	/** Optional label above the body. Omitted when not set. */
	bodyLabel?: string;
	/** Title for the ctx.ui.editor manual-edit dialog. Default "Edit". */
	editTitle?: string;
	/** Which explicit actions to offer. Default: all five. Esc always maps to skip. */
	actions?: AnnotatorAction[];
}

export type AnnotationResult =
	| { action: "approve" }
	| { action: "edit"; body: string }
	| { action: "annotate"; feedback: string }
	| { action: "reject" }
	| { action: "skip" };

type ComponentResult =
	| { action: "approve" }
	| { action: "edit" }
	| { action: "annotate"; feedback: string }
	| { action: "reject" }
	| { action: "skip" };

interface Annotation {
	start: number;
	end: number;
	comment: string;
}

const BUBBLE = "\u{1F4AC}"; // 💬 (two terminal columns wide)
const ANNOTATION_INDENT = "        "; // 8 cols: marker+space+lineNo(3)+space+bar+space, aligns under line text
const DEFAULT_ACTIONS: AnnotatorAction[] = ["approve", "annotate", "edit", "reject", "skip"];
// Rows kept clear below the component (pi's footer is pwd + stats + an optional
// extension-status line = up to 3). The component fits within
// terminal.rows - FOOTER_RESERVE so per-keypress changes stay inside the
// viewport. This is a hard ceiling, never a floor: on tiny terminals the budget
// shrinks with the window rather than overflowing it.
const FOOTER_RESERVE = 3;

function snippet(text: string): string {
	const t = text.trim();
	return t.length > 60 ? `${t.slice(0, 60)}\u2026` : t;
}

function compileFeedback(lines: string[], annotations: Annotation[], overall: string | null): string {
	const parts: string[] = [];
	for (const a of [...annotations].sort((x, y) => x.start - y.start)) {
		const loc = a.start === a.end ? `Line ${a.start + 1}` : `Lines ${a.start + 1}-${a.end + 1}`;
		parts.push(`- ${loc} ("${snippet(lines[a.start] ?? "")}"): ${a.comment}`);
	}
	if (overall) parts.push(`- Overall: ${overall}`);
	return parts.join("\n");
}

function helpBar(enabled: Set<AnnotatorAction>): string {
	const hints: string[] = [];
	if (enabled.has("approve")) hints.push("enter approve");
	if (enabled.has("annotate")) hints.push("a annotate");
	if (enabled.has("edit")) hints.push("e edit");
	if (enabled.has("reject")) hints.push("r reject");
	if (enabled.has("skip")) hints.push("s skip");
	else hints.push("esc dismiss");
	return hints.join(" \u00b7 ");
}

/**
 * Run the review loop. Returns the final decision, resolving the manual-edit
 * path through ctx.ui.editor.
 */
export async function openAnnotator(ctx: ExtensionContext, options: AnnotatorOptions): Promise<AnnotationResult> {
	const editTitle = options.editTitle ?? "Edit";
	// Suppress the animated "working" spinner while the review UI is open. It is
	// rendered ABOVE our component; when the annotation is tall enough to push it
	// above the viewport, its ~10Hz animation forces full-screen redraws (the
	// heavy flicker). It is also misleading here — we are waiting on the user, not
	// working. Restored in finally so it resumes for later agent work.
	ctx.ui.setWorkingVisible(false);
	try {
		while (true) {
			const res = await runComponent(ctx, options);
			if (res.action !== "edit") return res;

			const edited = await ctx.ui.editor(editTitle, options.body);
			// Cancelled (undefined) or cleared to blank: treat both as a no-op and drop
			// back into the review screen unchanged rather than returning empty text.
			if (edited == null || edited.trim() === "") continue;
			return { action: "edit", body: edited };
		}
	} finally {
		ctx.ui.setWorkingVisible(true);
	}
}

function runComponent(ctx: ExtensionContext, options: AnnotatorOptions): Promise<ComponentResult> {
	const title = options.title ?? "Review";
	const bodyLabel = options.bodyLabel;
	const enabled = new Set(options.actions ?? DEFAULT_ACTIONS);

	return ctx.ui.custom<ComponentResult>((tui, theme, _kb, done) => {
		const bodyLines = options.body.split("\n");

		let mode: "main" | "annotate" = "main";
		let cursor = 0;
		let anchor: number | null = null;
		let inputMode = false;
		let inputKind: "line" | "overall" | null = null;
		const annotations: Annotation[] = [];
		let overall: string | null = null;
		let scroll = 0; // scroll offset into the middle (scrollable) region
		let cached: string[] | undefined;
		// Cache is keyed by width + rows so a terminal resize recomputes the layout
		// (pi does not invalidate component caches on resize).
		let cachedWidth: number | undefined;
		let cachedRows: number | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh(): void {
			cached = undefined;
			tui.requestRender();
		}

		function rangeBounds(): { start: number; end: number } {
			if (anchor === null) return { start: cursor, end: cursor };
			return { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) };
		}

		editor.onSubmit = (value) => {
			const v = value.trim();
			if (v) {
				if (inputKind === "overall") {
					overall = v;
				} else {
					const { start, end } = rangeBounds();
					annotations.push({ start, end, comment: v });
					anchor = null;
				}
			}
			inputMode = false;
			inputKind = null;
			editor.setText("");
			refresh();
		};

		function handleMain(data: string): void {
			if (enabled.has("approve") && (matchesKey(data, Key.enter) || data === "y")) return done({ action: "approve" });
			if (enabled.has("annotate") && data === "a") {
				mode = "annotate";
				cursor = 0;
				anchor = null;
				scroll = 0;
				refresh();
				return;
			}
			if (enabled.has("edit") && data === "e") return done({ action: "edit" });
			if (enabled.has("reject") && data === "r") return done({ action: "reject" });
			if (enabled.has("skip") && data === "s") return done({ action: "skip" });
			// Free scroll for long body/context (windowMiddle clamps the offset).
			if (matchesKey(data, Key.up)) {
				scroll = Math.max(0, scroll - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				scroll += 1;
				refresh();
				return;
			}
			// Esc is always the escape hatch, regardless of the visible action set.
			if (matchesKey(data, Key.escape)) return done({ action: "skip" });
		}

		function handleAnnotate(data: string): void {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					inputKind = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				cursor = Math.max(0, cursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = Math.min(bodyLines.length - 1, cursor + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.space)) {
				anchor = anchor === null ? cursor : null;
				refresh();
				return;
			}
			if (data === "a") {
				inputMode = true;
				inputKind = "line";
				editor.setText("");
				refresh();
				return;
			}
			if (data === "A") {
				inputMode = true;
				inputKind = "overall";
				editor.setText("");
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (annotations.length === 0 && !overall) return; // nothing to submit yet
				return done({ action: "annotate", feedback: compileFeedback(bodyLines, annotations, overall) });
			}
			// No manual-edit shortcut here: it would discard unsaved annotations.
			// Esc returns to the main screen, then press e there.
			if (matchesKey(data, Key.escape)) {
				mode = "main";
				anchor = null;
				scroll = 0;
				refresh();
				return;
			}
		}

		function handleInput(data: string): void {
			if (mode === "main") handleMain(data);
			else handleAnnotate(data);
		}

		function headerLine(annotateMode: boolean): string {
			let h = theme.fg("accent", theme.bold(title));
			if (annotateMode) h += theme.fg("muted", " \u00b7 annotate");
			if (options.tag) h += ` ${theme.fg(options.tag.color ?? "muted", options.tag.text)}`;
			if (options.location) h += ` ${theme.fg("muted", `\u00b7 ${options.location}`)}`;
			return h;
		}

		/**
		 * Window the scrollable middle to `budget` rows, following `cursorRow` when
		 * given. Reserves two rows for "N more" indicators when clipped, so the
		 * returned length is always <= budget. Mutates `scroll` (cursor-follow /
		 * clamp).
		 */
		function windowMiddle(middle: string[], budget: number, cursorRow: number | null): string[] {
			if (budget <= 0) return [];
			if (middle.length <= budget) {
				scroll = 0;
				return middle;
			}
			const visible = Math.max(1, budget - 2);
			if (cursorRow != null) {
				if (cursorRow < scroll) scroll = cursorRow;
				else if (cursorRow >= scroll + visible) scroll = cursorRow - visible + 1;
			}
			scroll = Math.max(0, Math.min(scroll, middle.length - visible));
			const above = scroll;
			const below = middle.length - (scroll + visible);
			const out: string[] = [theme.fg("dim", above > 0 ? ` \u2191 ${above} more` : "")];
			for (const l of middle.slice(scroll, scroll + visible)) out.push(l);
			out.push(theme.fg("dim", below > 0 ? ` \u2193 ${below} more` : ""));
			return out;
		}

		/**
		 * Assemble pinned chrome + windowed middle within the viewport budget.
		 * On tiny terminals, drop borders then the subtitle to preserve the middle,
		 * and hard-clamp the total so the component never overflows the viewport.
		 */
		function frame(
			width: number,
			parts: { header: string; subtitle?: string; middle: string[]; cursorRow: number | null; footer: string[] },
		): string[] {
			const budget = Math.max(1, tui.terminal.rows - FOOTER_RESERVE);
			let useBorders = true;
			let useSubtitle = !!parts.subtitle;
			const fixed = () => (useBorders ? 2 : 0) + 1 + (useSubtitle ? 1 : 0) + parts.footer.length;
			if (fixed() + 1 > budget) useBorders = false;
			if (fixed() + 1 > budget) useSubtitle = false;

			const midBudget = Math.max(0, budget - fixed());
			const mid = windowMiddle(parts.middle, midBudget, parts.cursorRow);

			const border = theme.fg("accent", "\u2500".repeat(width));
			const out: string[] = [];
			if (useBorders) out.push(border);
			out.push(parts.header);
			if (useSubtitle && parts.subtitle) out.push(parts.subtitle);
			out.push(...mid);
			out.push(...parts.footer);
			if (useBorders) out.push(border);
			// Absolute guarantee: never exceed the viewport, even if chrome alone is large.
			return out.slice(0, budget);
		}

		function renderMain(width: number): string[] {
			// Leading blank separates the pinned header/subtitle from the content so the
			// muted subtitle and muted context don't visually merge.
			const middle: string[] = [""];
			if (options.context?.trim()) {
				for (const line of options.context.split("\n")) {
					if (line === "") {
						middle.push("");
						continue;
					}
					for (const piece of wrapTextWithAnsi(line, width - 2)) middle.push(theme.fg("muted", ` ${piece}`));
				}
				middle.push("");
			}
			if (bodyLabel) middle.push(theme.fg("dim", ` ${bodyLabel}`));
			for (const line of bodyLines) {
				if (line === "") {
					middle.push("");
					continue;
				}
				// Soft-wrap so long lines stay fully visible (display only; the result
				// text keeps its original line breaks).
				for (const piece of wrapTextWithAnsi(line, width - 2)) middle.push(` ${theme.fg("text", piece)}`);
			}

			return frame(width, {
				header: ` ${truncateToWidth(headerLine(false), width - 1)}`,
				subtitle: options.subtitle
					? theme.fg("muted", theme.bold(` ${truncateToWidth(options.subtitle, width - 2)}`))
					: undefined,
				middle,
				cursorRow: null,
				footer: [theme.fg("dim", ` ${truncateToWidth(helpBar(enabled), width - 1)}`)],
			});
		}

		function renderAnnotate(width: number): string[] {
			const middle: string[] = [];
			let cursorRow = 0;
			const { start, end } = rangeBounds();
			const contPrefix = ANNOTATION_INDENT;
			const textWidth = Math.max(1, width - visibleWidth(contPrefix));
			for (let i = 0; i < bodyLines.length; i++) {
				if (i === cursor) cursorRow = middle.length;
				const isCursor = i === cursor;
				const inRange = anchor !== null && i >= start && i <= end;
				const marker = isCursor ? theme.fg("accent", "\u25b8") : " ";
				const lineNo = String(i + 1).padStart(3);
				const firstPrefix = `${marker} ${theme.fg("dim", `${lineNo} \u2502`)} `;
				const raw = bodyLines[i] ?? "";
				const pieces = raw === "" ? [""] : wrapTextWithAnsi(raw, textWidth);
				pieces.forEach((piece, idx) => {
					const styled = isCursor
						? theme.bg("selectedBg", theme.fg("text", piece))
						: inRange
							? theme.fg("accent", piece)
							: theme.fg("text", piece);
					middle.push((idx === 0 ? firstPrefix : contPrefix) + styled);
				});

				for (const a of annotations) {
					if (a.end === i) {
						const w = Math.max(1, width - visibleWidth(`${ANNOTATION_INDENT}${BUBBLE} `));
						wrapTextWithAnsi(a.comment, w).forEach((piece, idx) => {
							const lead = idx === 0 ? `${BUBBLE} ` : "  ";
							middle.push(`${ANNOTATION_INDENT}${theme.fg("accent", lead + piece)}`);
						});
					}
				}
			}

			if (overall) {
				const w = Math.max(1, width - visibleWidth(`  ${BUBBLE} overall: `));
				middle.push("");
				wrapTextWithAnsi(overall, w).forEach((piece, idx) => {
					const lead = idx === 0 ? `${BUBBLE} overall: ` : "  ";
					middle.push(`  ${theme.fg("accent", lead + piece)}`);
				});
			}

			let footer: string[];
			if (inputMode) {
				const { start: s, end: e } = rangeBounds();
				const label =
					inputKind === "overall"
						? "Overall note:"
						: s === e
							? `Comment on line ${s + 1}:`
							: `Comment on lines ${s + 1}-${e + 1}:`;
				footer = [theme.fg("muted", ` ${label}`)];
				for (const l of editor.render(width - 2)) footer.push(` ${l}`);
				footer.push(theme.fg("dim", " enter save \u00b7 esc cancel"));
			} else {
				footer = [
					theme.fg(
						"dim",
						` ${truncateToWidth(
							"\u2191\u2193 move \u00b7 space range \u00b7 a annotate \u00b7 A overall \u00b7 enter submit \u00b7 esc back",
							width - 1,
						)}`,
					),
				];
			}

			return frame(width, {
				header: ` ${truncateToWidth(headerLine(true), width - 1)}`,
				middle,
				// Follow the cursor only when navigating, not while typing a comment.
				cursorRow: inputMode ? null : cursorRow,
				footer,
			});
		}

		return {
			render: (width: number) => {
				const rows = tui.terminal.rows;
				if (cached && cachedWidth === width && cachedRows === rows) return cached;
				cached = mode === "main" ? renderMain(width) : renderAnnotate(width);
				cachedWidth = width;
				cachedRows = rows;
				return cached;
			},
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});
}
