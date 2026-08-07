import { Classification } from './types.js';

/** Matches v1.2.3, 1.2.3, v1.2.3-beta.1, 1.2.3+build.5 — deliberately permissive
 * about the leading "v" and pre-release/build metadata, since real-world tags
 * vary (see e.g. "v1.4.22-hotfix-20260731" in the wild). */
const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export interface ClassifyInput {
  /** The workflow run's `event` field: push, release, workflow_dispatch, schedule, ... */
  event: string;
  /** The workflow run's `head_branch` — GitHub overloads this to hold the tag
   * name itself for tag-triggered runs, not just real branch names. */
  headBranch: string | null;
  workflowName: string;
}

export type ClassifyOverride =
  | { strategy: 'branch'; deployBranches: string[] }
  | { strategy: 'tag-pattern'; tagPattern: RegExp }
  | { strategy: 'workflow-name'; deployWorkflows: string[] };

/**
 * Deploy-vs-pipeline classification — the core business rule of Convoy.
 *
 * Default heuristic combines *both* the trigger event and the ref's shape,
 * rather than trusting ref shape alone: a `release` event is always a
 * deploy; a `push` is a deploy only if what GitHub reports as head_branch
 * looks like a version tag. Everything else — pushes to real branches,
 * manual workflow_dispatch runs, scheduled runs — is a pipeline.
 *
 * An override, when present for a repo, fully replaces this default rather
 * than augmenting it — some repos deploy via a long-lived branch instead of
 * tags, and blending the two heuristics would be harder to reason about than
 * "if you've told us how this repo does it, we trust that completely."
 */
export function classifyRun(input: ClassifyInput, override?: ClassifyOverride): Classification {
  if (override) {
    return classifyWithOverride(input, override) ? 'deploy' : 'pipeline';
  }
  if (input.event === 'release') return 'deploy';
  if (input.event === 'push' && input.headBranch != null && SEMVER_TAG_RE.test(input.headBranch)) {
    return 'deploy';
  }
  return 'pipeline';
}

function classifyWithOverride(input: ClassifyInput, override: ClassifyOverride): boolean {
  switch (override.strategy) {
    case 'branch':
      return input.headBranch != null && override.deployBranches.includes(input.headBranch);
    case 'tag-pattern':
      return input.headBranch != null && override.tagPattern.test(input.headBranch);
    case 'workflow-name':
      return override.deployWorkflows.includes(input.workflowName);
  }
}
