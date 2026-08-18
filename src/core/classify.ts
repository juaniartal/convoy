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
 * Deploy-vs-pipeline classification, Convoy's core business rule.
 *
 * Combines the trigger event and the ref's shape rather than trusting ref
 * shape alone: a `release` event is always a deploy, a `push` only counts
 * if head_branch looks like a version tag. Everything else (real branches,
 * workflow_dispatch, scheduled runs) is a pipeline.
 *
 * A per-repo override fully replaces this default instead of blending with
 * it. Some repos deploy via a long-lived branch instead of tags, and "trust
 * what the repo told us completely" is simpler to reason about than mixing
 * two heuristics.
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
