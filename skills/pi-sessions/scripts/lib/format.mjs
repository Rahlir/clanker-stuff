// Text output helpers shared by the piss commands.

import { homedir } from "node:os";

const HOME = homedir();
const pad2 = (n) => String(n).padStart(2, "0");

export const short = (p) => (p && (p === HOME || p.startsWith(`${HOME}/`)) ? `~${p.slice(HOME.length)}` : (p ?? "-"));

/** A home-relative path cut from the left, so the informative end survives. */
export function shortPath(p, max = 44) {
  const s = short(p);
  return s.length > max ? `…${s.slice(s.length - max + 1)}` : s;
}

export function localStamp(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const localDate = (iso) => localStamp(iso).slice(0, 10);

export function localTime(iso, { seconds = false } = {}) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ""}`;
}

export function age(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const whole = new Intl.NumberFormat("en-US");

export const money = (n) => (n == null ? "-" : usd.format(n));
export const int = (n) => (n == null ? "-" : whole.format(n));
export const hours = (seconds) => (seconds == null ? "-" : `${(seconds / 3600).toFixed(1)} h`);
export const pct = (part, total) => (total ? `${Math.round((100 * part) / total)}%` : "-");

export function oneLine(text, max = 120) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const indent = (text, prefix = "  ") =>
  String(text)
    .split("\n")
    .map((l) => (l ? prefix + l : l))
    .join("\n");

/**
 * Render rows as an aligned text table. `cols` items: { key, label, right,
 * max, get }; cells are single-line and cut to `max` characters.
 */
export function table(rows, cols) {
  const cell = (row, c) => oneLine(c.get ? c.get(row) : row[c.key], c.max ?? 60);
  const body = rows.map((r) => cols.map((c) => cell(r, c)));
  const widths = cols.map((c, i) => Math.max(c.label.length, ...body.map((r) => r[i].length)));
  const line = (cells) =>
    cells
      .map((v, i) => (cols[i].right ? v.padStart(widths[i]) : v.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(cols.map((c) => c.label)), ...body.map(line)].join("\n");
}

/** Section heading used by multi-part outputs. */
export const heading = (title) => `\n${title.toUpperCase()}`;
