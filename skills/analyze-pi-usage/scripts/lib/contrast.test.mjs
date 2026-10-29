import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The palettes live in the shell's CSS; this reads them from there so a tweak
// to a color cannot quietly break readability.
const css = readFileSync(new URL("../../assets/report-shell.html", import.meta.url), "utf8");

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no CSS block for ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_GROUNDS = ["page", "surface", "raised"];
const ACCENTS = ["green", "aqua", "blue", "yellow", "orange", "red", "purple"];
const FILLS = ["c-you", "c-agent", "c-main", "c-reviews", "c-other", "c-heat", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"];

const themes = {
  dark: block(':root[data-theme="dark"]'),
  light: block(':root[data-theme="light"]'),
  print: { ...block(':root[data-theme="light"]'), ...block(":root, :root[data-theme]") },
};

for (const [name, t] of Object.entries(themes)) {
  test(`${name} palette meets its contrast targets`, () => {
    const failures = [];
    const need = (fg, bg, min) => {
      assert.ok(t[fg] && t[bg], `${name}: --${fg} or --${bg} missing`);
      const ratio = contrast(t[fg], t[bg]);
      if (ratio < min) failures.push(`--${fg} on --${bg}: ${ratio.toFixed(2)} < ${min}`);
    };
    for (const bg of TEXT_GROUNDS) {
      need("ink-strong", bg, 10);
      need("ink", bg, 10);
      need("ink-2", bg, 7);
      need("ink-3", bg, 4.5);
      for (const accent of ACCENTS) need(accent, bg, 5);
    }
    for (const fill of FILLS) if (t[fill]) need(fill, "surface", 3);
    if (name !== "print") need("focus", "page", 3);
    assert.deepEqual(failures, []);
  });
}

test("the contrast helper matches WCAG reference values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(1), "21.0");
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
});
