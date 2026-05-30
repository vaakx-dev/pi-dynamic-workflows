/**
 * Auto-workflow mode (ultracode equivalent).
 * Automatically decides when to use workflows based on task complexity.
 */

export interface AutoWorkflowConfig {
  /** Enable auto-workflow mode. */
  enabled: boolean;
  /** Minimum number of subtasks to trigger a workflow. */
  minSubtasks: number;
  /** Keywords that suggest workflow usage. */
  triggerKeywords: string[];
  /** Maximum complexity score before auto-triggering. */
  complexityThreshold: number;
}

const DEFAULT_CONFIG: AutoWorkflowConfig = {
  enabled: false,
  minSubtasks: 3,
  triggerKeywords: [
    "workflow",
    "parallel",
    "fan-out",
    "audit",
    "migrate",
    "review",
    "research",
    "analyze all",
    "check every",
    "sweep",
    "batch",
    "bulk",
  ],
  complexityThreshold: 7,
};

/**
 * Analyze a task description and determine if it should use a workflow.
 */
export function shouldUseWorkflow(
  taskDescription: string,
  config: Partial<AutoWorkflowConfig> = { enabled: true },
): { useWorkflow: boolean; confidence: number; reason: string } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return { useWorkflow: false, confidence: 0, reason: "Auto-workflow disabled" };
  }

  const lower = taskDescription.toLowerCase();

  // Check for explicit workflow keywords
  const keywordMatches = cfg.triggerKeywords.filter((kw) => lower.includes(kw));
  if (keywordMatches.length > 0) {
    return {
      useWorkflow: true,
      confidence: Math.min(0.5 + keywordMatches.length * 0.15, 1),
      reason: `Matched keywords: ${keywordMatches.join(", ")}`,
    };
  }

  // Analyze complexity indicators
  const complexityIndicators = [
    { pattern: /\b(all|every|each|entire|whole)\b/i, weight: 2 },
    { pattern: /\b(files?|directories|folders?|modules?|components?|endpoints?)\b/i, weight: 1.5 },
    { pattern: /\b(parallel|concurrent|simultaneously)\b/i, weight: 2 },
    { pattern: /\b(review|audit|check|verify|validate)\b/i, weight: 1 },
    { pattern: /\b(migrate|refactor|update|modify|change)\b/i, weight: 1.5 },
    { pattern: /\b(research|investigate|analyze|compare)\b/i, weight: 1 },
    { pattern: /\d+\s*(files?|items?|tasks?|components?)/i, weight: 2 },
    { pattern: /\b(across|throughout|cross-cutting)\b/i, weight: 1.5 },
  ];

  let complexityScore = 0;
  for (const indicator of complexityIndicators) {
    if (indicator.pattern.test(taskDescription)) {
      complexityScore += indicator.weight;
    }
  }

  // Estimate subtask count
  const subtaskIndicators = [
    /\bfirst\b/gi,
    /\bthen\b/gi,
    /\bfinally\b/gi,
    /\bafter\b/gi,
    /\bnext\b/gi,
    /\balso\b/gi,
    /\bstep \d/gi,
  ];

  let estimatedSubtasks = 1;
  for (const pattern of subtaskIndicators) {
    const matches = taskDescription.match(pattern);
    if (matches) estimatedSubtasks += matches.length;
  }

  if (complexityScore >= cfg.complexityThreshold || estimatedSubtasks >= cfg.minSubtasks) {
    return {
      useWorkflow: true,
      confidence: Math.min(complexityScore / 10, 1),
      reason: `Complexity score: ${complexityScore}, estimated subtasks: ${estimatedSubtasks}`,
    };
  }

  return {
    useWorkflow: false,
    confidence: 0.3,
    reason: `Below threshold (complexity: ${complexityScore}, subtasks: ${estimatedSubtasks})`,
  };
}

/**
 * Generate a workflow script suggestion from a task description.
 */
export function suggestWorkflowScript(taskDescription: string): string {
  return `export const meta = {
  name: 'auto_generated',
  description: '${taskDescription.replace(/'/g, "\\'").slice(0, 100)}',
  phases: [
    { title: 'Analyze' },
    { title: 'Execute' },
    { title: 'Verify' },
  ],
};

phase('Analyze');
const analysis = await agent(
  'Analyze this task and break it into subtasks: ${taskDescription.replace(/'/g, "\\'").slice(0, 80)}',
  { label: 'task analysis' }
);

phase('Execute');
const results = await parallel([
  () => agent('Execute subtask 1 based on: ' + analysis, { label: 'subtask-1' }),
  // Add more subtasks as needed
]);

phase('Verify');
const verification = await agent(
  'Verify these results are correct: ' + JSON.stringify(results),
  { label: 'verification' }
);

return { analysis, results, verification };`;
}
