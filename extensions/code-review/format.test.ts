/**
 * Unit tests for the code-review display helpers. `formatToolCall` is exercised
 * with an identity `fg` so assertions read against the raw composed strings.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as os from "node:os";

import { formatElapsed, formatTokens, formatToolCall, formatUsage, shortenPath, stepCount } from "./format.ts";

const fg = (_color: string, text: string) => text;

test("formatTokens scales across magnitudes", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(15000), "15k");
  assert.equal(formatTokens(2_000_000), "2.0M");
});

test("formatUsage joins only the populated parts", () => {
  const line = formatUsage(
    { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.05, turns: 2 },
    "anthropic/claude",
  );
  assert.equal(line, "2 turns \u21911.0k \u2193500 $0.0500 anthropic/claude");
});

test("formatUsage omits zero fields and the model when blank", () => {
  assert.equal(formatUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, ""), "1 turn");
});

test("shortenPath collapses the home directory", () => {
  const home = os.homedir();
  assert.equal(shortenPath(`${home}/code/x.ts`), "~/code/x.ts");
  assert.equal(shortenPath("/etc/hosts"), "/etc/hosts");
});

test("formatToolCall renders a bash preview and truncates long commands", () => {
  assert.equal(formatToolCall("bash", { command: "ls -la" }, fg), "$ ls -la");
  const long = "a".repeat(80);
  assert.ok(formatToolCall("bash", { command: long }, fg).endsWith("..."));
});

test("formatToolCall handles read/grep and falls back for unknown tools", () => {
  assert.equal(formatToolCall("read", { path: "/tmp/a.ts" }, fg), "read /tmp/a.ts");
  assert.equal(formatToolCall("grep", { pattern: "foo", path: "src" }, fg), "grep /foo/ in src");
  assert.ok(formatToolCall("mystery", { a: 1 }, fg).startsWith("mystery"));
});

test("formatElapsed renders seconds and minutes", () => {
  assert.equal(formatElapsed(5000), "5s");
  assert.equal(formatElapsed(65_000), "1m5s");
  assert.equal(formatElapsed(-10), "0s");
});

test("stepCount pluralizes", () => {
  assert.equal(stepCount(0), "0 steps");
  assert.equal(stepCount(1), "1 step");
  assert.equal(stepCount(3), "3 steps");
});
