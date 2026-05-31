# pi-dynamic-workflows

[![npm](https://img.shields.io/npm/v/@quintinshaw/pi-dynamic-workflows?color=cb3837&logo=npm)](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://github.com/earendil-works/pi)
[![tests](https://img.shields.io/badge/tests-43%20passing-success)](#development)

> **Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).** One assistant turn fans out into dozens of isolated subagents, cross-checks itself, and hands you a synthesized result.

Instead of one model grinding through a task step by step, Pi writes a small JavaScript **orchestration script** that spawns many subagents in parallel, holds the intermediate results in script variables (not the chat context), and returns only the answer. You get the structure of a pipeline with the flexibility of plain code.

Perfect for **codebase-wide audits, multi-perspective review, large refactors, and cross-checked research** — anything where one context window isn't enough.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

---

## ✨ Highlights

- 🚀 **Fan-out orchestration** — `agent()`, `parallel()`, `pipeline()`, `phase()` in a sandboxed script. Up to 16 concurrent / 1000 total subagents.
- 🧭 **Interactive `/workflows` TUI** — drill through runs → phases → agents → agent detail with the keyboard, just like Claude Code. Pause, stop, and save runs without leaving the view.
- 📊 **Real token & cost accounting** — read straight from each subagent's session (input / output / cost), not estimated. Your `budget` gates on the real total.
- 🧠 **Real per-agent / per-phase model routing** — send the cheap work to a small model and the hard synthesis to a big one, resolved against your authenticated models.
- ⏯️ **Resume** — interrupted runs replay completed agents from a journal (no re-run, no tokens) and only run what's left or what you changed.
- 🌲 **Git worktree isolation** — `isolation: "worktree"` gives an agent its own branch so parallel agents can edit the same files without clobbering each other.
- 🔭 **Bundled `/deep-research`** — fans out **real** web searches, fetches sources, keeps only multi-source-supported claims, and writes a cited report. Plus `/adversarial-review` for skeptic-vetted findings.
- 🧩 **Saved & nested workflows** — turn any run into a `/<name>` slash command; compose saved workflows from inside other scripts.
- 🪟 **Non-blocking by default + live task panel** — workflows run in the background: the turn ends immediately so you can keep chatting or start other tasks, a "Workflows running" panel tracks them under your input, and when one finishes its result is delivered back and the conversation **auto-continues** (queued politely after whatever you're doing, never interrupting).
- 🌈 **Workflows mode in the input box** — type `workflow`/`workflows` and the word turns into a flowing rainbow, arming a forced workflow for that message. One Backspace right after the word disarms it (turns plain white) without deleting it.

> **This is a heavily extended fork.** The [upstream project](https://github.com/Michaelliv/pi-dynamic-workflows) shipped the core script runtime; here, every advertised capability is actually **implemented, real-tested against the Pi SDK, and shipped** — see the [comparison](#whats-different-from-upstream) below.

---

## Install

```bash
pi install @quintinshaw/pi-dynamic-workflows
```

Then `/reload` in Pi. The extension registers the `workflow` tool and the `/workflows`, `/deep-research`, and `/adversarial-review` commands.

<details>
<summary>From source (for development)</summary>

```bash
git clone git@github.com:QuintinShaw/pi-dynamic-workflows.git
pi install /path/to/pi-dynamic-workflows
```
</details>

## 30-second demo

Just ask for a workflow in plain language:

```text
Run a workflow to audit every route under src/routes/ for missing auth checks.
```

Pi writes the script and runs it in the background — your turn ends right away, and a compact progress view streams in the "Workflows running" task panel while you keep working:

```text
◆ Workflow: auth_audit (5/5 done · 48,210 tokens · $0.0131)
  ✓ Scan 1/1
    #1 ✓ enumerate routes
  ✓ Review 3/3
    #2 ✓ routes/users.ts
    #3 ✓ routes/admin.ts
    #4 ✓ routes/billing.ts
  ✓ Verify 1/1
    #5 ✓ adversarial recheck
```

When it finishes, the result is delivered back into the conversation and the turn auto-continues — queued after whatever you're doing so it never interrupts. (Need the result inline in the same turn instead? The model can pass `background: false` to block.)

## What's different from upstream

This fork turns the original's roadmap into working, tested features:

| Capability | Upstream | This fork |
| --- | :---: | :---: |
| Core `agent`/`parallel`/`pipeline` runtime | ✅ | ✅ |
| Structured (JSON-Schema) subagent output | ✅ | ✅ |
| **Token & cost accounting** | estimate | ✅ real, from the SDK session |
| **Per-agent / per-phase model routing** | prose-only* | ✅ actually switches models |
| **`/workflows` command + interactive TUI** | — | ✅ full keyboard navigator |
| **Resume an interrupted run** | — | ✅ journaled, replays the prefix |
| **Git worktree isolation** | — | ✅ real worktrees, auto-cleanup |
| **`/deep-research` with real web access** | — | ✅ live search + cross-checking |
| **Saved workflows as `/<name>`** | — | ✅ |
| **Nested `workflow()`** | — | ✅ shares the global caps |
| **Non-blocking background runs + live task panel + auto-continue delivery** | — | ✅ |
| Test suite | minimal | ✅ 43 tests + real Pi end-to-end |

<sub>*Upstream injected the requested model as a text line in the prompt; it never changed the subagent's actual model.</sub>

## Commands

```text
/workflows                 # open the interactive navigator (plain list in print mode)
/workflows status <id>     # watch a running run live; prints the result when it finishes
/workflows save <name>     # save the latest run's script as a reusable /<name> command
/workflows pause|resume|stop|rm <id>

/deep-research <question>  # web-researched, source-cross-checked report
/adversarial-review <task> # findings cross-checked by skeptical reviewers
```

In the **interactive navigator**: `↑/↓` (or `j/k`) select · `enter`/`→` open · `esc`/`←` back · `j/k` scroll detail · `p` pause · `x` stop · `r` restart (re-runs the whole workflow as a fresh background run) · `s` save · `q` quit. The agents list and each agent's detail show **which model it ran on**.

### Workflows mode (input box)

As you type, the words `workflow`/`workflows` light up as a **flowing rainbow** — a signal that submitting this message will deliberately run a workflow (the message is rewritten to ask Pi to orchestrate subagents rather than answer directly). Changed your mind? Press **Backspace** once right after the word: it turns plain white (disarmed) without being deleted. Type a fresh trigger word to re-arm. Slash commands like `/workflows` are left alone (never highlighted). Everything else about the editor — history, autocomplete, paste, multiline — is unchanged.

## Writing a workflow

A workflow is plain JavaScript whose first statement exports literal metadata:

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
| `workflow(name, args)` | Run a saved workflow inline and return its result (one level deep; shares the global caps). |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed via the tool's `args` parameter. |
| `budget` | `{ total, spent(), remaining() }` token-budget tracker (real tokens). |
| `cwd`, `process.cwd()` | Working directory for subagents. |

### Agent options

| Option | Type | Description |
| --- | --- | --- |
| `label` | string | Human-readable label for progress display |
| `phase` | string | Override the current phase for this agent |
| `schema` | object | JSON Schema → the subagent returns a validated object |
| `model` | string | Run this agent on a specific model — `provider/modelId` or a bare `modelId` |
| `isolation` | `"worktree"` | Run this agent in its own throwaway git worktree (parallel edits without conflict) |
| `timeoutMs` | number | Override the default 5-minute agent timeout |

Models can also be set per phase via `meta.phases[].model`. Precedence: `opts.model` > phase model > session default; an unknown model logs a warning and falls back. The model each agent ran on is recorded and shown in the `/workflows` navigator.

**Model routing is decided by the assistant, not hardcoded.** When it writes a workflow, Pi is given the routing policy and the list of your currently authenticated models, and picks each agent's `model` accordingly: a lighter same-family model (one tier below your main model — e.g. Claude→Haiku, GPT→a mini) for exploration/search/gathering agents, and your main model for analysis/judgment/decision agents. If you name a specific model, that wins.

### Structured output

Pass a JSON Schema and the subagent returns a validated object instead of prose:

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

Backed by a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call — no wasted follow-up turn.

### Determinism

Scripts run inside a Node `vm` sandbox. Intentionally unavailable: `Date.now()`, `new Date()`, `Math.random()`, `require`/`import`/`fs`/network, and (inside `meta`) spreads, computed keys, template interpolation, and function calls. This keeps `meta` parseable and runs **reproducible** — which is what makes resume reliable.

## How it works

```text
user prompt
  → Pi writes a workflow script
  → the workflow tool parses + runs it in a vm sandbox
  → the script calls agent() / parallel() / pipeline()
  → each agent() spawns a fresh in-memory Pi subagent session
  → results are journaled; snapshots stream back as compact progress
  → the final structured result returns to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools (read, bash, edit, write, grep, find, ls), so they work exactly like a normal Pi turn — and inherit your provider/model settings.

## Development

```bash
npm install
npm test     # biome check + tsc + 43 unit tests
```

Tests live in `tests/`. Each feature is also verified end-to-end against a real Pi subagent session before release.

## Credits

Fork of [Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows), rebuilt on `@earendil-works/*` packages with the advertised feature set implemented and a subagent settings-inheritance fix. Inspired by [Claude Code dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## License

MIT
