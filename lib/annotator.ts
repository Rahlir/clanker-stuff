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
 * where Enter is needed for actions. ctx.ui.editor has no overlay form, so this
 * step drops from the floating overlay to pi's dock dialog and back.
 *
 * Esc is always an escape hatch: it resolves to `skip` even when "skip" is not
 * in the visible action set, so callers should always handle the skip outcome.
 *
 * Single instance at a time: pi's ctx.ui.custom has no mutual exclusion. Two
 * components opened concurrently fight over focus: the second one wins and the
 * first's promise never settles, so that tool call hangs for the rest of the
 * session. Tools that call openAnnotator must therefore declare
 * `executionMode: "sequential"`, which makes pi run the whole tool batch one call
 * at a time instead of concurrently. openAnnotator additionally holds the shared
 * lock from lib/ui-lock.ts, so a caller that forgets gets an error instead of a
 * hang; the lock covers the ctx.ui.editor round-trip too, since that dialog
 * takes focus as well.
 *
 * Rendered as a centered overlay in both TUI modes: in fullscreen it floats over
 * the transcript instead of squashing the bottom dock, and in regular mode the
 * composited frame is exactly terminal height, so an over-tall component can no
 * longer degrade pi's renderer into full-screen repaints. pi clips an overlay
 * past its maxHeight, so the component still budgets itself: chrome is pinned,
 * the middle (context/body/annotations) scrolls, and the cursor is kept in view.
 * Cost: pi refuses to switch TUI mode while an overlay is open.
 */

import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type OverlayOptions,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { withUiLock } from "./ui-lock.ts";
import { clampToBudget, moreIndicator, windowLines } from "./viewport.ts";

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
// Doubles as the header title and the lock owner label, so both stay in sync.
const DEFAULT_TITLE = "Review";
// Sized in percentages so pi re-resolves the box on terminal resize; the function
// form of overlayOptions would be evaluated once at open time instead. minWidth
// only bites below ~75 columns, where pi clamps back to the full width anyway.
const OVERLAY_WIDTH_PCT = 80;
const OVERLAY_HEIGHT_PCT = 90;
const OVERLAY_OPTIONS: OverlayOptions = {
	width: `${OVERLAY_WIDTH_PCT}%`,
	minWidth: 60,
	maxHeight: `${OVERLAY_HEIGHT_PCT}%`,
	anchor: "center",
};

/** Rows the overlay box allows. Mirrors how pi resolves a percentage SizeValue. */
function overlayBudget(rows: number): number {
	return Math.max(1, Math.floor((rows * OVERLAY_HEIGHT_PCT) / 100));
}

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
	return withUiLock(options.title ?? DEFAULT_TITLE, async (): Promise<AnnotationResult> => {
		// The spinner is misleading while the review is up: we are waiting on the user,
		// not working. Restored in finally so it resumes for later agent work.
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
	});
}

function runComponent(ctx: ExtensionContext, options: AnnotatorOptions): Promise<ComponentResult> {
	const title = options.title ?? DEFAULT_TITLE;
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
			// Free scroll for long body/context (windowLines clamps the offset).
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
		 * Draw the box: pinned chrome and windowed middle, framed on all four sides.
		 *
		 * `inner` is the content width, two columns narrower than the overlay, since the
		 * side borders own a column each. The sides are what stop the panel bleeding into
		 * the transcript behind it, so unlike the top and bottom rules they are never
		 * shed: they cost columns, and the shedding below is only ever buying rows.
		 */
		function frame(
			inner: number,
			parts: {
				header: string;
				subtitle?: string;
				middle: string[];
				cursorRow: number | null;
				/** Rows the cursor's source line occupies once wrapped, with its annotations. */
				cursorSpan?: number;
				footer: string[];
			},
		): string[] {
			const budget = overlayBudget(tui.terminal.rows);
			let useBorders = true;
			let useSubtitle = !!parts.subtitle;
			const fixed = () => (useBorders ? 2 : 0) + 1 + (useSubtitle ? 1 : 0) + parts.footer.length;
			if (fixed() + 1 > budget) useBorders = false;
			if (fixed() + 1 > budget) useSubtitle = false;

			const midBudget = Math.max(0, budget - fixed());
			const mid = windowLines(parts.middle, midBudget, {
				cursor: parts.cursorRow,
				cursorSpan: parts.cursorSpan,
				scroll,
				indicator: moreIndicator(theme),
			});
			scroll = mid.scroll;

			const body: string[] = [parts.header];
			if (useSubtitle && parts.subtitle) body.push(parts.subtitle);
			body.push(...mid.lines);
			body.push(...parts.footer);

			const rule = "\u2500".repeat(inner);
			const side = theme.fg("accent", "\u2502");
			const out: string[] = [];
			if (useBorders) out.push(theme.fg("accent", `\u250c${rule}\u2510`));
			// Pad to exactly `inner` so the right border lands on the edge rather than
			// hugging the text; truncateToWidth's own pad also handles a wide glyph that
			// straddles the boundary, which plain slicing would leave a column short.
			for (const line of body) out.push(side + truncateToWidth(line, inner, "", true) + side);
			if (useBorders) out.push(theme.fg("accent", `\u2514${rule}\u2518`));
			// The shedding above only keeps the corner rules when fixed() < budget, which
			// also guarantees the total fits, so this clamp can never leave a box capped on
			// one side only.
			return clampToBudget(out, budget);
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
			let cursorSpan = 1;
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
				// A wrapped line and its comment bubbles scroll as one unit.
				if (isCursor) cursorSpan = middle.length - cursorRow;
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
				cursorSpan,
				footer,
			});
		}

		return {
			render: (width: number) => {
				const rows = tui.terminal.rows;
				if (cached && cachedWidth === width && cachedRows === rows) return cached;
				// Everything below lays out inside the box; the side borders own two columns.
				const inner = Math.max(1, width - 2);
				cached = mode === "main" ? renderMain(inner) : renderAnnotate(inner);
				cachedWidth = width;
				cachedRows = rows;
				return cached;
			},
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	}, { overlay: true, overlayOptions: OVERLAY_OPTIONS });
}
