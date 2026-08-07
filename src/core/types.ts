export type Classification = 'deploy' | 'pipeline';

export interface JobState {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
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
