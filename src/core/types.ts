export type Classification = 'deploy' | 'pipeline';

export interface JobState {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
  /** Name of the first step that failed, when one did. GitHub sends the full
   * step list on every job -- in the webhook payload and in the jobs response
   * reconciliation already fetches -- and until now all of it was discarded.
   * Keeping just this one string is what lets a card say why a deploy broke
   * ("Run migrations") instead of only that it did, at no API cost and
   * without holding a step list per job in memory. */
  failedStep: string | null;
}

export interface RunState {
  id: number;
  runNumber: number;
  workflowName: string;
  event: string;
  headBranch: string | null;
  headSha: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  actor: string | null;
  category: Classification;
  jobs: Map<number, JobState>;
}

export interface RepoState {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  runs: Map<number, RunState>;
  lastReconciledAt: string | null;
}

/** Plain-object mirror of RunState, safe to JSON.stringify (Maps aren't). */
export interface RunSnapshot extends Omit<RunState, 'jobs'> {
  repo: string;
  jobs: JobState[];
}

export interface StateSnapshot {
  generatedAt: string;
  repoCount: number;
  runs: RunSnapshot[];
}
