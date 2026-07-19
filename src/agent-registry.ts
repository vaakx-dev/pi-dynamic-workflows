import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentDefinitionSource = "project" | "user";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  body: string;
  source: AgentDefinitionSource;
  /** Stable source-relative path, suitable for persistence across machines. */
  path: string;
  fingerprint: string;
}

export type AgentRegistry = Map<string, AgentDefinition>;

const FIELDS = new Set(["name", "description", "tools", "model"]);

function stringField(value: unknown, field: string, path: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid agent definition "${path}": ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseTools(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!values || values.some((tool) => typeof tool !== "string")) {
    throw new Error(`Invalid agent definition "${path}": tools must be a comma-separated string or string array`);
  }
  const tools = values.map((tool) => tool.trim()).filter(Boolean);
  if (!tools.length) throw new Error(`Invalid agent definition "${path}": tools must contain at least one tool name`);
  return [...new Set(tools)];
}

export function parseAgentDefinition(content: string, source: AgentDefinitionSource, path: string): AgentDefinition {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(content);
  } catch (error) {
    throw new Error(
      `Invalid agent definition "${path}": ${error instanceof Error ? error.message : "malformed frontmatter"}`,
    );
  }

  const customFields = Object.keys(parsed.frontmatter).filter((field) => !FIELDS.has(field));
  if (customFields.length) {
    throw new Error(
      `Invalid agent definition "${path}": unsupported field${customFields.length === 1 ? "" : "s"} ${customFields.join(", ")}; supported fields are name, description, tools, and model`,
    );
  }

  const name = stringField(parsed.frontmatter.name, "name", path, true) as string;
  const description = stringField(parsed.frontmatter.description, "description", path, true) as string;
  const tools = parseTools(parsed.frontmatter.tools, path);
  const model = stringField(parsed.frontmatter.model, "model", path, false);
  const body = parsed.body.trim();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ name, description, tools: tools ?? null, model: model ?? null, body }))
    .digest("hex");

  return Object.freeze({
    name,
    description,
    tools: tools ? (Object.freeze(tools) as unknown as string[]) : undefined,
    model,
    body,
    source,
    path,
    fingerprint,
  });
}

function stablePath(source: AgentDefinitionSource, file: string): string {
  const root = source === "project" ? ".pi/agents" : "~/.pi/agent/agents";
  return `${root}/${file}`;
}

function loadDirectory(path: string, source: AgentDefinitionSource): AgentDefinition[] {
  if (!existsSync(path)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Unable to read agent definitions from "${path}": ${error instanceof Error ? error.message : error}`,
    );
  }

  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = join(path, entry.name);
      try {
        return parseAgentDefinition(readFileSync(file, "utf8"), source, stablePath(source, entry.name));
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : error} (source file: ${file})`);
      }
    });
}

export function findProjectAgentsDir(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".pi", "agents");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {}
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function loadAgentRegistry(cwd: string, options?: { projectDir?: string; userDir?: string }): AgentRegistry {
  const registry: AgentRegistry = new Map();
  const userDir = options?.userDir ?? join(getAgentDir(), "agents");
  const projectDir = options?.projectDir ?? findProjectAgentsDir(cwd);

  for (const definition of loadDirectory(userDir, "user")) registry.set(definition.name, definition);
  if (projectDir) {
    for (const definition of loadDirectory(projectDir, "project")) registry.set(definition.name, definition);
  }
  return registry;
}

export function snapshotAgentRegistry(registry: AgentRegistry): AgentRegistry {
  return new Map(
    [...registry].map(([name, definition]) => [
      name,
      Object.freeze({
        ...definition,
        tools: definition.tools ? (Object.freeze([...definition.tools]) as unknown as string[]) : undefined,
      }),
    ]),
  );
}

export function resolveAgentType(name: string, registry: AgentRegistry): AgentDefinition {
  const definition = registry.get(name);
  if (!definition) {
    const available = [...registry.keys()].sort().join(", ") || "none";
    throw new Error(`Unknown workflow agentType "${name}". Available agent types: ${available}`);
  }
  return definition;
}

export function applyToolPolicy<T extends { name: string }>(tools: T[], allow?: readonly string[]): T[] {
  if (!allow?.length) return tools;
  const names = new Set(allow);
  return tools.filter((tool) => names.has(tool.name));
}

export function listAgentTypes(registry: AgentRegistry): AgentDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}
