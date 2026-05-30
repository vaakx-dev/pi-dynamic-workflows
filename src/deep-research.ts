/**
 * Deep research workflow.
 * Built-in workflow for comprehensive research across multiple sources.
 */

export interface DeepResearchConfig {
  /** Number of search angles to explore. */
  searchAngles: number;
  /** Number of sources to fetch per angle. */
  sourcesPerAngle: number;
  /** Whether to cross-check claims across sources. */
  crossCheck: boolean;
  /** Maximum number of agents to use. */
  maxAgents: number;
}

const DEFAULT_CONFIG: DeepResearchConfig = {
  searchAngles: 4,
  sourcesPerAngle: 3,
  crossCheck: true,
  maxAgents: 20,
};

/**
 * Generate a deep research workflow script.
 */
export function generateDeepResearchWorkflow(question: string, config: Partial<DeepResearchConfig> = {}): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const escapedQuestion = question.replace(/'/g, "\\'").slice(0, 80);

  const crossCheckPhase = cfg.crossCheck
    ? `phase('Cross-Check');
const crossCheck = await agent(
  'Cross-check these research findings. Identify claims that are supported by multiple sources vs. claims that appear in only one source:\\n' +
  'Sources: ' + JSON.stringify(sources),
  { label: 'cross-checker' }
);`
    : "";

  const crossCheckRef = cfg.crossCheck ? "'Cross-check: ' + crossCheck + '\\n' + " : "";
  const crossCheckReturn = cfg.crossCheck ? "crossCheck, " : "";

  return `export const meta = {
  name: 'deep_research',
  description: 'Deep research: ${escapedQuestion}',
  phases: [
    { title: 'Search Planning' },
    { title: 'Source Gathering' },
    { title: 'Cross-Check' },
    { title: 'Report' },
  ],
};

phase('Search Planning');
const question = '${escapedQuestion}';
const searchPlan = await agent(
  'Plan ${cfg.searchAngles} different search angles to research this question comprehensively: ' + question,
  { label: 'search-planner' }
);

phase('Source Gathering');
const sources = await parallel(Array.from({ length: ${cfg.searchAngles} }, (_, i) => () =>
  agent(
    'Research angle ' + (i + 1) + ' for this question: ' + question + '\\n\\nPlan: ' + searchPlan + '\\n\\nFind and summarize ${cfg.sourcesPerAngle} relevant sources.',
    { label: 'researcher-' + (i + 1) }
  )
));

${crossCheckPhase}

phase('Report');
const report = await agent(
  'Synthesize a comprehensive research report from these findings:\\n' +
  'Question: ' + question + '\\n' +
  'Sources: ' + JSON.stringify(sources) + '\\n' +
  ${crossCheckRef}'\\n\\nProduce a well-structured report with citations and confidence levels.',
  { label: 'report-writer' }
);

return { searchPlan, sources, ${crossCheckReturn}report };`;
}

/**
 * Generate a codebase audit workflow.
 */
export function generateCodebaseAuditWorkflow(scope: string, checks: string[]): string {
  const escapedScope = scope.replace(/'/g, "\\'").slice(0, 60);
  const checkAgents = checks
    .map((check) => {
      const label = check
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 20);
      return `  () => agent('Audit ${check} across: ' + scope, { label: '${label}' }),`;
    })
    .join("\n");

  return `export const meta = {
  name: 'codebase_audit',
  description: 'Codebase audit: ${escapedScope}',
  phases: [
    { title: 'Individual Checks' },
    { title: 'Cross-Validation' },
    { title: 'Report' },
  ],
};

phase('Individual Checks');
const scope = '${escapedScope}';
const findings = await parallel([
${checkAgents}
]);

phase('Cross-Validation');
const validated = await agent(
  'Cross-validate these audit findings. Remove false positives and confirm real issues:\\n' +
  JSON.stringify(findings),
  { label: 'validator' }
);

phase('Report');
const report = await agent(
  'Generate a prioritized audit report with actionable recommendations:\\n' + validated,
  { label: 'report-writer' }
);

return { findings, validated, report };`;
}
