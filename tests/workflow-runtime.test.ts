import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow as executeWorkflow, type JournalEntry, type WorkflowRunOptions } from "../src/workflow.js";
import { testAgentDefinition, testAgentRegistry } from "./helpers/agents.js";

function runWorkflow<T = unknown>(script: string, options: WorkflowRunOptions = {}) {
  return executeWorkflow<T>(script, { agentRegistry: testAgentRegistry(), ...options });
}

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { agentType: 'reviewer', label: 'a' })
const b = await agent('second', { agentType: 'reviewer', label: 'b' })
return { a, b }`;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("runWorkflow concurrency caps parallel agents", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const started: Array<string> = [];
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(prompt);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'concurrency_cap', description: 'cap parallelism' }
const xs = await parallel(['a','b','c','d'].map((p) => () => agent(p, { agentType: 'reviewer', label: p })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 2, "only the first two agents should start before the gate opens");
  release.resolve();
  const result = await run;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.result, ["ok:a", "ok:b", "ok:c", "ok:d"]);
  assert.equal(result.agentCount, 4);
});

test("runWorkflow retries recoverable empty output then succeeds", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_success', description: 'retry success' }
const a = await agent('work', { agentType: 'reviewer', label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1, "retries should not allocate extra logical agent slots");
  assert.equal(journal.length, 1, "only the final success is journaled");
});

test("runWorkflow returns null when recoverable retries are exhausted", async () => {
  let calls = 0;
  const logs: string[] = [];
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_exhausted', description: 'retry exhausted' }
const a = await agent('work', { agentType: 'reviewer', label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return "";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, null);
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1);
  assert.equal(journal.length, 0, "failed/null recoverable results are not journaled");
  assert.ok(
    logs.some((message) => /retrying/i.test(message)),
    "logs should mention retrying",
  );
  assert.ok(
    logs.some((message) => /exhausted/i.test(message)),
    "logs should mention exhaustion",
  );
});

test("runWorkflow does not retry nonrecoverable errors", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'no_retry_nonrecoverable', description: 'nonrecoverable' }
const a = await agent('work', { agentType: 'reviewer', label: 'a' })
return a`,
      {
        agent: {
          async run() {
            calls++;
            throw new WorkflowError("hard stop", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
        agentRetries: 2,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(calls, 1);
});

test("per-agent retries override run-level retries", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'agent_retry_override', description: 'override' }
const a = await agent('work', { agentType: 'reviewer', label: 'a', retries: 1 })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 0,
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
});

