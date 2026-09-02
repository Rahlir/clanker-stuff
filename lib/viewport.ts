/**
 * Height budgeting and scroll windowing for pi's interactive TUI components.
 *
 * A neutral module (not a pi extension): it registers nothing, holds no state,
 * and imports nothing from pi at runtime, so it is unit-testable in isolation.
 *
 * Components must bound their own height, for a different reason per TUI mode.
 * In regular mode, a component taller than the terminal pushes its own changes
 * above the viewport, degrading pi's differential renderer into full-screen
 * repaints (heavy flicker). In fullscreen mode it sits in the fixed bottom dock,
 * which shrinks over-tall entries and clips them at the BOTTOM, hiding the help
 * bar and any embedded editor - the things our components render last.
 *
 * Consult both helpers per render rather than caching: /settings switches the
 * TUI mode at runtime, and the terminal can be resized. Overlay components skip
 * `viewportBudget` (their own `maxHeight` bounds them) but still need
 * `windowLines`, since overlays are bottom-clipped too.
 */

import type { TUI } from "@earendil-works/pi-tui";

// pi-tui brands its alternate-screen renderer with this key and reads it back in
// `isViewportTUI`. Reproduced rather than imported so this module stays free of
// runtime pi imports; Symbol.for makes it a published contract, not an internal.
// The `unique symbol` annotation is what lets it key the interface below.
export const VIEWPORT_TUI: unique symbol = Symbol.for("@earendil-works/pi-tui/viewport");

/**
 * The slice of pi's TUI these helpers need. Structural on purpose: callers pass
 * the real TUI, tests pass a literal, and neither needs a cast.
 */
export interface ViewportTarget {
  terminal: { rows: number };
  /** Present only on the fullscreen renderer; `unknown` so pi may retype it. */
  readonly [VIEWPORT_TUI]?: unknown;
}

/** Fails type-check if pi's TUI stops satisfying the structural slice above. */
type Assert<T extends true> = T;
type _TuiSatisfiesViewportTarget = Assert<TUI extends ViewportTarget ? true : false>;

// Rows kept clear below a docked component. Regular mode only has to clear pi's
// footer: pwd + stats + an optional extension-status line. Fullscreen splits those
// across separate dock entries and adds the rest of the dock, since whatever does
// not fit is taken off OUR bottom: transcript minimum 1 + footer 2 + status/queued
// 1 + 3 for widgets another extension may pop in mid-interaction (code-review's
// background-job widget does exactly that).
const REGULAR_RESERVE = 3;
const FULLSCREEN_RESERVE = 7;

/** True when pi is rendering the fullscreen (alternate-screen) viewport. */
export function isFullscreen(tui: ViewportTarget): boolean {
  return tui[VIEWPORT_TUI] === true;
}

/** Rows a docked component may emit. Floored at 1 rather than going negative. */
export function viewportBudget(tui: ViewportTarget): number {
  const reserve = isFullscreen(tui) ? FULLSCREEN_RESERVE : REGULAR_RESERVE;
  return Math.max(1, tui.terminal.rows - reserve);
}

export interface WindowOptions {
  /** Row to keep visible. Null or omitted scrolls freely from `scroll`. */
  cursor?: number | null;
  /**
   * Rows the cursor's item occupies, when one item spans several rows (a wrapped
   * line, a note plus its excerpt). All of them are kept visible, so scrolling to
   * the bottom edge cannot shear an item in half. Defaults to 1. A span larger
   * than the window keeps the item's first row and clips its tail.
   */
  cursorSpan?: number;
  /** Scroll offset carried over from the previous render. */
  scroll?: number;
  /**
   * Renders the two "N more" rows shown when content is clipped. Return a blank
   * line for `hidden === 0` so the height does not jitter while scrolling. Omit
   * to window without indicator rows.
   */
  indicator?: (direction: "up" | "down", hidden: number) => string;
}

export interface WindowResult {
  /** Rows to render, indicator rows included. */
  lines: string[];
  /** Scroll offset to carry into the next render. */
  scroll: number;
}

/** The slice of pi's Theme the shared indicator needs. */
export interface DimTheme {
  fg(color: "dim", text: string): string;
}

/** The "N more" row every scrolling screen shares, so the affordance stays uniform. */
export function moreIndicator(theme: DimTheme): NonNullable<WindowOptions["indicator"]> {
  return (direction, hidden) =>
    hidden === 0 ? "" : theme.fg("dim", ` ${direction === "up" ? "\u2191" : "\u2193"} ${hidden} more`);
}

/**
 * Fit fully assembled rows into `budget`, dropping from the TOP on overflow.
 *
 * Only bites when pinned chrome alone exceeds the budget, since a windowed middle
 * is already sized to what is left over. In that case the leading border and title
 * are worth less than the trailing help bar and any embedded editor, so the top
 * goes first.
 */
export function clampToBudget(lines: string[], budget: number): string[] {
  if (budget <= 0) return [];
  return lines.length <= budget ? lines : lines.slice(lines.length - budget);
}

/**
 * Clamp `lines` to `budget` rows, following `options.cursor`.
 *
 * Callers depend on: the result never exceeds `budget`; content that fits comes
 * back whole with `scroll` reset to 0; the returned `scroll` feeds the next render.
 */
export function windowLines(lines: readonly string[], budget: number, options: WindowOptions = {}): WindowResult {
  if (budget <= 0) return { lines: [], scroll: 0 };
  if (lines.length <= budget) return { lines: [...lines], scroll: 0 };

  // Indicators are worth their two rows only while a content row survives them.
  const indicator = budget >= 3 ? options.indicator : undefined;
  const visible = indicator ? budget - 2 : budget;

  let scroll = Math.max(0, Math.floor(options.scroll ?? 0));
  const cursor = options.cursor;
  if (cursor != null) {
    const span = Math.max(1, Math.floor(options.cursorSpan ?? 1));
    const cursorEnd = cursor + span - 1;
    if (cursor < scroll) scroll = cursor;
    // Never scroll past the cursor itself: an item taller than the window keeps
    // its head rather than sliding out of view entirely.
    else if (cursorEnd >= scroll + visible) scroll = Math.min(cursor, cursorEnd - visible + 1);
  }
  scroll = Math.max(0, Math.min(scroll, lines.length - visible));

  const out: string[] = indicator ? [indicator("up", scroll)] : [];
  out.push(...lines.slice(scroll, scroll + visible));
  if (indicator) out.push(indicator("down", lines.length - (scroll + visible)));
  return { lines: out, scroll };
}
