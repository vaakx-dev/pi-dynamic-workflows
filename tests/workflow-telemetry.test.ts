import assert from "node:assert/strict";
import test from "node:test";
import {
  formatActivity,
  normalizeAgentActivity,
  safeHistoryEntry,
  safeToolTarget,
  summarizeTool,
} from "../src/workflow-telemetry.js";

test("normalizes SDK tool lifecycle without exposing arguments", () => {
  const start = normalizeAgentActivity(
    { type: "tool_execution_start", toolName: "read", args: { file: "src/index.ts", token: "secret" } },
    1_000,
  );
  assert.deepEqual(start, {
    kind: "tool",
    summary: "tool read · src/index.ts",
    observedAt: new Date(1_000).toISOString(),
    active: true,
  });
  assert.equal(start?.summary.includes("secret"), false);
  const end = normalizeAgentActivity({ type: "tool_execution_end", toolName: "read", result: "private" }, 2_000);
  assert.equal(end?.active, false);
  assert.equal(end?.summary, "tool read");
});

test("normalizes message lifecycle as bounded semantic states", () => {
  const start = normalizeAgentActivity(
    { type: "message_start", message: { role: "assistant", content: "private" } },
    1,
  );
  const update = normalizeAgentActivity(
    { type: "message_update", message: { role: "assistant", content: "secret" } },
    2,
  );
  const end = normalizeAgentActivity({ type: "message_end", message: { role: "assistant", content: "secret" } }, 3);
  assert.equal(start?.summary, "model response");
  assert.equal(update?.summary, "model response");
  assert.equal(end?.active, false);
  assert.equal(JSON.stringify(update).includes("secret"), false);
});

test("stale activity is explicitly last observed", () => {
  const activity = normalizeAgentActivity({ type: "tool_execution_end", toolName: "bash" }, 10);
  assert.equal(formatActivity(activity, "done"), "last: tool bash");
  assert.ok(activity);
  assert.equal(formatActivity({ ...activity, active: true }, "running"), "tool bash");
});

test("safe target redacts credentials and bounds values", () => {
  assert.equal(safeToolTarget({ url: "https://user:pass@example.test/a?token=secret" }), undefined);
  assert.equal(safeToolTarget({ file: "x".repeat(400) }), undefined);
  assert.equal(summarizeTool("read", { file: "README.md" }), "tool read · README.md");
});

test("history projection never retains model prose, tool arguments, or tool output", () => {
  assert.equal(safeHistoryEntry({ role: "assistant", kind: "text", text: "private reasoning" }).text, "model response");
  assert.equal(
    safeHistoryEntry({ role: "assistant", kind: "toolCall", text: '{"token":"secret"}', toolName: "read" }).text,
    "tool read",
  );
  assert.equal(safeHistoryEntry({ role: "tool", kind: "toolResult", text: "password=secret" }).text, "tool result");
});