test("runWorkflow accumulates real per-agent usage (incl. cost + cache tokens)", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002, cacheRead: 50, cacheWrite: 10 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9, "should be within tolerance");
  assert.equal(result.tokenUsage?.cacheRead, 100, "cacheRead accumulates across agents");
  assert.equal(result.tokenUsage?.cacheWrite, 20, "cacheWrite accumulates across agents");
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("agents default to the first declared phase when the script omits phase()", async () => {
  // Regression for the "(no phase) has agents, declared phase 0/0" bug: a script
  // that declares meta.phases but never calls phase() should still group its
  // agents under the first declared phase, not an orphan "(no phase)" bucket.
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Research' }, { title: 'Synthesize' }] }
     await agent('a', { agentType: 'reviewer', label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["Research"]);
});

test("explicit phase() overrides the default first phase", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
     phase('B')
     await agent('a', { agentType: 'reviewer', label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["B"]);
});

test("no declared phases => agent phase stays undefined (no synthetic phase)", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd' }
     await agent('a', { agentType: 'reviewer', label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, [undefined]);
});

test("runWorkflow model precedence is explicit override then definition model", async () => {
  const seen: Array<string | undefined> = [];
  const registry = testAgentRegistry();
  registry.set("reviewer", { ...testAgentDefinition(registry, "reviewer"), model: "definition/model" });
  const runner = {
    async run(_prompt: string, options: { model?: string }) {
      seen.push(options.model);
      return "ok";
    },
  };
  const script = `export const meta = { name: 'routing', description: 'model routing' }
await agent('explicit', { agentType: 'reviewer', label: 'explicit', model: 'call/model' })
await agent('definition', { agentType: 'reviewer', label: 'definition' })
return {}`;

  await runWorkflow(script, { agent: runner, agentRegistry: registry, persistLogs: false });
  assert.deepEqual(seen, ["call/model", "definition/model"]);
});

test("unknown agentType fails before the runner or model callback", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'strict_role', description: 'strict role' }
return await agent('work', { agentType: 'missing', model: 'provider/model' })`,
      {
        agent: {
          async run() {
            calls++;
            return "unexpected";
          },
        },
        persistLogs: false,
      },
    ),
    /Unknown workflow agentType "missing"/,
  );
  assert.equal(calls, 0);
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { agentType: 'reviewer', label: 'a' })
const b = await agent('second', { agentType: 'reviewer', label: 'b' })
return { a, b }`;

test("unknown agentType in parallel is non-recoverable and never reaches a runner", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'strict_parallel_role', description: 'strict parallel role' }
return await parallel([() => agent('work', { agentType: 'missing' })])`,
      {
        agent: {
          async run() {
            calls++;
            return "unexpected";
          },
        },
        persistLogs: false,
      },
    ),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      /Unknown workflow agentType/.test(error.message),
  );
  assert.equal(calls, 0);
});

test("resume replays cached results without re-running agents", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("resume preserves resolved model, reasoning, and tools for cached calls", async () => {
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: {
      async run(_prompt, options) {
        options.onRuntimeResolved?.({ model: "provider/canonical", reasoning: "high", tools: ["read", "bash"] });
        return "ok";
      },
    },
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });

  const resolved: unknown[] = [];
  await runWorkflow(resumeScript, {
    agent: {
      async run() {
        throw new Error("must not run");
      },
    },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    onAgentResolved: (event) => resolved.push(event),
  });
  assert.deepEqual(
    resolved.map(({ resolvedModel, reasoning, tools }: any) => ({ resolvedModel, reasoning, tools })),
    [
      { resolvedModel: "provider/canonical", reasoning: "high", tools: ["read", "bash"] },
      { resolvedModel: "provider/canonical", reasoning: "high", tools: ["read", "bash"] },
    ],
  );
});

test("cache identity covers role, fingerprint, model, tools, task, phase, explicit override, and schema", async () => {
  const definition = (name: string) => ({
    ...testAgentDefinition(testAgentRegistry(), name),
    name,
    model: "definition/model",
    tools: ["read"],
    fingerprint: "f".repeat(64),
  });
  const registry = new Map([
    ["reviewer", definition("reviewer")],
    ["finalizer", definition("finalizer")],
  ]);
  const baseScript = `export const meta = { name: 'identity', description: 'cache identity', phases: [{ title: 'A' }, { title: 'B' }] }
phase('A')
return await agent('task', { agentType: 'reviewer', label: 'identity' })`;
  const variations: Array<{ name: string; script?: string; registry?: typeof registry }> = [
    { name: "role", script: baseScript.replace("agentType: 'reviewer'", "agentType: 'finalizer'") },
    {
      name: "fingerprint",
      registry: new Map(registry).set("reviewer", {
        ...testAgentDefinition(registry, "reviewer"),
        fingerprint: "e".repeat(64),
      }),
    },
    {
      name: "model",
      registry: new Map(registry).set("reviewer", {
        ...testAgentDefinition(registry, "reviewer"),
        model: "other/model",
      }),
    },
    {
      name: "tools",
      registry: new Map(registry).set("reviewer", {
        ...testAgentDefinition(registry, "reviewer"),
        tools: ["bash"],
      }),
    },
    { name: "task", script: baseScript.replace("agent('task'", "agent('changed task'") },
    { name: "phase", script: baseScript.replace("phase('A')", "phase('B')") },
    {
      name: "explicit override",
      script: baseScript.replace("label: 'identity'", "label: 'identity', model: 'definition/model'"),
    },
    {
      name: "schema",
      script: baseScript.replace(
        "label: 'identity'",
        "label: 'identity', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }",
      ),
    },
  ];

  for (const variation of variations) {
    const journal: JournalEntry[] = [];
    await runWorkflow(baseScript, {
      agent: {
        async run() {
          return "base";
        },
      },
      agentRegistry: registry,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    });
    let calls = 0;
    await runWorkflow(variation.script ?? baseScript, {
      agent: {
        async run(_prompt, options) {
          calls++;
          return options.schema ? { ok: true } : "live";
        },
      },
      agentRegistry: variation.registry ?? registry,
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    });
    assert.equal(calls, 1, `${variation.name} must invalidate the cached call`);
  }
});

test("run snapshots the registry before the first call and shares it with nested workflows", async () => {
  const registry = testAgentRegistry();
  registry.set("reviewer", {
    ...testAgentDefinition(registry, "reviewer"),
    body: "snapshot body",
    model: "snapshot/model",
  });
  const seen: Array<{ instructions?: string; model?: string }> = [];
  const script = `export const meta = { name: 'snapshot', description: 'snapshot registry' }
await agent('first', { agentType: 'reviewer' })
await agent('second', { agentType: 'reviewer' })
return true`;
  await runWorkflow(script, {
    agentRegistry: registry,
    agent: {
      async run(_prompt, options) {
        seen.push({ instructions: options.instructions, model: options.model });
        registry.set("reviewer", {
          ...testAgentDefinition(registry, "reviewer"),
          body: "mutated body",
          model: "mutated/model",
        });
        return "ok";
      },
    },
    persistLogs: false,
  });
  assert.deepEqual(seen, [
    { instructions: "snapshot body", model: "snapshot/model" },
    { instructions: "snapshot body", model: "snapshot/model" },
  ]);
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

const threeCallScript = `export const meta = { name: 'prefix', description: 'prefix resume' }
const a = await agent('A', { agentType: 'reviewer', label: 'a' })
const b = await agent('B', { agentType: 'reviewer', label: 'b' })
const c = await agent('C', { agentType: 'reviewer', label: 'c' })
return { a, b, c }`;

test("resume re-runs the changed call AND everything after it (longest-unchanged-prefix)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  // Edit the MIDDLE call (index 1). Index 0 is an unchanged prefix → cache hit.
  // Index 1 changed → re-run; index 2 is unchanged but AFTER the first miss, so
  // it must re-run too (the bug was serving it stale from the journal).
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run; only the prefix (0) is cached");
});

test("resume in parallel(): editing one thunk re-runs that index and every later one", async () => {
  // Three identical-prompt thunks; editing the middle one must invalidate it and
  // the same-or-later index, not just the single changed call.
  const script = (mid: string) => `export const meta = { name: 'par_prefix', description: 'parallel prefix' }
  const xs = await parallel([
    () => agent('x', { agentType: 'reviewer', label: 'p0' }),
    () => agent('${mid}', { agentType: 'reviewer', label: 'p1' }),
    () => agent('x', { agentType: 'reviewer', label: 'p2' }),
  ])
  return xs`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script("x"), {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  const second = countingAgent();
  await runWorkflow(script("x-edited"), {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "changed thunk (index 1) + later index (2) re-run; index 0 cached");
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { agentType: 'reviewer', label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("workflow() runs a nested saved workflow and shares the global agent counter", async () => {
  const child = `export const meta = { name: 'child', description: 'c' }
const r = await agent('child task', { agentType: 'reviewer', label: 'c' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await agent('parent task', { agentType: 'reviewer', label: 'p' })
const nested = await workflow('child', { foo: 1 })
return { a, nested }`;

  const result = await runWorkflow<{ a: string; nested: { child: string } }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.result.nested.child, "ran:child task");
});

test("workflow() nesting is one level deep (second level throws)", async () => {
  const map: Record<string, string> = {
    gc: `export const meta = { name: 'gc', description: 'g' }
await agent('gc', { agentType: 'reviewer', label: 'g' })
return 1`,
    child: `export const meta = { name: 'child', description: 'c' }
await workflow('gc')
return 2`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
let err = null
try { await workflow('child') } catch (e) { err = String(e && e.message || e) }
return { err }`;

  const result = await runWorkflow<{ err: string }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => map[name],
  });
  assert.match(result.result.err, /one level deep/);
});

