/**
 * Adversarial review mode for workflows.
 * Agents cross-check each other's findings for higher quality results.
 */

export interface AdversarialReviewConfig {
  /** Number of independent reviewers per finding. */
  reviewerCount: number;
  /** Whether to filter out findings that don't survive cross-checking. */
  filterContested: boolean;
  /** Minimum agreement threshold (0-1). */
  agreementThreshold: number;
}

const DEFAULT_CONFIG: AdversarialReviewConfig = {
  reviewerCount: 2,
  filterContested: true,
  agreementThreshold: 0.5,
};

/**
 * Generate an adversarial review workflow script.
 */
export function generateAdversarialReviewWorkflow(
  taskDescription: string,
  config: Partial<AdversarialReviewConfig> = {},
): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return `export const meta = {
  name: 'adversarial_review',
  description: 'Adversarial review with ${cfg.reviewerCount} independent reviewers',
  phases: [
    { title: 'Initial Investigation' },
    { title: 'Independent Review' },
    { title: 'Cross-Check' },
    { title: 'Consensus' },
  ],
};

phase('Initial Investigation');
const findings = await agent(
  'Investigate and document findings for: ${taskDescription.replace(/'/g, "\\'").slice(0, 80)}',
  { label: 'investigator' }
);

phase('Independent Review');
const reviews = await parallel(Array.from({ length: ${cfg.reviewerCount} }, (_, i) => () =>
  agent(
    'Independently review these findings. Agree or disagree with each point, and explain why:\\n\\n' + findings,
    { label: 'reviewer-' + (i + 1) }
  )
));

phase('Cross-Check');
const crossCheck = await agent(
  'Compare these independent reviews and identify points of agreement and disagreement:\\n' +
  'Reviews: ' + JSON.stringify(reviews) + '\\n' +
  'Original findings: ' + findings,
  { label: 'cross-checker' }
);

phase('Consensus');
const consensus = await agent(
  'Based on the cross-check, produce a final verified report. Only include findings that survived independent review:\\n' + crossCheck,
  { label: 'consensus-builder' }
);

return { findings, reviews, crossCheck, consensus };`;
}

/**
 * Generate a multi-perspective analysis workflow.
 */
export function generateMultiPerspectiveWorkflow(topic: string, perspectives: string[]): string {
  const perspectiveAgents = perspectives
    .map(
      (p, _i) =>
        `  () => agent('Analyze from ${p} perspective: ' + topic, { label: '${p.toLowerCase().replace(/\\s+/g, "-")}' }),`,
    )
    .join("\n");

  return `export const meta = {
  name: 'multi_perspective_analysis',
  description: 'Analyze from ${perspectives.length} different perspectives',
  phases: [
    { title: 'Perspective Analysis' },
    { title: 'Synthesis' },
  ],
};

phase('Perspective Analysis');
const topic = '${topic.replace(/'/g, "\\'")}';
const analyses = await parallel([
${perspectiveAgents}
]);

phase('Synthesis');
const synthesis = await agent(
  'Synthesize these different perspectives into a balanced analysis:\\n' +
  'Analyses: ' + JSON.stringify(analyses) + '\\n' +
  'Topic: ' + topic,
  { label: 'synthesizer' }
);

return { analyses, synthesis };`;
}
