import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type EffortState, effortDirective, isSubstantive } from "./effort-command.js";
import { loadWorkflowSettings, saveWorkflowSettings, type WorkflowSettingsStore } from "./workflow-settings.js";

/** Additional guidance used when standing effort mode auto-arms a turn. */
export const EFFORT_CONVERSATIONAL_ESCAPE =
  "This turn was armed by standing effort mode, not by an explicit workflow request: if it is conversational or trivial, skip the workflow and just respond directly.";

const BACKGROUND_DELIVERY_REASSURANCE =
  "If you do call `workflow`, it runs in the background by default: this turn will end and the result is delivered back into the conversation automatically when it finishes — that's expected, not a stall, so you do not need to stay and block. Only pass background:false if the user is waiting for the result inline in this same turn.";

/**
 * Build the directive used by standing effort mode. Effort is an explicit,
 * session-level opt-in and is independent of the words in the user's message.
 */
export function buildEffortWorkflowPrompt(text: string, extraDirective?: string): string {
  const lines = [
    text,
    "",
    "---",
    "[workflows mode armed by standing effort mode. Decide first: if this message is a question, a trivial task, or",
    "just talk about workflows, this repo, or the tool itself, answer it directly and stay conversational. If it is a",
    "real, decomposable request to do work, handle it by calling the `workflow` tool: write a script that fans the task",
    "out across subagents via agent()/parallel()/pipeline().",
    `${BACKGROUND_DELIVERY_REASSURANCE}]`,
  ];
  if (extraDirective) lines.push("", extraDirective);
  return lines.join("\n");
}

/**
 * The directive for the explicit `/workflows run <prompt>` command. Unlike
 * effort mode, this is a maximal-intent command and directs the model to run
 * the workflow immediately.
 */
export function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string {
  const lines = [
    text,
    "",
    "---",
    "[/workflows run — you ran an explicit command to execute a workflow for this request.",
    "Call the `workflow` tool now: write a script that fans this task out across subagents",
    "via agent()/parallel()/pipeline(). (This is a direct command, not a heuristic guess, so",
    "do not answer in prose instead of running the workflow.)",
    `${BACKGROUND_DELIVERY_REASSURANCE}]`,
  ];
  if (extraDirective) lines.push("", extraDirective);
  return lines.join("\n");
}

/** The exact name of the workflow tool. */
export const WORKFLOW_TOOL_NAME = "workflow";

export interface InstallWorkflowInputOptions {
  settingsStore?: WorkflowSettingsStore;
}

/**
 * Install the input hook used by standing effort mode and the progress command.
 * Ordinary input is returned unchanged. The hook never inspects message words.
 */
export function installWorkflowInputHandling(
  pi: ExtensionAPI,
  effort?: EffortState,
  options: InstallWorkflowInputOptions = {},
): void {
  const settingsStore = options.settingsStore ?? DEFAULT_SETTINGS_STORE;
  registerWorkflowProgressCommands(pi, settingsStore);

  let savedTools: string[] | undefined;
  pi.on("input", (event: { source?: string; text?: string }) => {
    if (event.source !== "interactive" || !event.text) return { action: "continue" } as const;

    const byEffort = !!effort && effort.level !== "off" && isSubstantive(event.text);
    if (!byEffort) return { action: "continue" } as const;

    try {
      if (savedTools === undefined) {
        savedTools = pi.getActiveTools?.() ?? [];
        const current = [...savedTools];
        if (!current.includes(WORKFLOW_TOOL_NAME)) current.push(WORKFLOW_TOOL_NAME);
        pi.setActiveTools?.(current);
      }
    } catch {
      // Tool activation is best-effort; the effort directive remains useful.
    }

    const extra = effort
      ? [effortDirective(effort.level), EFFORT_CONVERSATIONAL_ESCAPE].filter(Boolean).join(" ")
      : undefined;
    return { action: "transform", text: buildEffortWorkflowPrompt(event.text, extra) } as const;
  });

  pi.on("turn_end", () => {
    if (savedTools === undefined) return;
    const restore = savedTools;
    savedTools = undefined;
    try {
      pi.setActiveTools?.(restore);
    } catch {
      // Ignore host failures while restoring the tool set.
    }
  });
}

/** Register the bottom progress-panel preference command. */
export function registerWorkflowProgressCommands(
  pi: ExtensionAPI,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-progress", {
    description: "Bottom workflow telemetry panel: compact | detailed | status | max <N>",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const trimmed = args.trim();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      const spaceIdx = trimmed.indexOf(" ");
      const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (verb === "compact" || verb === "detailed") {
        const saved = persistProgressSettings(settingsStore, { progressPanelMode: verb });
        await say(
          saved
            ? `Workflow progress panel set to ${verb} — takes effect on the next render of a live run (no restart needed).`
            : `Workflow progress panel set to ${verb} for this session, but the preference could not be saved.`,
        );
        return;
      }

      if (verb === "max") {
        if (!rest) {
          await say(
            `Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress max <1-1000>`,
          );
          return;
        }
        const n = Number.parseInt(rest, 10);
        if (!Number.isFinite(n) || n < 1) {
          await say(`Invalid value "${rest}". Usage: /workflows-progress max <1-1000> (a whole number ≥ 1).`);
          return;
        }
        const clamped = Math.min(1000, n);
        const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
        await say(
          saved
            ? `Detailed progress now shows up to ${clamped} agents per phase.`
            : `Set to ${clamped} for this session, but the preference could not be saved.`,
        );
        return;
      }

      await say(
        `Workflow progress panel is ${loadProgressMode(settingsStore)} (active telemetry by default), showing up to ${loadProgressMaxAgents(settingsStore)} completed agents per phase in detailed mode. Usage: /workflows-progress compact | detailed | status | max <N>`,
      );
    },
  });
}

const DEFAULT_SETTINGS_STORE: WorkflowSettingsStore = {
  load: loadWorkflowSettings,
  save: saveWorkflowSettings,
};

function persistProgressSettings(
  settingsStore: WorkflowSettingsStore,
  settings: Parameters<WorkflowSettingsStore["save"]>[0],
): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function loadProgressMode(settingsStore: WorkflowSettingsStore): "compact" | "detailed" {
  try {
    return settingsStore.load().progressPanelMode ?? "compact";
  } catch {
    return "compact";
  }
}

function loadProgressMaxAgents(settingsStore: WorkflowSettingsStore): number {
  try {
    return settingsStore.load().progressPanelMaxAgents ?? 8;
  } catch {
    return 8;
  }
}
