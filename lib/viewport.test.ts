/**
 * Unit tests for the shared viewport helpers: the per-mode height budget, and a
 * window that never exceeds it while keeping the cursor visible.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  clampToBudget,
  isFullscreen,
  moreIndicator,
  VIEWPORT_TUI,
  type ViewportTarget,
  viewportBudget,
  windowLines,
} from "./viewport.ts";

function regular(rows: number): ViewportTarget {
  return { terminal: { rows } };
}

function fullscreen(rows: number): ViewportTarget {
  return { terminal: { rows }, [VIEWPORT_TUI]: true };
}

/** Blank at an edge, like the themed rows it stands in for. */
const indicator = (direction: "up" | "down", hidden: number) => (hidden > 0 ? `${direction}:${hidden}` : "");

const plainTheme = { fg: (_color: "dim", text: string) => text };

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `L${i}`);

test("isFullscreen reads pi-tui's viewport brand", () => {
  assert.equal(isFullscreen(regular(40)), false);
  assert.equal(isFullscreen(fullscreen(40)), true);
});

test("isFullscreen ignores a brand that is not exactly true", () => {
  assert.equal(isFullscreen({ terminal: { rows: 40 }, [VIEWPORT_TUI]: "yes" }), false);
});

// The brand key is reproduced in viewport.ts rather than imported, so nothing else
// catches pi renaming it: isFullscreen would just answer false forever and every
// fullscreen component would silently get the roomier regular-mode budget. Assert
// our brand against the reader pi actually uses. Skipped on pi-tui versions that
// predate the export, since there is then nothing to compare against.
test("the reproduced brand is the one pi-tui reads", async (t) => {
  const piTui = (await import("@earendil-works/pi-tui")) as {
    isViewportTUI?: (tui: object) => boolean;
  };
  if (!piTui.isViewportTUI) {
    t.skip("installed pi-tui predates isViewportTUI");
    return;
  }
  assert.equal(piTui.isViewportTUI(fullscreen(40)), true);
  assert.equal(piTui.isViewportTUI(regular(40)), false);
});

test("viewportBudget reserves more rows in fullscreen than in regular mode", () => {
  assert.equal(viewportBudget(regular(40)), 37);
  assert.equal(viewportBudget(fullscreen(40)), 33);
});

test("viewportBudget never drops below one row", () => {
  assert.equal(viewportBudget(regular(2)), 1);
  assert.equal(viewportBudget(fullscreen(5)), 1);
  assert.equal(viewportBudget(fullscreen(0)), 1);
});

test("content that fits is returned whole and resets a stale scroll", () => {
  const result = windowLines(numbered(4), 10, { scroll: 3, indicator });
  assert.deepEqual(result.lines, ["L0", "L1", "L2", "L3"]);
  assert.equal(result.scroll, 0);
});

test("a zero or negative budget renders nothing", () => {
  assert.deepEqual(windowLines(numbered(4), 0, { indicator }), { lines: [], scroll: 0 });
  assert.deepEqual(windowLines(numbered(4), -5, { indicator }), { lines: [], scroll: 0 });
});

test("clipped content fills the budget exactly, indicators included", () => {
  const result = windowLines(numbered(20), 6, { indicator });
  assert.equal(result.lines.length, 6);
  assert.deepEqual(result.lines, ["", "L0", "L1", "L2", "L3", "down:16"]);
  assert.equal(result.scroll, 0);
});

test("both indicator rows are present mid-list so the height stays stable", () => {
  const result = windowLines(numbered(20), 6, { scroll: 5, indicator });
  assert.deepEqual(result.lines, ["up:5", "L5", "L6", "L7", "L8", "down:11"]);
  assert.equal(result.scroll, 5);
});

test("the cursor pulls the window down when it falls below the window", () => {
  const result = windowLines(numbered(20), 6, { cursor: 10, scroll: 0, indicator });
  assert.equal(result.scroll, 7);
  assert.deepEqual(result.lines, ["up:7", "L7", "L8", "L9", "L10", "down:9"]);
});

test("the cursor pulls the window up when it falls above the window", () => {
  const result = windowLines(numbered(20), 6, { cursor: 2, scroll: 9, indicator });
  assert.equal(result.scroll, 2);
  assert.deepEqual(result.lines, ["up:2", "L2", "L3", "L4", "L5", "down:14"]);
});

