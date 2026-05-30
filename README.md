# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research. Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

Fork of [Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows), updated for `@earendil-works/*` packages with a subagent settings-inheritance fix.

## Install

```bash
pi install @quintinshaw/pi-dynamic-workflows
```

Then `/reload` in Pi. The extension registers a `workflow` tool and activates it on session start.

<details>
<summary>From source (for development)</summary>

```bash
git clone git@github.com:QuintinShaw/pi-dynamic-workflows.git
pi install /path/to/pi-dynamic-workflows
```
</details>

## Usage

Ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model writes a workflow script and calls the `workflow` tool. Live progress streams inline:

```text
◆ Workflow: inspect_project (3/3 done · 12,480 tokens)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Press `Esc` to cancel a running run; active subagents are aborted and surfaced as skipped.

### Background runs & `/workflows`

Ask for a background workflow (the model passes `background: true`) and it runs without blocking your session. Manage it with the `/workflows` command:

```text
/workflows                 # list runs (default)
/workflows status <id>     # show a run's progress
/workflows stop <id>       # abort a running run
/workflows pause <id>      # pause a running run
/workflows rm <id>         # remove a run from the list
```

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [{ title: 'Scan' }, { title: 'Analyze' }],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', { label: 'repo inventory' })

phase('Analyze')
const summary = await agent('Summarize the main modules:\n' + inventory, { label: 'module summary' })

return { inventory, summary }
```

### Globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text, or a validated object with `opts.schema`. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results returned in input order. |
| `pipeline(items, ...stages)` | Fan items out through sequential stages. Each stage receives `(prev, original, index)`. |
| `phase(title)` | Mark the current phase for the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed via the tool's `args` parameter. |
| `budget` | `{ total, spent(), remaining() }` token-budget tracker. |
| `cwd`, `process.cwd()` | Working directory for subagents. |

### Agent options

| Option | Type | Description |
| --- | --- | --- |
| `label` | string | Human-readable label for progress display |
| `phase` | string | Override the current phase for this agent |
| `schema` | object | JSON Schema for structured output |
| `model` | string | Run this agent on a specific model — `provider/modelId` or a bare `modelId` |
| `timeoutMs` | number | Override the default 5-minute agent timeout |

Models can also be set per phase via `meta.phases[].model`. Precedence is `opts.model` > phase model > session default; an unknown model logs a warning and falls back to the default.

### Structured output

Pass a JSON Schema via `opts.schema` and the subagent returns a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Backed by a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call.

### Determinism rules

Scripts run inside a Node `vm` sandbox. Intentionally unavailable: `Date.now()`, `new Date()`, `Math.random()`, `require`/`import`/`fs`/network, and (inside `meta`) spreads, computed keys, template interpolation, and function calls. This keeps `meta` parseable and runs reproducible.

## What works today

- **Core runtime** — `agent` / `parallel` / `pipeline` / `phase` / `log` / `budget` in a sandboxed script
- **Structured output** — JSON-Schema-validated subagent results
- **Real token & cost accounting** — read from each subagent's SDK session (input / output / total / cost), with a character estimate only as fallback when a provider reports no usage; `budget` gates on the real total
- **Real per-agent / per-phase model routing** — `opts.model` and `meta.phases[].model` actually select the model (resolved against your authed model registry), with graceful fallback
- **`/workflows` command** — list, inspect, stop, pause, and remove background runs; runs started with `background: true` are reachable from the command
- **Safety limits** — 1000-agent cap (`maxAgents`), per-agent timeout (`agentTimeoutMs`), recoverable-vs-fatal error classification
- **Live progress + token/cost display**, `Esc` to abort
- **Log persistence** to `.pi/workflows/runs/`

## Roadmap

Tracked toward closer parity with Claude Code dynamic workflows:

- **Resume** — journaled results, replay the unchanged prefix, run the rest live
- **Worktree isolation** for parallel edits, and **bundled `/deep-research`**
- **Saved workflows** as `/<name>` slash commands

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses + runs it in a vm sandbox
  → script calls agent() / parallel() / pipeline()
  → each agent() spawns a fresh in-memory Pi subagent session
  → snapshots stream back as compact progress
  → final structured result returns to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools (read, bash, edit, write, grep, find, ls), so they work exactly like a normal Pi turn.

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
```

Parser unit tests live in `tests/workflow-parser.test.ts`.

## License

MIT
