import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findProjectAgentsDir,
  loadAgentRegistry,
  parseAgentDefinition,
  resolveAgentType,
  snapshotAgentRegistry,
} from "../src/agent-registry.js";

const markdown = (name: string, description = "Description", body = "Prompt") =>
  `---\nname: ${name}\ndescription: ${description}\ntools: read, grep\nmodel: provider/model\n---\n${body}\n`;

test("direct Markdown definitions require name and description and support tools, model, and body", () => {
  const definition = parseAgentDefinition(markdown("reviewer"), "user", "~/.pi/agent/agents/reviewer.md");
  assert.equal(definition.name, "reviewer");
  assert.equal(definition.description, "Description");
  assert.deepEqual(definition.tools, ["read", "grep"]);
  assert.equal(definition.model, "provider/model");
  assert.equal(definition.body, "Prompt");
  assert.match(definition.fingerprint, /^[a-f0-9]{64}$/);

  const emptyBody = parseAgentDefinition(markdown("reviewer", "Description", ""), "user", "reviewer.md");
  assert.equal(emptyBody.body, "");
  assert.throws(() => parseAgentDefinition("Prompt only", "user", "bad.md"), /name must be a non-empty string/);
  assert.throws(
    () => parseAgentDefinition("---\nname: reviewer\n---\nPrompt", "user", "bad.md"),
    /description must be a non-empty string/,
  );
});

test("definitions reject custom fields and invalid supported field values", () => {
  assert.throws(
    () =>
      parseAgentDefinition(
        "---\nname: reviewer\ndescription: Review\nisolation: worktree\n---\nPrompt",
        "project",
        ".pi/agents/reviewer.md",
      ),
    /unsupported field isolation.*supported fields are name, description, tools, and model/,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        "---\nname: reviewer\ndescription: Review\ntools: 42\n---\nPrompt",
        "project",
        ".pi/agents/reviewer.md",
      ),
    /tools must be/,
  );
});

test("fingerprints are semantic and independent of source path", () => {
  const first = parseAgentDefinition(markdown("reviewer"), "user", "~/.pi/agent/agents/reviewer.md");
  const moved = parseAgentDefinition(markdown("reviewer"), "project", ".pi/agents/reviewer.md");
  const edited = parseAgentDefinition(markdown("reviewer", "Changed"), "user", "~/.pi/agent/agents/reviewer.md");
  assert.equal(first.fingerprint, moved.fingerprint);
  assert.notEqual(first.fingerprint, edited.fingerprint);
});

test("nearest ancestor project directory overrides user definitions and records a stable path", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-agents-"));
  const user = join(root, "user");
  const outer = join(root, "repo", ".pi", "agents");
  const inner = join(root, "repo", "packages", ".pi", "agents");
  const cwd = join(root, "repo", "packages", "app");
  try {
    mkdirSync(user, { recursive: true });
    mkdirSync(outer, { recursive: true });
    mkdirSync(inner, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(user, "reviewer.md"), markdown("reviewer", "User", "User prompt"));
    writeFileSync(join(outer, "reviewer.md"), markdown("reviewer", "Outer", "Outer prompt"));
    writeFileSync(join(inner, "reviewer.md"), markdown("reviewer", "Nearest", "Nearest prompt"));

    assert.equal(findProjectAgentsDir(cwd), inner);
    const definition = resolveAgentType("reviewer", loadAgentRegistry(cwd, { userDir: user }));
    assert.equal(definition.source, "project");
    assert.equal(definition.body, "Nearest prompt");
    assert.equal(definition.path, ".pi/agents/reviewer.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid files fail registry loading instead of being silently skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-invalid-agent-"));
  try {
    writeFileSync(join(root, "bad.md"), "---\nname: bad\n---\nPrompt");
    assert.throws(() => loadAgentRegistry(root, { userDir: root, projectDir: join(root, "missing") }), /bad\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown names fail with the available roles before execution", () => {
  assert.throws(() => resolveAgentType("missing", new Map()), /Unknown workflow agentType "missing".*none/);
});

test("registry snapshots do not observe later map or definition mutations", () => {
  const definition = parseAgentDefinition(markdown("reviewer"), "user", "~/.pi/agent/agents/reviewer.md");
  const mutable = { ...definition, tools: [...(definition.tools ?? [])] };
  const registry = new Map([["reviewer", mutable]]);
  const snapshot = snapshotAgentRegistry(registry);
  mutable.body = "mutated";
  mutable.tools[0] = "write";
  registry.set("reviewer", { ...definition, body: "replacement" });
  assert.equal(snapshot.get("reviewer")?.body, "Prompt");
  assert.deepEqual(snapshot.get("reviewer")?.tools, ["read", "grep"]);
});
