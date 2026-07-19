/** Safe, normalized telemetry for one workflow agent. This module deliberately
 * knows nothing about TUI layout or persistence. It is the only place that turns
 * SDK events into user-visible activity summaries. */

export type AgentActivityKind = "tool" | "model-response" | "waiting" | "error";

export interface NormalizedAgentActivity {
  kind: AgentActivityKind;
  summary: string;
  observedAt: string;
  active: boolean;
}

export interface AgentActivityEvent {
  type: string;
  [key: string]: unknown;
}

const MAX_SUMMARY = 96;
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i;
const TARGET_KEY = /^(path|file|filename|target|url|directory|dir|cwd|query)$/i;

export function boundedActivitySummary(value: string, max = MAX_SUMMARY): string {
  const clean = value
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

/** Return a target only when it is an obvious, non-secret location argument. */
export function safeToolTarget(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!TARGET_KEY.test(key) || SECRET_KEY.test(key) || typeof value !== "string") continue;
    const target = value.trim();
    if (!target || target.length > 300) continue;
    try {
      const url = new URL(target);
      if (url.username || url.password) return undefined;
      url.search = "";
      url.hash = "";
      return boundedActivitySummary(url.toString(), 72);
    } catch {
      return boundedActivitySummary(target.replace(/["'`]/g, ""), 72);
    }
  }
  return undefined;
}

export function summarizeTool(toolName: unknown, args?: unknown): string {
  const name = typeof toolName === "string" && toolName.trim() ? toolName.trim() : "tool";
  const target = safeToolTarget(args);
  return boundedActivitySummary(`tool ${name}${target ? ` · ${target}` : ""}`);
}

function observedAt(event: AgentActivityEvent, now = Date.now()): string {
  const candidate = event.timestamp;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? new Date(candidate).toISOString()
    : new Date(now).toISOString();
}

/** Adapt supported Pi SDK lifecycle events without copying streamed text or args. */
export function normalizeAgentActivity(
  event: AgentActivityEvent,
  now = Date.now(),
): NormalizedAgentActivity | undefined {
  const at = observedAt(event, now);
  switch (event.type) {
    case "tool_execution_start":
    case "tool_execution_update":
      return { kind: "tool", summary: summarizeTool(event.toolName, event.args), observedAt: at, active: true };
    case "tool_execution_end":
      if (event.isError) {
        return {
          kind: "error",
          summary: boundedActivitySummary(`tool ${String(event.toolName ?? "tool")} failed`),
          observedAt: at,
          active: false,
        };
      }
      return { kind: "tool", summary: summarizeTool(event.toolName), observedAt: at, active: false };
    case "message_start":
      return event.message &&
        typeof event.message === "object" &&
        (event.message as { role?: unknown }).role === "assistant"
        ? { kind: "model-response", summary: "model response", observedAt: at, active: true }
        : { kind: "waiting", summary: "waiting", observedAt: at, active: true };
    case "message_update":
      return { kind: "model-response", summary: "model response", observedAt: at, active: true };
    case "message_end":
      return { kind: "model-response", summary: "model response", observedAt: at, active: false };
    case "turn_start":
      return { kind: "waiting", summary: "waiting", observedAt: at, active: true };
    case "turn_end":
    case "agent_settled":
      return { kind: "waiting", summary: "waiting", observedAt: at, active: false };
    case "agent_end":
      return { kind: "waiting", summary: "waiting", observedAt: at, active: false };
    case "auto_retry_start":
      return { kind: "waiting", summary: "retrying", observedAt: at, active: true };
    case "auto_retry_end":
      return event.success
        ? { kind: "waiting", summary: "retry complete", observedAt: at, active: false }
        : { kind: "error", summary: "retry failed", observedAt: at, active: false };
    default:
      return undefined;
  }
}

export function safeHistoryEntry(entry: {
  role: string;
  kind: string;
  text: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}) {
  if (entry.kind === "toolCall") {
    return { ...entry, text: `tool ${entry.toolName ?? "tool"}` };
  }
  if (entry.role === "assistant" && entry.kind === "text") {
    return { ...entry, text: "model response" };
  }
  if (entry.kind === "toolResult") {
    return { ...entry, text: "tool result" };
  }
  return { ...entry, summary: undefined };
}

export function activityLabel(activity: NormalizedAgentActivity | undefined): string | undefined {
  if (!activity) return undefined;
  return activity.summary;
}

export function activityIsCurrent(activity: NormalizedAgentActivity | undefined, lifecycle: string): boolean {
  return lifecycle === "running" && Boolean(activity?.active);
}

export function formatActivity(activity: NormalizedAgentActivity | undefined, lifecycle: string): string | undefined {
  if (!activity) return undefined;
  return activityIsCurrent(activity, lifecycle) ? activity.summary : `last: ${activity.summary}`;
}