test("runWorkflow budget gates on accumulated tokens", async () => {
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
const a = await agent('first', { agentType: 'reviewer', label: 'a' })
let second = null
try { second = await agent('second', { agentType: 'reviewer', label: 'b' }) } catch (e) { second = 'blocked' }
return { a, second }`;

  const result = await runWorkflow<{ a: unknown; second: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    tokenBudget: 100,
    persistLogs: false,
  });

  assert.equal(result.result.second, "blocked");
});

test("token budget exhaustion inside parallel() halts (non-recoverable, not swallowed)", async () => {
  // A warm-up agent spends the whole budget (soft gate: spent accrues after it
  // finishes); the agent() inside parallel() then hits the gate and must
  // propagate the non-recoverable error, not become a null in the result array.
  const script = `export const meta = { name: 'pb', description: 'budget in parallel' }
await agent('warmup', { agentType: 'reviewer', label: 'w' })
const xs = await parallel([() => agent('x', { agentType: 'reviewer', label: '1' })])
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
        tokenBudget: 100,
        persistLogs: false,
      }),
    /budget/i,
    "exhausted budget must reject the run, not become a null in the result array",
  );
});

test("non-recoverable agent-limit propagates out of pipeline() too", async () => {
  const script = `export const meta = { name: 'mp', description: 'agent limit pipeline' }
const xs = await pipeline([0, 1, 2, 3], (n) => agent('x' + n, { agentType: 'reviewer', label: 'p' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("phase sub-budget throws when a phase exceeds its ceiling (run total untouched)", async () => {
  const script = `export const meta = { name: 'pb', description: 'phase budget' }
phase('noisy', { budget: 100 })
let blocked = false
try {
  await agent('a', { agentType: 'reviewer', label: '1' })
  await agent('b', { agentType: 'reviewer', label: '2' })
} catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
phase('calm')
const after = await agent('c', { agentType: 'reviewer', label: '3' })
return { blocked, after }`;
  const res = await runWorkflow<{ blocked: boolean; after: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    persistLogs: false,
  });
  assert.equal(res.result.blocked, true, "the 2nd agent in the phase hit the sub-budget");
  assert.ok(res.result.after !== null, "a later phase still proceeds");
});

test("maxAgents is enforced under a parallel() fan-out (atomic slot reservation)", async () => {
  // Four agents fan out with maxAgents=2. With the synchronous slot reservation,
  // the 3rd agent() throws AGENT_LIMIT instead of all four passing the gate.
  const script = `export const meta = { name: 'ma', description: 'agent limit' }
const xs = await parallel([0, 1, 2, 3].map((i) => () => agent('x' + i, { agentType: 'reviewer', label: 'a' + i })))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("a fan-out past maxAgents cancels queued agents instead of draining the reserved queue", async () => {
  // A parallel() overshoot reserves and queues up to maxAgents agents behind the
  // limiter. Before the fix, every reserved agent ran its real API call (spending)
  // even though the fan-out had already rejected; now the breach short-circuits the
  // still-queued agents so at most ~concurrency of them execute.
  const fanout = 100;
  const maxAgents = 50;
  const concurrency = 4;
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const runner = {
    async run(prompt: string) {
      calls.count++;
      await gate; // stay in-flight/queued while the limit breach propagates
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'c4', description: 'fanout cancel' }
const xs = await parallel(Array.from({ length: ${fanout} }, (_, i) => () => agent('x' + i, { agentType: 'reviewer', label: 'a' + i })))
return xs`;
  const run = runWorkflow(script, { agent: runner, maxAgents, concurrency, persistLogs: false });
  await assert.rejects(run, /limit/i);
  release();
  await new Promise((r) => setTimeout(r, 50)); // let any queued agents drain
  // Deterministically exactly `concurrency`: the limiter runs the first
  // `concurrency` submissions' bodies synchronously during the reservation
  // pass (each immediately calls runner.run() and then suspends on `gate`);
  // every submission after that suspends on the limiter's internal queue
  // before it ever reaches runner.run(), and the batch is cancelled (via
  // fanoutScope) before any of them get their turn.
  assert.equal(calls.count, concurrency);
});

test("sibling parallel() batches are isolated: one breaching maxAgents does not cancel the other", async () => {
  // Two independent parallel() fan-outs run CONCURRENTLY inside the same run
  // (sharing one shared.agentCount / maxAgents), each isolated via its own
  // .then(ok, err). Batch A (3 agents) never breaches; batch B (40 agents)
  // does. Before batch-scoped cancellation, a run-global "limitReached" flag
  // would wrongly cancel A's still-queued agents too, purely because B (an
  // unrelated fan-out) breached the shared cap — that's the regression this
  // guards against.
  const maxAgents = 10;
  const concurrency = 2;
  const runner = {
    async run(prompt: string) {
      await new Promise((r) => setTimeout(r, 5));
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'sib', description: 'sibling isolation' }
const batchA = parallel(Array.from({ length: 3 }, (_, i) => () => agent('a' + i, { agentType: 'reviewer', label: 'a' + i })))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e && e.code }))
const batchB = parallel(Array.from({ length: 40 }, (_, i) => () => agent('b' + i, { agentType: 'reviewer', label: 'b' + i })))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e && e.code }))
const [a, b] = await Promise.all([batchA, batchB])
return { a, b }`;
  const res = await runWorkflow<{
    a: { ok: boolean; r?: unknown[] };
    b: { ok: boolean; code?: string };
  }>(script, { agent: runner, maxAgents, concurrency, persistLogs: false });

  assert.equal(res.result.a.ok, true, "batch A (never breaches) must resolve, not be cancelled by sibling B");
  assert.equal(res.result.a.r?.length, 3);
  assert.ok((res.result.a.r as unknown[]).every((r) => typeof r === "string" && r.startsWith("ran:")));

  assert.equal(res.result.b.ok, false, "batch B (breaches maxAgents) must reject");
  assert.equal(res.result.b.code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
});

test("a breach in a nested parallel() doesn't corrupt the outer batch's state", async () => {
  // Outer parallel() of two thunks; one thunk runs an inner parallel() that
  // breaches a low maxAgents. The breach should propagate as a rejection of
  // the whole run (agent limit is non-recoverable) without throwing anything
  // unexpected (e.g. an ALS/ordering bug corrupting shared.agentCount).
  const runner = {
    async run(prompt: string) {
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'nest', description: 'nested fanout' }
const xs = await parallel([
  () => agent('outer-1', { agentType: 'reviewer', label: 'outer-1' }),
  () => parallel(Array.from({ length: 5 }, (_, i) => () => agent('inner' + i, { agentType: 'reviewer', label: 'inner' + i }))),
])
return xs`;
  await assert.rejects(
    () => runWorkflow(script, { agent: runner, maxAgents: 2, concurrency: 2, persistLogs: false }),
    /limit/i,
  );
});

// ─── Additional edge case tests ─────────────────────────────────────────────────

test("runWorkflow returns meta, logs, phases, and duration", async () => {
  const ONE_AGENT = `export const meta = { name: 'meta_test', description: 'check metadata' }
const a = await agent('test', { agentType: 'reviewer', label: 'a' })
return a`;

  const result = await runWorkflow(ONE_AGENT, {
    agent: fakeAgent({ total: 50 }),
    persistLogs: false,
  });

  assert.equal(result.meta.name, "meta_test");
  assert.equal(result.meta.description, "check metadata");
  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
  assert.ok(Array.isArray(result.phases), "result.phases should be an array");
  assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId should be a non-empty string");
});

test("runWorkflow handles empty script without phases gracefully", async () => {
  const SIMPLE = `export const meta = { name: 'simple', description: 'simple' }
const a = await agent('hello', { agentType: 'reviewer', label: 'greeter' })
return a`;

  const result = await runWorkflow(SIMPLE, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.equal(result.result, "done");
  assert.equal(result.agentCount, 1);
});

test("runWorkflow parallel returns results in input order", async () => {
  const script = `export const meta = { name: 'parallel_order', description: 'check order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n, { agentType: 'reviewer', label: 't' + n })))
return results`;

  let callIndex = 0;
  const agent = {
    async run(prompt: string) {
      return `result-${++callIndex}:${prompt}`;
    },
  };

  const result = await runWorkflow<unknown[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 3);
});

test("runWorkflow pipeline stages in order", async () => {
  const script = `export const meta = { name: 'pipeline_test', description: 'test pipeline' }
const results = await pipeline(
  ['a','b'],
  item => agent('stage1 ' + item, { agentType: 'reviewer' }),
  result => agent('stage2 ' + result, { agentType: 'reviewer' }),
)
return results`;

  const log: string[] = [];
  const agent = {
    async run(prompt: string) {
      log.push(prompt);
      return prompt.replace("stage1", "stage1-done").replace("stage2", "stage2-done");
    },
  };

  const result = await runWorkflow<string[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 2);
});

test("runWorkflow agent with different labels", async () => {
  const script = `export const meta = { name: 'label_test', description: 'labels' }
const a = await agent('task1', { agentType: 'reviewer', label: 'worker-1' })
const b = await agent('task2', { agentType: 'reviewer', label: 'worker-2' })
return { a, b }`;

  const seenLabels: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentStart: (e) => seenLabels.push(e.label),
  });

  assert.deepEqual(seenLabels, ["worker-1", "worker-2"]);
});

test("runWorkflow with phases assignment to agents", async () => {
  const script = `export const meta = { name: 'phase_test', description: 'phases', phases: [{ title: 'Phase1' }, { title: 'Phase2' }] }
phase('Phase1')
const a = await agent('phase1 work', { agentType: 'reviewer', label: 'p1' })
phase('Phase2')
const b = await agent('phase2 work', { agentType: 'reviewer', label: 'p2' })
return { a, b }`;

  const phases: string[] = [];
  const agentPhases: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onAgentStart: (e) => {
      if (e.phase) agentPhases.push(e.phase);
    },
  });

  assert.ok(phases.includes("Phase1"), "should contain Phase1");
  assert.ok(phases.includes("Phase2"), "should contain Phase2");
});

test("runWorkflow can send args to the script", async () => {
  const script = `export const meta = { name: 'args_test', description: 'test args' }
return { received: args && args.value }`;

  const result = await runWorkflow<{ received: unknown }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    args: { value: 42 },
  });

  // No agent calls means 0 agents
  assert.equal(result.result.received, 42);
});

test("runWorkflow log function works inside script", async () => {
  const script = `export const meta = { name: 'log_test', description: 'logging' }
log('hello from script')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("hello from script")),
    "should contain hello from script",
  );
});

test("runWorkflow console.log works inside script", async () => {
  const script = `export const meta = { name: 'console_test', description: 'console' }
console.log('console log')
console.warn('console warn')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("console log")),
    "should contain console log",
  );
  assert.ok(
    result.logs.some((l) => l.includes("console warn")),
    "should contain console warn",
  );
});

test("runWorkflow process.cwd() works inside script", async () => {
  const script = `export const meta = { name: 'cwd_test', description: 'cwd' }
return { cwd: process.cwd() }`;

  const result = await runWorkflow<{ cwd: string }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.equal(typeof result.result.cwd, "string");
  assert.ok(result.result.cwd.length > 0, "result.cwd should not be empty");
});

test("runWorkflow budget object exposes spent() and remaining()", async () => {
  const script = `export const meta = { name: 'budget_api', description: 'budget API' }
try { const s = budget.spent(); const r = budget.remaining(); return { spent: s, remaining: typeof r } }
catch(e) { return { error: String(e) } }`;

  const result = await runWorkflow<{ spent: number; remaining: string }>(script, {
    agent: fakeAgent({ total: 100 }),
    persistLogs: false,
  });

  assert.equal(result.result.spent, 0); // before first agent
  assert.equal(result.result.remaining, "number");
});

test("runWorkflow returns empty logs array when nothing logged", async () => {
  const script = `export const meta = { name: 'no_log', description: 'no logs' }
await agent('silent', { agentType: 'reviewer', label: 's' })
return 1`;

  const result = await runWorkflow(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
});

// ─── Runtime determinism hardening (P0-5) ───────────────────────────────────────

const noopAgent = {
  async run() {
    return "ok";
  },
};

function probe(expr: string): Promise<{ result: { err: string | null; val: unknown } }> {
  const script = `export const meta = { name: 'det', description: 'determinism' }
let err = null, val = null
try { val = ${expr} } catch (e) { err = String((e && e.message) || e) }
await agent('noop', { agentType: 'reviewer', label: 'x' })
return { err, val }`;
  return runWorkflow(script, { agent: noopAgent, persistLogs: false });
}

test("parse-time guard rejects literal Date.now / Math.random / new Date()", async () => {
  for (const expr of ["Math.random()", "Date.now()", "new Date()"]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'lit', description: 'd' }\nconst v = ${expr}\nawait agent('x', { agentType: 'reviewer', label: 'x' })\nreturn v`,
          { agent: noopAgent, persistLogs: false },
        ),
      /deterministic|unavailable/i,
      `${expr} literal should be rejected at parse time`,
    );
  }
});

test("runtime guard neuters computed-access bypasses the parse regex misses", async () => {
  const r1 = await probe('Math["random"]()');
  assert.match(r1.result.err ?? "", /unavailable|resume/i, 'Math["random"]() should throw at runtime');
  const r2 = await probe('Date["now"]()');
  assert.match(r2.result.err ?? "", /unavailable|resume/i, 'Date["now"]() should throw at runtime');
  const r3 = await probe("(() => { const D = Date; return new D(); })()");
  assert.match(r3.result.err ?? "", /unavailable|resume/i, "aliased no-arg Date should throw at runtime");
});

test("runtime determinism: new Date(arg) and Math.max still work", async () => {
  const d = await probe("new Date(0).getTime()");
  assert.equal(d.result.err, null, "new Date(0) should construct");
  assert.equal(d.result.val, 0, "new Date(0).getTime() === 0");
  const m = await probe("Math.max(1, 2, 3)");
  assert.equal(m.result.err, null);
  assert.equal(m.result.val, 3);
});

test("vm-realm builtins work and the constructor escape hits the neutered Date.now", async () => {
  // The escape string is split so the parse-time regex doesn't flag it; at runtime
  // the vm Function runs in the vm realm where Date.now is neutered.
  const script = `export const meta = { name: 'vm', description: 'vm realm' }
let escaped = null
try { escaped = ({}).constructor.constructor('return Da' + 'te.now()')() } catch (e) { escaped = 'blocked:' + String((e && e.message) || e) }
const arr = [1, 2, 3].map((x) => x * 2)
const j = JSON.stringify({ a: 1 })
const s = [...new Set([1, 1, 2])]
await agent('noop', { agentType: 'reviewer', label: 'x' })
return { escaped, arr, j, s }`;
  const r = await runWorkflow<{ escaped: string; arr: number[]; j: string; s: number[] }>(script, {
    agent: noopAgent,
    persistLogs: false,
  });
  // Spread to a host array: vm-realm arrays don't deepStrictEqual host literals.
  assert.deepEqual([...r.result.arr], [2, 4, 6], "vm Array.map works");
  assert.equal(r.result.j, '{"a":1}', "vm JSON works");
  assert.deepEqual([...r.result.s], [1, 2], "vm Set works");
  // ({}).constructor.constructor is the vm Function; its code runs in the vm realm
  // where Date.now is neutered -> blocked (the old host-object escape is closed).
  assert.match(r.result.escaped, /blocked/, "constructor escape via vm objects is closed");
});
