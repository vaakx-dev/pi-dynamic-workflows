import assert from "node:assert/strict";
import test from "node:test";
import { createEffortState, effortDirective, isSubstantive, registerEffortCommand } from "../src/effort-command.js";
import { buildForcedWorkflowPrompt } from "../src/workflow-editor.js";

test("effortDirective returns a tier nudge for high/ultra, nothing for off", () => {
  assert.equal(effortDirective("off"), undefined);
  assert.match(effortDirective("high") ?? "", /HIGH/);
  assert.match(effortDirective("ultra") ?? "", /ULTRA/);
});

test("isSubstantive accepts real requests, rejects terse text and slash commands", () => {
  assert.equal(isSubstantive("audit the auth module for race conditions"), true);
  assert.equal(isSubstantive("ok"), false);
  assert.equal(isSubstantive("/workflows"), false);
  assert.equal(isSubstantive("    "), false);
});

test("buildForcedWorkflowPrompt appends the extra directive only when provided", () => {
  const base = buildForcedWorkflowPrompt("do X");
  assert.ok(!/ULTRA/.test(base), "no directive by default");
  assert.ok(base.startsWith("do X"));
  const ultra = buildForcedWorkflowPrompt("do X", effortDirective("ultra"));
  assert.match(ultra, /ULTRA/, "ultra directive appended");
  assert.ok(ultra.startsWith("do X"));
});

test("registerEffortCommand toggles the shared state via its handler", async () => {
  const state = createEffortState();
  let def: { handler: (a: string, c: unknown) => Promise<void> } | undefined;
  const pi = {
    registerCommand: (_name: string, d: unknown) => {
      def = d as typeof def;
    },
    sendMessage: () => {},
  };
  registerEffortCommand(pi as never, state);
  assert.equal(state.level, "off");

  await def?.handler("ultra", {});
  assert.equal(state.level, "ultra");

  await def?.handler("high", {});
  assert.equal(state.level, "high");

  await def?.handler("off", {});
  assert.equal(state.level, "off");

  await def?.handler("bogus", {});
  assert.equal(state.level, "off", "unknown arg leaves the level unchanged");
});
