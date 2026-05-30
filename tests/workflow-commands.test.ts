import assert from "node:assert/strict";
import test from "node:test";
import { registerWorkflowCommands } from "../src/workflow-commands.js";

type Handler = (args: string, ctx: any) => Promise<void>;

/** Capture the registered command + outputs for assertions. */
function harness(managerOverrides: Record<string, any> = {}) {
  const printed: string[] = [];
  const notified: Array<{ message: string; type?: string }> = [];
  const calls: string[] = [];
  let handler: Handler | undefined;

  const pi: any = {
    getCommands: () => [],
    registerCommand: (_name: string, opts: { handler: Handler }) => {
      handler = opts.handler;
    },
    sendMessage: async (m: { content: string }) => {
      printed.push(m.content);
    },
  };

  const manager: any = {
    listRuns: () => [],
    getSnapshot: () => null,
    getRun: () => undefined,
    stop: (id: string) => (calls.push(`stop:${id}`), true),
    pause: (id: string) => (calls.push(`pause:${id}`), true),
    resume: async (id: string) => (calls.push(`resume:${id}`), false),
    deleteRun: (id: string) => (calls.push(`rm:${id}`), true),
    ...managerOverrides,
  };

  registerWorkflowCommands(pi, manager);
  const ctx = { ui: { notify: (message: string, type?: string) => notified.push({ message, type }) } };
  const run = (args: string) => {
    if (!handler) throw new Error("command not registered");
    return handler(args, ctx);
  };
  return { run, printed, notified, calls };
}

test("/workflows list shows empty hint when no runs", async () => {
  const h = harness();
  await h.run("list");
  assert.match(h.printed[0], /No workflow runs yet/);
});

test("/workflows (no args) defaults to list", async () => {
  const h = harness({
    listRuns: () => [{ runId: "run-1", workflowName: "demo", status: "completed", phases: [], agents: [], logs: [] }],
  });
  await h.run("");
  assert.match(h.printed[0], /Workflow runs:/);
  assert.match(h.printed[0], /run-1/);
});

test("/workflows stop <id> calls manager.stop", async () => {
  const h = harness();
  await h.run("stop run-9");
  assert.deepEqual(h.calls, ["stop:run-9"]);
});

test("/workflows status <id> renders a persisted run", async () => {
  const h = harness({
    listRuns: () => [
      {
        runId: "run-7",
        workflowName: "audit",
        status: "completed",
        phases: ["Scan"],
        agents: [{ id: 1, label: "scan files", status: "done", prompt: "x" }],
        logs: [],
        tokenUsage: { input: 10, output: 5, total: 15 },
      },
    ],
  });
  await h.run("status run-7");
  assert.match(h.printed[0], /audit \(run-7\)/);
  assert.match(h.printed[0], /scan files/);
});

test("/workflows status without id warns", async () => {
  const h = harness();
  await h.run("status");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
});

test("registerWorkflowCommands is idempotent (skips when already registered)", () => {
  let registrations = 0;
  const pi: any = {
    getCommands: () => [{ name: "workflows" }],
    registerCommand: () => {
      registrations++;
    },
  };
  registerWorkflowCommands(pi, {} as any);
  assert.equal(registrations, 0);
});
