/**
 * Unit tests for the code-review pure state core: the JSON-event reducer, stderr
 * capping, final-output extraction, and the raceAbort control-flow helper.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@earendil-works/pi-ai";

import {
  ABORTED,
  applyEvent,
  appendStderr,
  createReviewState,
  getFinalOutput,
  MAX_ACTIVITY_ITEMS,
  MAX_STDERR_LENGTH,
  raceAbort,
} from "./review-state.ts";

function assistantEnd(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], ...extra },
  };
}

test("createReviewState seeds the requested model and empty accumulators", () => {
  const state = createReviewState("anthropic/claude");
  assert.equal(state.resolvedModel, "anthropic/claude");
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.activity, []);
  assert.equal(state.streamingText, "");
  assert.equal(state.usage.turns, 0);
});

test("tool_execution_start appends a toolCall activity item", () => {
  const state = createReviewState("m");
  applyEvent(state, { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
  assert.deepEqual(state.activity, [{ type: "toolCall", name: "bash", args: { command: "ls" } }]);
});

test("missing args default to an empty object", () => {
  const state = createReviewState("m");
  applyEvent(state, { type: "tool_execution_start", toolName: "read" });
  assert.deepEqual(state.activity[0], { type: "toolCall", name: "read", args: {} });
});

test("activity is capped to a trailing window", () => {
  const state = createReviewState("m");
  for (let i = 0; i < MAX_ACTIVITY_ITEMS * 2 + 5; i++) {
    applyEvent(state, { type: "tool_execution_start", toolName: "bash", args: { command: `c${i}` } });
  }
  assert.ok(state.activity.length <= MAX_ACTIVITY_ITEMS * 2);
  // The most recent item survives the splice.
  const last = state.activity.at(-1);
  assert.equal(last?.type === "toolCall" && (last.args.command as string), `c${MAX_ACTIVITY_ITEMS * 2 + 4}`);
});

test("message_update text_delta accumulates streaming text", () => {
  const state = createReviewState("m");
  applyEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
  applyEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
  assert.equal(state.streamingText, "Hello");
});

test("non-text deltas are ignored", () => {
  const state = createReviewState("m");
  applyEvent(state, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } });
  assert.equal(state.streamingText, "");
});

test("assistant message_end records message, usage, model, and flushes streaming text", () => {
  const state = createReviewState("requested");
  applyEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
  applyEvent(
    state,
    assistantEnd("Final review", {
      model: "actual/model",
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: { total: 0.0123 } },
    }),
  );

  assert.equal(state.messages.length, 1);
  assert.equal(state.usage.turns, 1);
  assert.equal(state.usage.input, 100);
  assert.equal(state.usage.output, 20);
  assert.equal(state.usage.cacheRead, 5);
  assert.equal(state.usage.cacheWrite, 2);
  assert.equal(state.usage.cost, 0.0123);
  assert.equal(state.resolvedModel, "actual/model");
  // Streamed text is finalized as an activity item and cleared.
  assert.equal(state.streamingText, "");
  assert.deepEqual(state.activity.at(-1), { type: "text", text: "partial" });
});

test("usage accumulates across multiple assistant turns", () => {
  const state = createReviewState("m");
  applyEvent(state, assistantEnd("a", { usage: { input: 10, output: 1, cost: { total: 0.001 } } }));
  applyEvent(state, assistantEnd("b", { usage: { input: 5, output: 2, cost: { total: 0.002 } } }));
  assert.equal(state.usage.turns, 2);
  assert.equal(state.usage.input, 15);
  assert.equal(state.usage.output, 3);
  assert.ok(Math.abs(state.usage.cost - 0.003) < 1e-9);
});

test("getFinalOutput returns the last assistant text, skipping tool results", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ] as unknown as Message[];
  assert.equal(getFinalOutput(messages), "final answer");
});

test("getFinalOutput returns empty string with no assistant content", () => {
  assert.equal(getFinalOutput([]), "");
});

test("appendStderr caps and marks truncation", () => {
  const state = createReviewState("m");
  appendStderr(state, "x".repeat(MAX_STDERR_LENGTH * 2));
  assert.ok(state.stderr.length <= MAX_STDERR_LENGTH);
  assert.ok(state.stderr.endsWith("... (truncated)"));
  // Further writes are dropped once capped.
  const capped = state.stderr;
  appendStderr(state, "more");
  assert.equal(state.stderr, capped);
});

test("raceAbort resolves the underlying value when the signal never fires", async () => {
  const controller = new AbortController();
  const result = await raceAbort(Promise.resolve("done"), controller.signal);
  assert.equal(result, "done");
});

test("raceAbort with no signal passes the promise through", async () => {
  assert.equal(await raceAbort(Promise.resolve(42)), 42);
});

test("raceAbort returns ABORTED when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await raceAbort(Promise.resolve("ignored"), controller.signal), ABORTED);
});

test("raceAbort returns ABORTED when the signal fires before the promise settles", async () => {
  const controller = new AbortController();
  const never = new Promise<string>(() => {});
  const raced = raceAbort(never, controller.signal);
  controller.abort();
  assert.equal(await raced, ABORTED);
});

test("raceAbort propagates rejection", async () => {
  const controller = new AbortController();
  await assert.rejects(raceAbort(Promise.reject(new Error("boom")), controller.signal), /boom/);
});
