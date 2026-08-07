/**
 * A minimal duck-typed slice of the Octokit client — just the two call shapes
 * Convoy actually uses. Keeping this narrow (rather than importing Octokit's
 * full generated types) means tests can pass a trivial fake instead of
 * standing up a real client or an HTTP mock.
 */
export interface GithubClient {
  paginate<T>(route: string, params?: Record<string, unknown>): Promise<T[]>;
  request<T = unknown>(
    route: string,
    params?: Record<string, unknown>,
  ): Promise<{ data: T; headers: Record<string, string | number | undefined> }>;
}

export interface RepoListItem {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  archived: boolean;
}

export interface WorkflowRunListItem {
  id: number;
  run_number: number;
  name: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  actor: { login: string } | null;
}

export interface WorkflowJobListItem {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
}

/**
 * Fixed-size worker pool — without this, reconciling an org with hundreds of
 * repos would fire everything at once and trip GitHub's secondary rate
 * limit. Ported from the personal single-file tool's `pool()`, same idea.
 */
export async function pool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let i = 0;
  const size = Math.min(concurrency, items.length);
  await Promise.all(
    new Array(size).fill(0).map(async () => {
      while (i < items.length) {
        const item = items[i++] as T;
        await worker(item);
      }
    }),
  );
}

/** Lists repos the installation can actually see — respects "selected
 * repositories" installation scoping, unlike GET /orgs/{org}/repos which
 * would return the whole org regardless of what the App was granted. */
export async function listInstallationRepos(client: GithubClient): Promise<RepoListItem[]> {
  return client.paginate<RepoListItem>('GET /installation/repositories', { per_page: 100 });
}

export interface RunsResult {
  runs: WorkflowRunListItem[];
  rateRemaining: number | null;
  skipped: boolean;
}

/** Lists recent workflow runs for a repo. Archived repos or repos with
 * Actions disabled 404/403 — that's treated as "skip this repo," not an
 * error that should abort the whole reconciliation pass. */
export async function listWorkflowRunsForRepo(
  client: GithubClient,
  owner: string,
  repo: string,
  createdAfter?: string,
): Promise<RunsResult> {
  try {
    const params: Record<string, unknown> = { owner, repo, per_page: 100 };
    if (createdAfter) params.created = `>=${createdAfter}`;
    const res = await client.request<{ workflow_runs: WorkflowRunListItem[] }>(
      'GET /repos/{owner}/{repo}/actions/runs',
      params,
    );
    return {
      runs: res.data.workflow_runs,
      rateRemaining: parseRateRemaining(res.headers),
      skipped: false,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403 || status === 404) {
      return { runs: [], rateRemaining: null, skipped: true };
    }
    throw err;
  }
}

export async function listJobsForRun(
  client: GithubClient,
  owner: string,
  repo: string,
  runId: number,
): Promise<{ jobs: WorkflowJobListItem[]; rateRemaining: number | null }> {
  const res = await client.request<{ jobs: WorkflowJobListItem[] }>(
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
    { owner, repo, run_id: runId, per_page: 100 },
  );
  return { jobs: res.data.jobs, rateRemaining: parseRateRemaining(res.headers) };
}

function parseRateRemaining(headers: Record<string, string | number | undefined>): number | null {
  const raw = headers['x-ratelimit-remaining'];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