test("a cursor already inside the window leaves the scroll alone", () => {
  const result = windowLines(numbered(20), 6, { cursor: 6, scroll: 5, indicator });
  assert.equal(result.scroll, 5);
});

test("scroll is clamped to the last full window", () => {
  const result = windowLines(numbered(20), 6, { scroll: 99, indicator });
  assert.equal(result.scroll, 16);
  assert.deepEqual(result.lines, ["up:16", "L16", "L17", "L18", "L19", ""]);
});

test("out-of-range cursors are clamped rather than trusted", () => {
  assert.equal(windowLines(numbered(20), 6, { cursor: -4, scroll: 8, indicator }).scroll, 0);
  assert.equal(windowLines(numbered(20), 6, { cursor: 99, scroll: 0, indicator }).scroll, 16);
});

test("without an indicator the whole budget is content", () => {
  const result = windowLines(numbered(20), 4, { scroll: 2 });
  assert.deepEqual(result.lines, ["L2", "L3", "L4", "L5"]);
  assert.equal(result.scroll, 2);
});

test("budgets too small for indicators spend every row on content", () => {
  const two = windowLines(numbered(20), 2, { cursor: 0, indicator });
  assert.deepEqual(two.lines, ["L0", "L1"]);
  const one = windowLines(numbered(20), 1, { cursor: 5, indicator });
  assert.deepEqual(one.lines, ["L5"]);
});

test("the window never exceeds its budget across the whole scroll range", () => {
  for (const budget of [1, 2, 3, 4, 7, 19]) {
    for (let cursor = 0; cursor < 20; cursor++) {
      const result = windowLines(numbered(20), budget, { cursor, indicator });
      assert.ok(
        result.lines.length <= budget,
        `budget ${budget}, cursor ${cursor}: got ${result.lines.length} lines`,
      );
    }
  }
});

test("a multi-row cursor item is kept whole at the bottom edge", () => {
  // Items of 2 rows: cursor 8 is a head whose excerpt is row 9.
  const result = windowLines(numbered(20), 6, { cursor: 8, cursorSpan: 2, scroll: 0, indicator });
  assert.ok(result.lines.includes("L8"), "head visible");
  assert.ok(result.lines.includes("L9"), "trailing row visible");
});

test("every row of a multi-row item stays visible across the scroll range", () => {
  for (const budget of [4, 6, 9]) {
    for (let head = 0; head < 19; head += 2) {
      const { lines } = windowLines(numbered(20), budget, { cursor: head, cursorSpan: 2, indicator });
      assert.ok(lines.includes(`L${head}`) && lines.includes(`L${head + 1}`), `budget ${budget}, item at ${head}`);
    }
  }
});

test("an item taller than the window keeps its head rather than vanishing", () => {
  const result = windowLines(numbered(20), 5, { cursor: 10, cursorSpan: 9, scroll: 0, indicator });
  assert.ok(result.lines.includes("L10"), "head visible");
  assert.equal(result.scroll, 10);
});

test("clampToBudget drops from the top so pinned trailing rows survive", () => {
  const rows = ["border", "title", "body", "help", "border"];
  assert.deepEqual(clampToBudget(rows, 5), rows);
  assert.deepEqual(clampToBudget(rows, 10), rows);
  assert.deepEqual(clampToBudget(rows, 3), ["body", "help", "border"]);
  assert.deepEqual(clampToBudget(rows, 0), []);
});

test("moreIndicator blanks the edge it is already at", () => {
  const render = moreIndicator(plainTheme);
  assert.equal(render("up", 0), "");
  assert.equal(render("down", 0), "");
  assert.match(render("up", 3), /\u2191 3 more/);
  assert.match(render("down", 12), /\u2193 12 more/);
});

test("the cursor row stays inside the window across the whole scroll range", () => {
  for (const budget of [3, 4, 7, 19]) {
    for (let cursor = 0; cursor < 20; cursor++) {
      const { lines, scroll } = windowLines(numbered(20), budget, { cursor, indicator });
      assert.ok(lines.includes(`L${cursor}`), `budget ${budget}, cursor ${cursor}: scrolled to ${scroll}`);
    }
  }
});
