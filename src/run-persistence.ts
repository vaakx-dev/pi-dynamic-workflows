/**
 * Workflow run state persistence for pause/resume support.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_RUNS_DIR } from "./config.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  status: RunStatus;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  /** Cached agent results for resume, keyed by deterministic call index. */
  journal?: Array<{ index: number; hash: string; result: unknown }>;
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export function createRunPersistence(cwd: string): RunPersistence {
  const runsDir = join(cwd, WORKFLOW_RUNS_DIR);

  const ensureDir = () => {
    if (!existsSync(runsDir)) {
      mkdirSync(runsDir, { recursive: true });
    }
  };

  const runPath = (runId: string) => join(runsDir, `${runId}.json`);

  return {
    save(state: PersistedRunState) {
      ensureDir();
      state.updatedAt = new Date().toISOString();
      writeFileSync(runPath(state.runId), JSON.stringify(state, null, 2));
    },

    load(runId: string): PersistedRunState | null {
      try {
        const path = runPath(runId);
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, "utf-8")) as PersistedRunState;
      } catch {
        return null;
      }
    },

    list(): PersistedRunState[] {
      ensureDir();
      try {
        const files = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
        const runs: PersistedRunState[] = [];
        for (const file of files) {
          try {
            const state = JSON.parse(readFileSync(join(runsDir, file), "utf-8")) as PersistedRunState;
            runs.push(state);
          } catch {
            // Skip corrupted files
          }
        }
        return runs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      } catch {
        return [];
      }
    },

    delete(runId: string): boolean {
      try {
        const path = runPath(runId);
        if (existsSync(path)) {
          const { unlinkSync } = require("node:fs");
          unlinkSync(path);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
