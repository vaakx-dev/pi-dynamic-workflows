import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installResultDelivery, installTaskPanel } from "../src/task-panel.js";

const theme: any = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function fakeManager() {
  const m: any = new EventEmitter();
  m.runs = new Map();
  m.listRuns = () => [...m.runs.values()];
  m.getRun = (id: string) => m.runs.get(id);
  return m;
}

test("installResultDelivery delivers a finished run's report into the conversation", () => {
  const manager = fakeManager();
  const sent: string[] = [];
  const pi: any = { sendMessage: async (msg: any) => sent.push(msg.content) };

  installResultDelivery(pi, manager);
  installResultDelivery(pi, manager); // idempotent — must not double-subscribe

  manager.runs.set("run-1", {
    background: true,
    snapshot: { name: "research", agentCount: 3 },
    result: { result: { report: "Here is the report." }, tokenUsage: { total: 1234 } },
  });
  manager.emit("complete", { runId: "run-1" });

  assert.equal(sent.length, 1, "delivered exactly once despite double install");
  assert.match(sent[0], /research/);
  assert.match(sent[0], /Here is the report\./);
  assert.match(sent[0], /1,234 tokens/);
});

test("installResultDelivery does not deliver a foreground (sync) run's result", () => {
  const manager = fakeManager();
  const sent: string[] = [];
  const pi: any = { sendMessage: async (msg: any) => sent.push(msg.content) };
  installResultDelivery(pi, manager);

  // Foreground run: result is returned inline as the tool result, so delivering
  // it again into the chat would duplicate it.
  manager.runs.set("run-fg", {
    background: false,
    snapshot: { name: "sync", agentCount: 1 },
    result: { result: { report: "inline" } },
  });
  manager.emit("complete", { runId: "run-fg" });
  assert.equal(sent.length, 0, "foreground runs are not re-delivered");
});

test("installResultDelivery reports failures (background only)", () => {
  const manager = fakeManager();
  const sent: string[] = [];
  const pi: any = { sendMessage: async (msg: any) => sent.push(msg.content) };
  installResultDelivery(pi, manager);
  manager.runs.set("run-9", { background: true });
  manager.emit("error", { runId: "run-9", error: { message: "boom" } });
  assert.match(sent[0], /run-9 failed: boom/);
});

test("installTaskPanel shows running runs and opens the navigator on enter", () => {
  const manager = fakeManager();
  manager.runs.set("run-1", {
    runId: "run-1",
    workflowName: "audit",
    status: "running",
    agents: [
      { id: 1, status: "done" },
      { id: 2, status: "running" },
    ],
  });
  // live snapshot for the running run
  manager.getRun = (id: string) =>
    id === "run-1"
      ? { snapshot: { name: "audit", currentPhase: "Scan", agents: manager.runs.get("run-1").agents } }
      : undefined;

  let widgetFactory: any;
  let customOpened = false;
  const ui: any = {
    setWidget: (_key: string, factory: any) => {
      widgetFactory = factory;
    },
    custom: async () => {
      customOpened = true;
    },
  };
  const pi: any = {};

  installTaskPanel(pi, manager, ui, {});
  assert.equal(typeof widgetFactory, "function");

  const tui: any = { requestRender: () => {} };
  const comp = widgetFactory(tui, theme);
  const lines = comp.render(80).join("\n");
  assert.match(lines, /Workflows running \(1\)/);
  assert.match(lines, /◆ audit\s+1\/2 agents · Scan/);

  // Enter opens the navigator.
  comp.handleInput("\r");
  assert.equal(customOpened, true);
});

test("installTaskPanel renders nothing when no runs are active", () => {
  const manager = fakeManager();
  let widgetFactory: any;
  const ui: any = { setWidget: (_k: string, f: any) => (widgetFactory = f), custom: async () => {} };
  installTaskPanel({} as any, manager, ui, {});
  const comp = widgetFactory({ requestRender: () => {} }, theme);
  assert.deepEqual(comp.render(80), []);
});
