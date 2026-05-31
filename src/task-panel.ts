/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    Focus it (↓) and press enter to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseKey } from "@earendil-works/pi-tui";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import { openWorkflowNavigator } from "./workflow-ui.js";

const RUN_EVENTS = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];

export interface TaskPanelOptions {
  storage?: WorkflowStorage;
  cwd?: string;
}

function deliverText(run: ManagedRun): string {
  const r = run.result?.result as { report?: unknown } | undefined;
  const body =
    r && typeof r.report === "string" && r.report.trim() ? r.report : JSON.stringify(run.result?.result, null, 2);
  const tokens = run.result?.tokenUsage ? ` · ${run.result.tokenUsage.total.toLocaleString()} tokens` : "";
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  return `✓ Workflow "${run.snapshot.name}" finished (${agents} agents${tokens}).\n\n${body}`;
}

/**
 * Deliver a background run's result into the conversation when it completes or
 * fails. Set up once per extension; idempotent via an internal guard.
 */
export function installResultDelivery(pi: ExtensionAPI, manager: WorkflowManager): void {
  if ((manager as unknown as { __deliveryInstalled?: boolean }).__deliveryInstalled) return;
  (manager as unknown as { __deliveryInstalled?: boolean }).__deliveryInstalled = true;

  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    if (run?.background)
      void pi.sendMessage({ customType: "workflow-result", content: deliverText(run), display: true });
  });
  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    if (!manager.getRun(runId)?.background) return;
    void pi.sendMessage({
      customType: "workflow-result",
      content: `✗ Workflow ${runId} failed: ${error?.message ?? "unknown error"}`,
      display: true,
    });
  });
}

function renderPanel(manager: WorkflowManager, theme: Theme, focused: boolean): string[] {
  const active = manager.listRuns().filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const rows = active.map((r) => {
    const live = manager.getRun(r.runId);
    const agents = live?.snapshot.agents ?? r.agents;
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const phase = live?.snapshot.currentPhase ? ` · ${live.snapshot.currentPhase}` : "";
    return `  ${icon} ${r.workflowName}  ${done}/${agents.length} agents${phase}`;
  });
  const hint = focused
    ? theme.fg("accent", "  enter: open · esc: back")
    : theme.fg("dim", "  ↓ then enter, or /workflows, to open");
  return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint];
}

/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event; focus + enter opens the navigator.
 */
export function installTaskPanel(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: TaskPanelOptions = {},
): void {
  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      const onEvent = () => tui.requestRender();
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      const comp: Component & { focused?: boolean; dispose?(): void } = {
        focused: false,
        render: () => renderPanel(manager, theme, comp.focused ?? false),
        handleInput: (data: string) => {
          const key = parseKey(data);
          if (key === "enter" || key === "return" || key === "right") {
            void openWorkflowNavigator(pi, manager, ui, opts);
          }
        },
        invalidate: () => {},
        dispose: () => {
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
