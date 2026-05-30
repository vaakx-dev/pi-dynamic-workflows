/**
 * `/workflows` slash command: list, inspect, and control background workflow runs.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { renderWorkflowText } from "./display.js";
import type { PersistedRunState } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

const USAGE = "Usage: /workflows [list] | status <id> | stop <id> | pause <id> | resume <id> | rm <id>";

function summarizeRun(run: PersistedRunState): string {
  const icon = STATUS_ICON[run.status] ?? "?";
  const done = run.agents.filter((a) => a.status === "done").length;
  const total = run.agents.length;
  const tokens = run.tokenUsage ? ` · ${run.tokenUsage.total.toLocaleString()} tok` : "";
  return `${icon} ${run.runId}  ${run.workflowName} [${run.status}] ${done}/${total} agents${tokens}`;
}

function renderPersistedStatus(run: PersistedRunState): string {
  const lines = [`${STATUS_ICON[run.status] ?? "?"} ${run.workflowName} (${run.runId}) — ${run.status}`];
  if (run.currentPhase) lines.push(`  phase: ${run.currentPhase}`);
  for (const agent of run.agents) {
    const icon =
      agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : agent.status === "running" ? "◆" : "·";
    lines.push(`  ${icon} ${agent.label}`);
  }
  if (run.tokenUsage) lines.push(`  tokens: ${run.tokenUsage.total.toLocaleString()}`);
  if (run.durationMs) lines.push(`  duration: ${(run.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

/** Register the `/workflows` command against the shared manager. Idempotent. */
export function registerWorkflowCommands(pi: ExtensionAPI, manager: WorkflowManager): void {
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "workflows");
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }

  pi.registerCommand("workflows", {
    description: "List and control background workflow runs",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      const id = parts[1];
      const print = (text: string) => pi.sendMessage({ customType: "workflows", content: text, display: true });

      switch (sub) {
        case "list": {
          const runs = manager.listRuns();
          if (!runs.length) {
            await print("No workflow runs yet. Start one with a background workflow (background: true).");
            return;
          }
          await print(["Workflow runs:", ...runs.map(summarizeRun), "", USAGE].join("\n"));
          return;
        }
        case "status": {
          if (!id) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          const live = manager.getSnapshot(id);
          if (live) {
            await print(renderWorkflowText(live, false));
            return;
          }
          const run = manager.listRuns().find((r) => r.runId === id);
          if (!run) {
            ctx.ui.notify(`No workflow run "${id}"`, "error");
            return;
          }
          await print(renderPersistedStatus(run));
          return;
        }
        case "stop": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(
            manager.stop(id) ? `Stopped ${id}` : `Cannot stop ${id} (not running)`,
            manager.getRun(id) ? "info" : "warning",
          );
          return;
        }
        case "pause": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.pause(id) ? `Paused ${id}` : `Cannot pause ${id} (not running)`, "info");
          return;
        }
        case "resume": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          const ok = await manager.resume(id);
          ctx.ui.notify(ok ? `Resumed ${id}` : `Resume not available for ${id} yet`, ok ? "info" : "warning");
          return;
        }
        case "rm": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.deleteRun(id) ? `Removed ${id}` : `No run ${id}`, "info");
          return;
        }
        default:
          ctx.ui.notify(`Unknown subcommand "${sub}". ${USAGE}`, "warning");
      }
    },
  });
}
