import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { AgentUsage } from "./agent.js";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  loadAgentRegistry,
  resolveAgentType,
  snapshotAgentRegistry,
} from "./agent-registry.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { createAgentStoreTools, SharedStore } from "./shared-store.js";
import type { NormalizedAgentActivity } from "./workflow-telemetry.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

/**
 * Batch-scoped cancellation for a single parallel()/pipeline() fan-out. When a
 * fan-out's agent() calls reserve past maxAgents, the breaching call throws and
 * the whole fan-out rejects — but agents already reserved and queued behind the
 * limiter would otherwise keep draining and spending. parallel()/pipeline()
 * establish a fresh store per call via fanoutScope.run(); agent() captures the
 * nearest enclosing store synchronously (before suspending on the limiter) so a
 * still-queued agent can bail once ITS OWN fan-out breaches, without touching
 * sibling fan-outs running concurrently or an enclosing fan-out when this one is
 * nested inside it (each nesting level gets its own store via ALS scoping).
 *
 * Scope note: cancellation is bounded PER breaching fan-out, not run-global — a
 * deliberate tradeoff. Deep-sixing the earlier run-global flag was required
 * because it wrongly cancelled an innocent, independently-caught sibling batch.
 * The consequence: if one fan-out breaches while an unrelated in-cap sibling or
 * a nested inner fan-out is mid-flight, that other batch is NOT cancelled and
 * finishes its already-reserved agents (still capped at maxAgents total). Only
 * the breaching fan-out's own queue is short-circuited.
 */
const fanoutScope = new AsyncLocalStorage<{ cancelled: boolean }>();

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
}

