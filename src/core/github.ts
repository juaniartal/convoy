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
  /** True specifically for a rate-limit-exceeded 403 -- distinct from
   * "skipped" (Actions disabled / archived), which is a permanent,
   * per-repo condition safe to mark as reconciled. A rate-limited repo has
   * no real data behind this response and must NOT be marked reconciled;
   * the caller aborts the pass instead so the next one retries it. */
  rateLimited: boolean;
}

/** Lists recent workflow runs for a repo. Archived repos or repos with
 * Actions disabled 404/403 — that's treated as "skip this repo," not an
 * error that should abort the whole reconciliation pass. A rate-limit-
 * exceeded 403 looks identical at the status-code level but means
 * something completely different (every other repo in this pass will hit
 * the same wall), so it's distinguished by the accompanying header rather
 * than lumped in with "skip" the way it used to be. */
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
      rateLimited: false,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403 && isRateLimitExceeded(err)) {
      return { runs: [], rateRemaining: 0, skipped: false, rateLimited: true };
    }
    if (status === 403 || status === 404) {
      return { runs: [], rateRemaining: null, skipped: true, rateLimited: false };
    }
    throw err;
  }
}

/** A rate-limit-exceeded response is a 403 with `x-ratelimit-remaining: 0`
 * on the response that came with the error -- everything else that's also
 * a plain 403 (Actions disabled for this repo, say) won't have that
 * header at all, let alone set to zero. */
function isRateLimitExceeded(err: unknown): boolean {
  const headers = (err as { response?: { headers?: Record<string, string | number | undefined> } })
    .response?.headers;
  return headers?.['x-ratelimit-remaining'] === '0';
}

export interface SingleRunResult {
  run: WorkflowRunListItem | null;
  rateRemaining: number | null;
  rateLimited: boolean;
}

/** Fetches exactly one run by id -- what the active-run watcher uses
 * instead of listWorkflowRunsForRepo, since it already knows the specific
 * run it cares about and listing up to 100 runs just to check one would
 * waste most of that response. `run: null` covers the rare case of the
 * run having been deleted on GitHub since Convoy last saw it (404) --
 * that's not an error, just something to drop rather than keep retrying. */
export async function getWorkflowRun(
  client: GithubClient,
  owner: string,
  repo: string,
  runId: number,
): Promise<SingleRunResult> {
  try {
    const res = await client.request<WorkflowRunListItem>(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
      { owner, repo, run_id: runId },
    );
    return { run: res.data, rateRemaining: parseRateRemaining(res.headers), rateLimited: false };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403 && isRateLimitExceeded(err)) {
      return { run: null, rateRemaining: 0, rateLimited: true };
    }
    if (status === 403 || status === 404) {
      return { run: null, rateRemaining: null, rateLimited: false };
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
