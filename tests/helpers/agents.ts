import type { AgentDefinition, AgentRegistry } from "../../src/agent-registry.js";

function definition(name: string, tools?: string[]): AgentDefinition {
  return {
    name,
    description: `${name} test role`,
    tools,
    body: `${name} test instructions`,
    source: "user",
    path: `~/.pi/agent/agents/${name}.md`,
    fingerprint: name.padEnd(64, "0").slice(0, 64),
  };
}

export function testAgentRegistry(): AgentRegistry {
  return new Map([
    ["reviewer", definition("reviewer", ["read", "bash"])],
    ["implementer", definition("implementer")],
    ["finalizer", definition("finalizer")],
    ["read-only-auditor", definition("read-only-auditor", ["read_file"])],
  ]);
}

export function testAgentDefinition(registry: AgentRegistry, name: string): AgentDefinition {
  const value = registry.get(name);
  if (!value) throw new Error(`Missing test agent definition: ${name}`);
  return value;
}