/** One cached agent() result, keyed by its deterministic call index. */
export interface JournalEntry {
  index: number;
  /** sha256 of the role, definition, model, tools, task, phase, override, and schema identity. */
  hash: string;
  result: unknown;
  /** Resolved runtime provenance retained when this entry is replayed. */
  runtime?: { resolvedModel?: string; reasoning?: string; tools: string[] };
  /**
   * Per-agent write delta (keys set by this agent) for additive replay on resume.
   * Replaces the former full-map snapshot to fix parallel-agent ordering: applying
   * deltas in callSeq order accumulates all agents' writes correctly regardless of
   * which agent finished first. Absent on older journal entries.
   */
  storeDelta?: Record<string, unknown>;
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  depth: number;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to the nearest ancestor `.pi/agents` directory
   * overriding `~/.pi/agent/agents`. Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /** Resume: cached agent results keyed by deterministic call index. */
  resumeJournal?: Map<number, JournalEntry>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /**
   * Shared store for this run. One instance is created per top-level run and
   * propagated into nested workflow() calls. Pass an existing instance to share
   * state across a parent and child run; omit to create a fresh isolated store.
   */
  sharedStore?: SharedStore;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
   * default (and journals it), so a detached/background run never hangs.
   */
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentQueued?: (event: {
    callId: string;
    callIndex: number;
    label: string;
    phase?: string;
    prompt: string;
    model?: string;
    agentType: string;
    source: "project" | "user";
    path: string;
    fingerprint: string;
    requestedModel?: string;
    resolvedModel?: string;
    reasoning?: string;
    tools?: string[];
    explicitModelOverride: boolean;
  }) => void;
  onAgentStart?: (event: {
    callId: string;
    callIndex: number;
    attempt: number;
    label: string;
    phase?: string;
    prompt: string;
    model?: string;
    agentType: string;
  }) => void;
  onAgentResolved?: (event: {
    callId: string;
    callIndex: number;
    resolvedModel?: string;
    reasoning?: string;
    tools: string[];
  }) => void;
  onAgentAttempt?: (event: {
    callId: string;
    callIndex: number;
    attempt: number;
    label: string;
    phase?: string;
  }) => void;
  onAgentActivity?: (event: {
    callId: string;
    callIndex: number;
    label: string;
    activity: NormalizedAgentActivity;
  }) => void;
  onAgentEnd?: (event: {
    callId: string;
    callIndex: number;
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    tokenUsage?: AgentUsage;
    worktree?: string;
    model?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    attempt?: number;
    cached?: boolean;
    skipped?: boolean;
  }) => void;
  onAgentHistory?: (event: { label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * The workflow author chooses per-agent models per the routing policy in the
   * tool guidelines (e.g. a lighter model for exploration, the main model for
   * analysis). When omitted, the session's main model is used.
   */
  model?: string;
  isolation?: "worktree";
  /**
   * Required name of a registered subagent definition. The nearest ancestor
   * `.pi/agents` definition overrides the same name in `~/.pi/agent/agents`.
   * An explicit `model` overrides the definition model. Unknown names fail
   * before a subagent session or model call starts.
   */
  agentType: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
}

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
}

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  // Snapshot definitions once at run start. Nested workflows receive this same
  // snapshot, so filesystem edits and injected registry mutations are invisible
  // until a later top-level run or resume.
  const agentRegistry = snapshotAgentRegistry(options.agentRegistry ?? loadAgentRegistry(baseCwd));

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  // Global caps + budget are shared with any nested workflow() so they hold across nesting.
  const shared: SharedRuntime = options.sharedRuntime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
  };
  const limiter = shared.limiter;

  // One store instance per run; nested workflow() calls inherit the parent's store
  // so all agents across nesting levels share the same key-value space.
  const store: SharedStore = options.sharedStore ?? new SharedStore();

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  const agentLimitError = () =>
    new WorkflowError(
      `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
      WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
      { recoverable: false },
    );

  const throwIfAborted = () => {
    if (options.signal?.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const agent = async (prompt: string, agentOptions: AgentOptions = {} as AgentOptions) => {
    throwIfAborted();

    // Capture the enclosing parallel()/pipeline() fan-out's cancellation batch
    // (if any) synchronously, while the ALS context of the caller is still
    // active — i.e. before suspending on the limiter below. The limiter body
    // closes over this so a still-queued agent can bail once its OWN fan-out
    // breaches the cap, without affecting sibling or outer fan-outs.
    const batch = fanoutScope.getStore();

    // Check agent limit. A fan-out that overshoots the cap has already reserved
    // and queued up to `maxAgents` agents; the breaching call throws here, and
    // parallel()/pipeline() mark their own batch cancelled so the already-queued
    // agents short-circuit before their real API call (see the limiter body).
    if (shared.agentCount >= maxAgents) {
      throw agentLimitError();
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }

    const assignedPhase = agentOptions.phase ?? state.currentPhase;

    // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
    // without touching the run's overall budget. Soft (spent accrues post-agent),
    // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
    // work so later phases still proceed.
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }

    const requestedLabel = agentOptions.label?.trim();

    const configurationError = (message: string) =>
      new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
    const rawAgentOptions = agentOptions as AgentOptions & { agent?: unknown; tier?: unknown };
    if (rawAgentOptions.agent !== undefined) {
      throw configurationError('agent() option "agent" is unsupported; migrate it to "agentType"');
    }
    if (rawAgentOptions.tier !== undefined) {
      throw configurationError('agent() option "tier" is unsupported; migrate model routing to "agentType"');
    }
    if (typeof agentOptions.agentType !== "string" || !agentOptions.agentType.trim()) {
      throw configurationError("agent() requires opts.agentType naming a registered agent definition");
    }

    // Strict role resolution happens before any queue event, session creation,
    // model resolution, or provider call.
    const agentType = agentOptions.agentType.trim();
    let agentDef: AgentDefinition;
    try {
      agentDef = resolveAgentType(agentType, agentRegistry);
    } catch (error) {
      throw configurationError(error instanceof Error ? error.message : String(error));
    }
    const modelSpec = agentOptions.model ?? agentDef.model;
    const explicitModelOverride = agentOptions.model !== undefined;
    const definitionTools = agentDef.tools ? [...agentDef.tools] : undefined;
    const runtimeToolNames = options.tools?.map((tool) => tool.name);
    let displayModel = modelSpec ?? options.mainModel;

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const callIndex = state.callSeq++;
    const callHash = hashAgentCall({
      task: prompt,
      phase: assignedPhase,
      agentType,
      fingerprint: agentDef.fingerprint,
      model: modelSpec ?? options.mainModel,
      reasoning: options.mainReasoning,
      tools: { definition: definitionTools ?? null, runtime: runtimeToolNames ?? null },
      explicitModelOverride: agentOptions.model ?? null,
      schema: agentOptions.schema ?? null,
    });
    // Store delta key: callIndex alone is NOT run-unique. A nested workflow()
    // call (see workflowFn below) shares this run's SharedStore instance but
    // restarts its own callSeq at 0, so a parent agent and a concurrently
    // running nested-run agent can both get callIndex 0 and collide in
    // SharedStore.agentDeltas — whichever commits last steals/overwrites the
    // other's journaled delta. Composing the run's own runId (unique per
    // top-level run AND per nested run, see `${runId}-nested${shared.depth}`
    // below) with callIndex makes the key unique across the whole store.
    const deltaKey = `${runId}:${callIndex}`;
    const callId = `${runId}:agent:${callIndex}`;

    // Reserve the agent slot synchronously — atomic with the limit/budget gate
    // above (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
    // spent accrues after each agent, matching Claude Code; in-flight agents may
    // push slightly past total, then further agent() calls throw.)
    shared.agentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);
    const queuedEvent = {
      callId,
      callIndex,
      label,
      phase: assignedPhase,
      prompt,
      model: displayModel,
      agentType,
      source: agentDef.source,
      path: agentDef.path,
      fingerprint: agentDef.fingerprint,
      requestedModel: modelSpec,
      resolvedModel: undefined,
      reasoning: options.mainReasoning,
      tools: definitionTools,
      explicitModelOverride,
    };
    options.onAgentQueued?.(queuedEvent);

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    const cached = options.resumeJournal?.get(callIndex);
    const hashMatches = cached != null && cached.hash === callHash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    if (hashMatches && !cachedEmptyOutput && callIndex < state.firstMiss) {
      if (cached.runtime) {
        displayModel = cached.runtime.resolvedModel ?? displayModel;
        options.onAgentResolved?.({ callId, callIndex, ...cached.runtime });
      }
      options.onAgentEnd?.({
        ...queuedEvent,
        result: cached.result,
        model: displayModel,
        cached: true,
        attempt: 0,
      });
      // Apply this agent's write delta so live agents later in the run see a
      // consistent store. Additive apply preserves parallel-agent writes that
      // came from higher-callIndex agents finishing before this one.
      if (cached.storeDelta) store.applyDelta(cached.storeDelta);
      return cached.result;
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);

    return limiter(async () => {
      const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
      const retryAttempts = normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0);
      const maxAttempts = retryAttempts + 1;

      options.onAgentStart?.({ ...queuedEvent, attempt: 1 });

      // Optional per-call worktree isolation (deterministic name -> stable resume keys).
      let worktree: Worktree | undefined;
      const resolvedIsolation = agentOptions.isolation ?? undefined;
      if (resolvedIsolation === "worktree") {
        worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
        if (!worktree.isolated) log(`isolation ignored for "${label}" (${worktree.reason})`);
      }
      const runCwd = worktree?.isolated ? worktree.cwd : undefined;

      // Captured from the subagent's real session usage; falls back to an
      // estimate when the provider reports no usage (total === 0). Usage is reset
      // per retry attempt so a failed attempt does not double-count the next one.
      let usage: AgentUsage | undefined;
      let runtime: JournalEntry["runtime"];
      const recordTokens = (result: unknown): number => {
        const tokens = usage && usage.total > 0 ? usage.total : estimateTokens(result) + estimateTokens(prompt);
        if (usage) {
          shared.tokenUsage.input += usage.input;
          shared.tokenUsage.output += usage.output;
          shared.tokenUsage.cost += usage.cost;
          shared.tokenUsage.cacheRead += usage.cacheRead;
          shared.tokenUsage.cacheWrite += usage.cacheWrite;
        }
        shared.tokenUsage.total += tokens;
        shared.spent += tokens;
        return tokens;
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          usage = undefined;
          try {
            options.onAgentAttempt?.({ callId, callIndex, attempt, label, phase: assignedPhase });
            if (attempt > 1) {
              options.onAgentActivity?.({
                callId,
                callIndex,
                label,
                activity: {
                  kind: "waiting",
                  summary: "retrying",
                  observedAt: new Date().toISOString(),
                  active: true,
                },
              });
            }
            throwIfAborted();
            // This agent's own fan-out already breached maxAgents while this
            // call sat queued behind the limiter; bail before spending on the
            // real API call instead of draining the whole reserved queue.
            if (batch?.cancelled) throw agentLimitError();

            // Run agent with timeout
            const result = await withTimeout(
              agentRunner.run(prompt, {
                label,
                // Identifiable name for persisted sessions (persistAgentSessions).
                sessionName: `workflow:${runId} ${label}`,
                schema: agentOptions.schema,
                signal: options.signal,
                instructions: buildAgentInstructions(assignedPhase, agentDef, resolvedIsolation),
                model: modelSpec,
                modelRegistry: options.modelRegistry,
                toolNames: agentDef.tools,
                // Per-agent store tools track this agent's writes by the
                // run-unique deltaKey so the delta can be journaled and replayed
                // correctly on resume, even when a nested workflow() run shares
                // this store concurrently with the parent run.
                systemTools: createAgentStoreTools(store, deltaKey),
                cwd: runCwd,
                onModelResolved: (id: string) => {
                  displayModel = id;
                },
                onRuntimeResolved: (resolution) => {
                  displayModel = resolution.model ?? displayModel;
                  runtime = {
                    resolvedModel: resolution.model,
                    reasoning: resolution.reasoning,
                    tools: [...resolution.tools],
                  };
                  options.onAgentResolved?.({ callId, callIndex, ...runtime });
                },
                onModelFallback: (spec: string) => {
                  // Make the silent degrade visible in /workflows, not just console.
                  log(`${label}: model "${spec}" unavailable — using the session default`);
                },
                onUsage: (u: AgentUsage) => {
                  usage = u;
                },
                onHistory: (history: AgentHistoryEntry[]) => {
                  options.onAgentHistory?.({ label, phase: assignedPhase, history });
                },
                onActivity: (activity: NormalizedAgentActivity) => {
                  options.onAgentActivity?.({ callId, callIndex, label, activity });
                },
              }),
              timeout,
              label,
            );

            throwIfAborted();
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            const tokens = recordTokens(result);
            options.onAgentJournal?.({
              index: callIndex,
              hash: callHash,
              result,
              runtime,
              storeDelta: store.commitDelta(deltaKey),
            });
            options.onAgentEnd?.({
              callId,
              callIndex,
              label,
              phase: assignedPhase,
              result,
              tokens,
              tokenUsage: usage,
              worktree: runCwd,
              model: displayModel,
            });
            return result;
          } catch (error) {
            if (options.signal?.aborted) throw error;

            const workflowError = wrapError(error, { agentLabel: label });
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            const tokens = recordTokens(null);

            if (workflowError.recoverable && attempt < maxAttempts) {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              continue;
            }

            options.onAgentEnd?.({
              callId,
              callIndex,
              label,
              phase: assignedPhase,
              result: null,
              tokens,
              tokenUsage: usage,
              worktree: runCwd,
              model: displayModel,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
              attempt,
            });

            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              return null;
            }
            throw workflowError;
          }
        }
        return null;
      } finally {
        // Always tear down the worktree, even on timeout/abort.
        if (worktree?.isolated) await removeWorktree(worktree);
      }
    });
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    // Batch-scoped cancellation: agent() calls made (directly or transitively)
    // from these thunks see this store via fanoutScope.getStore(). A breach in
    // THIS fan-out flips `cancelled` so its own still-queued agents bail, without
    // touching a sibling fan-out running concurrently or an enclosing one.
    const batch = { cancelled: false };
    return fanoutScope.run(batch, () =>
      Promise.all(
        thunks.map(async (thunk, index) => {
          try {
            return await thunk();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures (token budget / agent limit exhausted) must
            // halt the whole run, exactly like a directly-awaited agent() — not be
            // swallowed into a null in the result array.
            if (!workflowError.recoverable) {
              // Only a breached agent cap cancels the rest of this batch; the
              // token budget stays a soft gate by design (in-flight agents may
              // finish past it), and other non-recoverable errors don't imply
              // the rest of the batch is doomed.
              if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
              throw workflowError;
            }
            log(`parallel[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }),
      ),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    // Batch-scoped cancellation — see parallel() for the rationale.
    const batch = { cancelled: false };
    return fanoutScope.run(batch, () =>
      Promise.all(
        items.map(async (item, index) => {
          let value: unknown = item;
          for (const stage of stages) {
            try {
              throwIfAborted();
              value = await stage(value, item, index);
              throwIfAborted();
            } catch (error) {
              if (options.signal?.aborted) throw error;
              const workflowError = wrapError(error);
              // Non-recoverable failures halt the whole run (see parallel()).
              if (!workflowError.recoverable) {
                if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
                throw workflowError;
              }
              log(`pipeline[${index}] failed: ${workflowError.message}`);
              return null;
            }
          }
          return value;
        }),
      ),
    );
  };

  // Nested workflow(): run a saved workflow (or a raw script) inline, sharing this
  // run's limiter/counters/budget so the global caps hold. One level deep only.
  const workflowFn = async (nameOrScript: string, childArgs?: unknown) => {
    throwIfAborted();
    if (shared.depth >= 1) {
      throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    shared.depth++;
    try {
      const child = await runWorkflow(childScript, {
        ...options,
        args: childArgs,
        sharedRuntime: shared,
        agentRegistry,
        // Propagate the parent's store so nested agents share the same key-value space.
        sharedStore: store,
        // A nested run is its own script; never reuse the parent's resume journal.
        resumeJournal: undefined,
        resumeFromRunId: undefined,
        runId: `${runId}-nested${shared.depth}`,
        persistLogs: false,
      });
      return child.result;
    } finally {
      shared.depth--;
    }
  };

  // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
  // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
  // Injected as globals so workflow scripts compose them directly. ──

  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_v, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { agentType: "reviewer", label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return { real: votes.length > 0 && realCount / votes.length >= threshold, realCount, total: votes.length, votes };
  };

  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallel(
              Array.from(
                { length: judges },
                (_v, j) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      agentType: "reviewer",
                      label: `judge ${idx + 1}.${j + 1}`,
                      schema: JUDGE_SCHEMA,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    return best;
  };

  const loopUntilDry = async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
    const maxRounds = opts.maxRounds ?? 50;
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result, don't abort.
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) break;
        throw error;
      }
      const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return all;
  };

  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };
  const completenessCheck = (taskArgs: unknown, results: unknown) =>
    agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { agentType: "reviewer", label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
  // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      if (!opts.until || opts.until(last)) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      const verdict = await validator(last);
      if (verdict?.ok) return { ok: true, value: last, attempts: i + 1 };
      feedback = verdict?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, attempts };
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
    if (shared.agentCount >= maxAgents) {
      throw agentLimitError();
    }
    const callIndex = state.callSeq++;
    const callHash = hashCheckpoint(promptText, checkpointOptions);
    const cached = options.resumeJournal?.get(callIndex);
    if (cached != null && cached.hash === callHash && callIndex < state.firstMiss) {
      shared.agentCount++;
      return cached.result; // replay the journaled human reply
    }
    if (cached == null || cached.hash !== callHash) state.firstMiss = Math.min(state.firstMiss, callIndex);
    shared.agentCount++;

    let reply: unknown;
    if (options.confirm) {
      reply = await options.confirm(promptText, checkpointOptions);
    } else if (checkpointOptions.headless === "abort") {
      throw new WorkflowError(
        `checkpoint "${promptText}" needs human input but none is available (headless run)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
    } else {
      reply = checkpointOptions.default ?? true;
    }
    throwIfAborted();
    options.onAgentJournal?.({ index: callIndex, hash: callHash, result: reply });
    return reply;
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    workflow: workflowFn,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  try {
    const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);

    // Persist logs
    const logFile = logger.persist();
    if (logFile) {
      log(`Logs persisted to ${logFile}`);
    }

    // Emit final token usage
    options.onTokenUsage?.(shared.tokenUsage);

    return {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: shared.agentCount,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: shared.tokenUsage,
    };
  } finally {
    // Dispose the store only when this run created it; nested runs inherit the
    // parent's store and must not tear it down while the parent is still running.
    if (!options.sharedStore) store.dispose();
  }
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);
  validateAgentRouting(ast);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function routingMigrationError(location: string): Error {
  return new Error(`${location} model routing is unsupported; migrate each agent() call to opts.agentType`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const raw = meta as Record<string, unknown>;
  if ("model" in raw) throw routingMigrationError("meta.model");
  const customFields = Object.keys(raw).filter((field) => !["name", "description", "phases"].includes(field));
  if (customFields.length) throw new Error(`unsupported meta field: ${customFields.join(", ")}`);

  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof phase.title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
      const rawPhase = phase as unknown as Record<string, unknown>;
      if ("model" in rawPhase) throw routingMigrationError("meta.phases[].model");
      const customPhaseFields = Object.keys(rawPhase).filter((field) => !["title", "detail"].includes(field));
      if (customPhaseFields.length) throw new Error(`unsupported meta phase field: ${customPhaseFields.join(", ")}`);
      if (phase.detail !== undefined && typeof phase.detail !== "string") {
        throw new Error("meta phase detail must be a string");
      }
    }
  }
}

function validateAgentRouting(ast: AnyNode): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as AnyNode;
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "agent") {
      const options = node.arguments?.[1] as AnyNode | undefined;
      if (options?.type === "ObjectExpression") {
        for (const property of options.properties as AnyNode[]) {
          if (property.type !== "Property" || property.computed) continue;
          const key = propertyKey(property.key as AnyNode, "agent options");
          if (key === "tier") throw routingMigrationError("opts.tier");
          if (key === "agent") throw new Error("opts.agent is unsupported; migrate it to opts.agentType");
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "parent") visit(child);
    }
  };
  visit(ast);
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

interface AgentCallIdentity {
  agentType: string;
  fingerprint: string;
  model?: string;
  reasoning?: string;
  tools: { definition: string[] | null; runtime: string[] | null };
  task: string;
  phase?: string;
  explicitModelOverride: string | null;
  schema: TSchema | null;
}

function hashAgentCall(identity: AgentCallIdentity): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function buildAgentInstructions(
  phase: string | undefined,
  def: AgentDefinition,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  if (def.body) lines.push(def.body);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/**
 * Run a promise with a timeout.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number | null, label: string): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
