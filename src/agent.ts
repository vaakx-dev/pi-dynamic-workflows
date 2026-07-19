import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { type AgentHistoryEntry, compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { canonicalModelSpec, resolveModelSpecWithThinking } from "./model-spec.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";
import {
  type AgentActivityEvent,
  type NormalizedAgentActivity,
  normalizeAgentActivity,
  safeHistoryEntry,
} from "./workflow-telemetry.js";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string },
  lastText: (messages: unknown[]) => string,
): Promise<T> {
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit the provider limit. Surface that as the real
  // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
  throwIfProviderLimit(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/** Return an explicit model override, or undefined to use the session default. */
export function resolveAgentModelSpec(options: { model?: string }): string | undefined {
  return options.model;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, modelRuntime, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /** The active Pi session model (`provider/modelId`), used when no call or definition model is set. */
  mainModel?: string;
  /** The active Pi session reasoning level, inherited unless a model spec has an explicit suffix. */
  mainReasoning?: CreateAgentSessionOptions["thinkingLevel"];
  /**
   * Shared model registry from the host Pi session. When provided, subagents
   * resolve model specs against the same registry the main session uses,
   * including dynamically-registered providers such as ollama-cloud. Without
   * this, the agent builds an isolated registry from disk and may miss models
   * that are only available via extension registration.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory (keyed by the runner's project cwd), instead
   * of the default in-memory session that is discarded when the run ends.
   * Default: false (current behavior).
   */
  persistAgentSessions?: boolean;
}

// pi >= 0.80.8: ModelRegistry is a sync facade over an async-created ModelRuntime
// (AuthStorage/ModelRegistry.create are gone). The disk-backed fallback is built
// lazily; sync callers see [] until it resolves and real specs on later reads.
let fallbackRuntimePromise: Promise<ModelRuntime> | undefined;
let fallbackRegistry: ModelRegistry | undefined;

function ensureFallbackRegistry(): Promise<ModelRegistry> {
  if (!fallbackRuntimePromise) {
    const dir = getAgentDir();
    // Same auth.json/models.json createAgentSession uses by default, so a model
    // resolved here carries valid credentials.
    fallbackRuntimePromise = (async () => {
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
      });
      // Warm the availability snapshot so the facade's sync getAvailable() is
      // populated immediately after this promise resolves.
      await runtime.getAvailable().catch(() => {});
      return runtime;
    })();
    // Don't cache a rejection: a transient failure (e.g. auth.json lock) would
    // otherwise wedge the fallback for the rest of the process.
    fallbackRuntimePromise.catch(() => {
      fallbackRuntimePromise = undefined;
    });
  }
  return fallbackRuntimePromise.then((runtime) => {
    fallbackRegistry ??= new ModelRegistry(runtime);
    return fallbackRegistry;
  });
}

let warnedNoRuntime = false;

/**
 * The ModelRuntime behind a registry facade. pi's ModelRegistry does not expose
 * its runtime publicly, so reach into the private field (stable since 0.80.8);
 * subagent sessions need it to share the host session's exact catalog and auth
 * (createAgentSession takes modelRuntime, not a registry, since 0.80.8).
 *
 * Exported so the test suite can pin this pi-internals contract: the cast means
 * neither tsc nor mock-based tests would notice pi renaming the field, and the
 * runtime consequence is silent (subagents fall back to a default runtime and
 * extension-registered providers vanish from routing).
 */
export function runtimeOf(registry: ModelRegistry): ModelRuntime | undefined {
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime && !warnedNoRuntime) {
    warnedNoRuntime = true;
    console.warn(
      "[workflow] ModelRegistry no longer carries a private `runtime` field (pi internals changed); subagents fall back to a default-built runtime and may miss extension-registered providers",
    );
  }
  return runtime;
}

/**
 * List the user's currently available models (those with auth configured) with
 * the model fields needed here: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built (or while the disk-backed fallback is still initializing).
 */
