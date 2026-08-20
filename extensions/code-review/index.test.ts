/**
 * Smoke test for the code-review extension wiring. Calls the factory with a fake
 * ExtensionAPI (no pi runtime, no subprocess, no model) and asserts it registers
 * the four review tools and the session lifecycle handlers it relies on for the
 * job registry and background widget.
 *
 * Behavior of the job lifecycle itself lives in the pure core (review-state.ts)
 * and is covered by review-state.test.ts; the runtime/TUI paths are exercised
 * manually in pi.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import codeReview from "./index.ts";

test("wiring: registers the four review tools and lifecycle handlers", () => {
  const toolNames: string[] = [];
  const events: string[] = [];

  codeReview({
    registerTool: (def: { name: string }) => {
      toolNames.push(def.name);
    },
    on: (event: string) => {
      events.push(event);
    },
  } as unknown as ExtensionAPI);

  assert.deepEqual([...toolNames].sort(), [
    "code_review",
    "code_review_await",
    "code_review_cancel",
    "code_review_status",
  ]);
  assert.ok(events.includes("session_start"), "must capture the UI on session_start");
  assert.ok(events.includes("session_shutdown"), "must reap background jobs on session_shutdown");
});
