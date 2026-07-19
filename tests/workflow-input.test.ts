import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEffortState, effortDirective } from "../src/effort-command.js";
import {
  buildEffortWorkflowPrompt,
  buildForcedWorkflowPrompt,
  EFFORT_CONVERSATIONAL_ESCAPE,
  installWorkflowInputHandling,
  WORKFLOW_TOOL_NAME,
} from "../src/workflow-input.js";

type EventHandler = (event?: { source?: string; text?: string }) => unknown;

function harness(initialTools = ["bash", "read"]): {
  handlers: Record<string, EventHandler[]>;
  activeTools: string[];
  pi: ExtensionAPI;
} {
  const handlers: Record<string, EventHandler[]> = {};
  const activeTools = [...initialTools];
  const pi = {
    on: (event: string, handler: EventHandler) => {
      const eventHandlers = handlers[event] ?? [];
      eventHandlers.push(handler);
      handlers[event] = eventHandlers;
    },
    registerCommand: () => {},
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools.splice(0, activeTools.length, ...tools);
    },
  } as unknown as ExtensionAPI;
  return { handlers, activeTools, pi };
}

test("ordinary messages mentioning workflow are returned unchanged", () => {
  const h = harness();
  installWorkflowInputHandling(h.pi);

  for (const text of [
    "Please explain how the workflow tool works.",
    "The workflows documentation needs an example.",
    "Open src/workflow-input.ts and review it.",
  ]) {
    assert.deepEqual(h.handlers.input[0]({ source: "interactive", text }), { action: "continue" });
    assert.deepEqual(h.activeTools, ["bash", "read"]);
  }
});

test("ordinary messages never receive the workflows mode directive", () => {
  const h = harness();
  installWorkflowInputHandling(h.pi);
  const result = h.handlers.input[0]({ source: "interactive", text: "workflow is only a topic here" });
  assert.deepEqual(result, { action: "continue" });
  assert.doesNotMatch(JSON.stringify(result), /workflows mode armed/i);
});

test("standing effort mode remains an explicit independent opt-in", () => {
  const effort = createEffortState();
  effort.level = "high";
  const h = harness();
  installWorkflowInputHandling(h.pi, effort);

  const text = "Please audit the authentication module for race conditions.";
  const result = h.handlers.input[0]({ source: "interactive", text });
  const extra = [effortDirective("high"), EFFORT_CONVERSATIONAL_ESCAPE].join(" ");
  assert.deepEqual(result, {
    action: "transform",
    text: buildEffortWorkflowPrompt(text, extra),
  });
  assert.ok(h.activeTools.includes(WORKFLOW_TOOL_NAME));
});

test("effort mode can restore the original tools after the turn", () => {
  const effort = createEffortState();
  effort.level = "ultra";
  const h = harness(["bash", "read", "custom"]);
  installWorkflowInputHandling(h.pi, effort);

  h.handlers.input[0]({ source: "interactive", text: "Investigate this repository thoroughly." });
  assert.ok(h.activeTools.includes(WORKFLOW_TOOL_NAME));
  h.handlers.turn_end[0]();
  assert.deepEqual(h.activeTools, ["bash", "read", "custom"]);
});

test("non-interactive messages are never transformed", () => {
  const effort = createEffortState();
  effort.level = "high";
  const h = harness();
  installWorkflowInputHandling(h.pi, effort);
  assert.deepEqual(h.handlers.input[0]({ source: "api", text: "run a workflow" }), { action: "continue" });
});

test("explicit workflow prompt remains direct", () => {
  const prompt = buildForcedWorkflowPrompt("audit the repository");
  assert.match(prompt, /\/workflows run/);
  assert.match(prompt, /Call the `workflow` tool now/);
  assert.doesNotMatch(prompt, /answer it directly and stay/i);
});

test("progress command remains available without input arming", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  let settings: Record<string, unknown> = {};
  const h = harness();
  const pi = {
    ...h.pi,
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, command);
    },
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  installWorkflowInputHandling(pi, undefined, {
    settingsStore: {
      load: () => settings,
      save: (next) => {
        settings = { ...settings, ...next };
      },
    },
  });
  await commands.get("workflows-progress")?.handler("detailed", {});
  assert.deepEqual(settings, { progressPanelMode: "detailed" });
  assert.equal(commands.has("workflows-trigger"), false);
});