export function listAvailableModels(
  registry?: ModelRegistry,
): Array<{ spec: string; costOutput?: number; contextWindow?: number }> {
  try {
    const modelRegistry = registry ?? fallbackRegistry;
    if (!modelRegistry) {
      // Kick off the async fallback build; this call reports [] and later
      // calls (e.g. the tool's lazy promptGuidelines re-reads) see real specs.
      void ensureFallbackRegistry().catch(() => {});
      return [];
    }
    return modelRegistry.getAvailable().map((model) => ({
      spec: canonicalModelSpec(model),
      costOutput: model.cost?.output,
      contextWindow: model.contextWindow,
    }));
  } catch {
    return [];
  }
}

/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry?: ModelRegistry): string[] {
  return listAvailableModels(registry).map((model) => model.spec);
}

/**
 * Emitted at most once per process when persistAgentSessions is enabled and a
 * session is actually persisted: full subagent transcripts (which may include
 * secrets or other sensitive context) are being written to disk. Surface the
 * privacy trade-off at run time, not only in the docs.
 */
let warnedPersistSecrets = false;
function warnPersistSecretsOnce(sessionDir: string): void {
  if (warnedPersistSecrets) return;
  warnedPersistSecrets = true;
  console.warn(
    `[workflow] persistAgentSessions is ON: full subagent transcripts (which may include secrets or other sensitive context) are being written to disk under ${sessionDir}. Disable persistAgentSessions if that isn't intended.`,
  );
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export function usageFromStats(stats: {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}): AgentUsage | undefined {
  const { tokens, cost } = stats;
  if (tokens.total <= 0 && cost <= 0) return undefined;
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    total: tokens.total,
    cost,
  };
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  /**
   * Display name recorded on the persisted session (session_info entry) when
   * `persistAgentSessions` is enabled, so transcripts are identifiable in
   * session pickers (e.g. `workflow:<runId> <label>`). Ignored for in-memory
   * sessions or when an explicit session.sessionManager override is injected.
   */
  sessionName?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost — but NOT when the provider reported no usage at all
   * (all-zero stats), so consumers keep their scalar fallback.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`. When it can't be resolved, the session default is used and
   * a warning is logged. When omitted, the session default applies.
   */
  model?: string;
  /** Called with the resolved canonical model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** Called once the session has resolved its canonical model, reasoning level, and active tools. */
  onRuntimeResolved?: (resolution: {
    model?: string;
    reasoning?: CreateAgentSessionOptions["thinkingLevel"];
    tools: string[];
  }) => void;
  /** Called when `model` couldn't be resolved and the active Pi session model was used. */
  onModelFallback?: (requestedSpec: string) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Safe normalized SDK activity; streamed text and complete arguments never leave this class. */
  onActivity?: (activity: NormalizedAgentActivity) => void;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * Restrict the subagent's coding tools to these names (a named agent
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts (tools restricted to
   * structured_output) before falling back to strict prose extraction. Default 2.
   */
  maxSchemaRetries?: number;
  /**
   * Tools that are always injected AFTER the tool allowlist (`toolNames`), so they are available even under a restrictive
   * allowlist. Used by the workflow runtime to inject shared-store tools into
   * every named agent definition.
   */
  systemTools?: ToolDefinition[];
  /**
   * Per-run model registry override. Takes precedence over the constructor's
   * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for both model
   * resolution and the `createAgentSession` call this run makes. Falls back to
   * the constructor's shared registry, then a lazily-built disk registry, when
   * omitted.
   */
  modelRegistry?: ModelRegistry;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly persistAgentSessions: boolean;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  private readonly mainReasoning?: CreateAgentSessionOptions["thinkingLevel"];
  /** Shared registry from the host session, when provided. */
  private readonly sharedRegistry?: ModelRegistry;
  /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
  private registry?: ModelRegistry;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.mainReasoning = options.mainReasoning;
    this.sharedRegistry = options.modelRegistry;
  }

  /**
   * Resolve the registry for a run: an explicit per-run registry wins, then the
   * constructor's shared registry, then a lazily-built disk registry (shared
   * across calls once built). Async because pi >= 0.80.8 builds registries from
   * an async-created ModelRuntime.
   */
  private async getRegistry(perRunRegistry?: ModelRegistry): Promise<ModelRegistry> {
    if (perRunRegistry) {
      return perRunRegistry;
    }
    if (this.sharedRegistry) {
      return this.sharedRegistry;
    }
    if (!this.registry) {
      this.registry = await ensureFallbackRegistry();
    }
    return this.registry;
  }

  /**
   * Session manager for one subagent run. File-backed (persisted under the
   * standard sessions dir, keyed by the runner's project cwd — never a
   * per-call worktree cwd) when persistAgentSessions is on; in-memory otherwise.
   *
   * SessionManager.create() only creates the session directory — the SDK writes
   * the session file lazily (synchronous fs calls, uncaught) on the first
   * assistant message, deep inside session.prompt(). A failure there would
   * otherwise throw mid-run and abort this subagent. Probe writability up front
   * so any create/write failure (permissions, disk full) degrades this single
   * agent to an in-memory session instead — the run continues, just without a
   * persisted transcript.
   */
  private createSessionManager(): SessionManager {
    if (!this.persistAgentSessions) return SessionManager.inMemory();
    try {
      const manager = SessionManager.create(this.cwd);
      this.assertSessionDirWritable(manager.getSessionDir());
      warnPersistSecretsOnce(manager.getSessionDir());
      return manager;
    } catch (error) {
      console.warn(
        `[workflow] persistAgentSessions: could not persist this agent's session (${
          error instanceof Error ? error.message : String(error)
        }); continuing with an in-memory session`,
      );
      return SessionManager.inMemory();
    }
  }

  /** Best-effort write probe: throws if the session directory isn't actually writable. */
  private assertSessionDirWritable(dir: string): void {
    const probePath = join(dir, `.write-probe-${randomUUID()}`);
    writeFileSync(probePath, "");
    unlinkSync(probePath);
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
    // since tools capture their cwd at construction and can't be relocated.
    const runCwd = options.cwd ?? this.cwd;
    const baseTools = runCwd === this.cwd ? this.baseTools : createCodingTools(runCwd);
    // Apply the named agent tool policy BEFORE adding structured_output, so a
    // restrictive allowlist never strips the schema tool.
    const customTools: ToolDefinition[] = applyToolPolicy([...baseTools, ...(options.tools ?? [])], options.toolNames);

    // System tools bypass the allowlist (e.g. shared-store tools).
    if (options.systemTools?.length) {
      customTools.push(...options.systemTools);
    }

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    // Per-run modelRegistry wins over the constructor's shared registry, then
    // the lazily-built disk fallback. Used for model
    // resolution, and the subagent session's runtime below.
    const modelRegistry = await this.getRegistry(options.modelRegistry);

    // Model precedence is explicit call/definition model, then the active Pi
    // session model and reasoning. A model suffix overrides session reasoning.
    const modelSpec = resolveAgentModelSpec(options);
    let resolvedModel: Model<any> | undefined;
    let resolvedThinkingLevel: CreateAgentSessionOptions["thinkingLevel"] | undefined;
    if (modelSpec) {
      const resolved = resolveModelSpecWithThinking(modelSpec, modelRegistry);
      if (resolved.warning) console.warn(`[workflow] ${resolved.warning}`);
      if (resolved.model) {
        resolvedModel = resolved.model;
        resolvedThinkingLevel = resolved.thinkingLevel ?? this.mainReasoning;
      } else {
        console.warn(`[workflow] model "${modelSpec}" not found; using the active Pi session model`);
        options.onModelFallback?.(modelSpec);
      }
    }
    if (!resolvedModel && this.mainModel) {
      const sessionDefault = resolveModelSpecWithThinking(this.mainModel, modelRegistry);
      resolvedModel = sessionDefault.model;
      resolvedThinkingLevel = this.mainReasoning;
    }

    const agentDir = getAgentDir();
    // The runtime behind the resolved registry, handed to the subagent session
    // below so it shares the host session's exact catalog and auth.
    const modelRuntime = runtimeOf(modelRegistry);
    // Key persisted sessions by the runner's project cwd (this.cwd), NOT the
    // per-call runCwd: agents working in short-lived git worktrees should still
    // group under the project's session dir instead of scattering across
    // temporary worktree paths.
    const sessionManager = this.sessionOptions.sessionManager ?? this.createSessionManager();
    // A workflow subagent is a worker session, not another interactive Pi host.
    // In particular, loading the host's global extension set here makes every
    // subagent run unrelated interactive hooks (for example 00-template-vars)
    // with a context that the SDK does not provide. Keep Pi's resource loading
    // semantics for skills, prompt templates, and context files, while excluding
    // discovered extensions. Callers that deliberately provide a resourceLoader
    // retain full control, including explicitly requested extensions.
    const settingsManager = this.sessionOptions.settingsManager ?? SettingsManager.create(this.cwd, agentDir);
    const resourceLoader =
      this.sessionOptions.resourceLoader ??
      new DefaultResourceLoader({
        cwd: runCwd,
        agentDir,
        settingsManager,
        noExtensions: true,
      });
    if (!this.sessionOptions.resourceLoader) await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: runCwd,
      agentDir,
      sessionManager,
      // Use real SettingsManager to inherit user's default provider/model settings.
      // SettingsManager.inMemory() doesn't load ~/.pi/settings.json, so subagents
      // would fall back to the first available model (e.g. openai-codex) which may
      // not have valid auth, causing silent empty responses.
      settingsManager,
      resourceLoader,
      customTools,
      // Share the resolved registry's ModelRuntime (catalog + auth, including
      // extension-registered providers) with the subagent session. pi >= 0.80.8
      // takes modelRuntime here; the old modelRegistry option is gone.
      ...(modelRuntime ? { modelRuntime } : {}),
      ...this.sessionOptions,
      // Per-call model/thinking wins over any sessionOptions defaults.
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(resolvedThinkingLevel ? { thinkingLevel: resolvedThinkingLevel } : {}),
    });

    const canonicalModel = session.model ? canonicalModelSpec(session.model) : undefined;
    if (canonicalModel) options.onModelResolved?.(canonicalModel);
    options.onRuntimeResolved?.({
      model: canonicalModel,
      reasoning: session.thinkingLevel,
      tools: session.getActiveToolNames(),
    });

    // Name the persisted session so it's identifiable in session pickers.
    // Skip when an injected session.sessionManager override won (tests/embedders).
    if (this.persistAgentSessions && !this.sessionOptions.sessionManager && options.sessionName) {
      try {
        sessionManager.appendSessionInfo(options.sessionName);
      } catch {
        // Naming is best-effort; never fail the run over it.
      }
    }

    let removeAbortListener: (() => void) | undefined;
    let removeHistoryListener: (() => void) | undefined;
    let lastHistoryEmit = 0;
    const emitHistory = () =>
      options.onHistory?.(
        compactAgentHistory(session.messages).map((entry) => safeHistoryEntry(entry)) as AgentHistoryEntry[],
      );
    const maybeEmitHistory = () => {
      if (!options.onHistory) return;
      const now = Date.now();
      if (now - lastHistoryEmit < 250) return;
      lastHistoryEmit = now;
      emitHistory();
    };
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.onHistory || options.onActivity) {
        removeHistoryListener = session.subscribe((event) => {
          if (options.onHistory) maybeEmitHistory();
          if (options.onActivity) {
            const activity = normalizeAgentActivity(event as unknown as AgentActivityEvent);
            if (activity) options.onActivity(activity);
          }
        });
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK buries a provider usage/quota limit in the assistant message rather
      // than throwing; detect it here (before the schema/empty-text branches) so it
      // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
      // (schema path) or a silent empty-output null (non-schema path).
      throwIfProviderLimit(session.messages, options.label);

      if (options.schema) {
        return (await resolveStructuredOutput(session, capture, options.schema, options, (m) =>
          this.lastAssistantText(m),
        )) as AgentRunResult<TSchemaDef>;
      }

      const text = this.lastAssistantText(session.messages);
      if (!text.trim()) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: options.label,
        });
      }
      return text as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      removeHistoryListener?.();
      try {
        emitHistory();
      } catch {
        // History is diagnostic only; never let it mask the real result/error.
      }
      // Read real usage before disposing — dispose tears down the session state.
      if (options.onUsage) {
        try {
          const usage = usageFromStats(session.getSessionStats());
          if (usage) options.onUsage(usage);
        } catch {
          // Usage is best-effort; never let stats failure mask the real result/error.
        }
      }
      session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
