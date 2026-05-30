import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowStorage, createWorkflowTool, registerWorkflowCommands, WorkflowManager } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  // Single manager/storage shared by the workflow tool and the /workflows command,
  // so background runs started by the tool are reachable from the command.
  const cwd = process.cwd();
  const manager = new WorkflowManager({ cwd });
  const storage = createWorkflowStorage(cwd);

  const workflowTool = createWorkflowTool({ cwd, manager, storage });
  pi.registerTool(workflowTool);
  registerWorkflowCommands(pi, manager);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  });
}
