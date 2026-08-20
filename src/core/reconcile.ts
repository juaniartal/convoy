import { CompiledConfig } from '../config/overrides.js';
import { classifyRun } from './classify.js';
import {
  GithubClient,
  listInstallationRepos,
  listJobsForRun,
  listWorkflowRunsForRepo,
  pool,
  WorkflowRunListItem,
} from './github.js';
import { RunUpsertInput, StateStore } from './state.js';
import { JobState } from './types.js';

export interface ReconcileOptions {
  /** How many repos to process concurrently. */
  concurrency?: number;
  /** Only fetch runs created after this many hours ago. */
  lookbackHours?: number;
  /** Stop starting new repo work once remaining rate limit drops below this —
   * the next reconciliation pass (or webhooks in the meantime) picks up the
   * rest. Only meaningful because reconciliation is a safety net, not the
   * primary update path. */
  minRateRemaining?: number;
  /** Called when a single repo's reconciliation fails for a reason other
   * than the normal "skip" cases (archived, Actions disabled) -- a
   * transient 500 or network blip on one repo out of hundreds shouldn't
   * take reconciliation down for every other repo in this pass. */
  onRepoError?: (repoFullName: string, err: unknown) => void;
}

const DEFAULTS: Required<ReconcileOptions> = {
  concurrency: 8,
  lookbackHours: 2,
  minRateRemaining: 200,
  onRepoError: () => {},
};

/**
 * Periodic safety net for missed webhook deliveries — NOT the primary way
 * Convoy stays up to date (webhooks are). Deliberately cheap: jobs are only
 * re-fetched for a run when its top-level status has actually changed (or
 * it's a run Convoy hasn't seen before), so a healthy webhook-fed system
 * barely touches the job-detail endpoint here.
 */
export async function runReconciliation(
  client: GithubClient,
  state: StateStore,
  config: CompiledConfig,
  options: ReconcileOptions = {},
): Promise<{ reposProcessed: number; aborted: boolean }> {
  const opts = { ...DEFAULTS, ...options };
  const cutoff = new Date(Date.now() - opts.lookbackHours * 3600_000).toISOString();

  const repos = (await listInstallationRepos(client)).filter(
    (r) => !r.archived && !config.isExcluded(r.full_name),
  );

  let lowestRateSeen: number | null = null;
  let aborted = false;
  let processed = 0;

  await pool(
    repos,
    async (repo) => {
      if (aborted) return;
      try {
        state.upsertRepo({
          id: repo.id,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
        });

        const [owner, name] = repo.full_name.split('/') as [string, string];
        const result = await listWorkflowRunsForRepo(client, owner, name, cutoff);
        if (result.rateRemaining != null) {
          lowestRateSeen =
            lowestRateSeen == null
              ? result.rateRemaining
              : Math.min(lowestRateSeen, result.rateRemaining);
        }
        // Genuinely out of budget, not "this repo has no Actions" -- every
        // other repo left in this pass would hit the exact same wall, so
        // stop starting new work rather than burning through the pool
        // logging the same failure repeatedly. This repo is NOT marked
        // reconciled: there's no real data behind this response, and the
        // next pass (or a webhook in the meantime) should retry it for real.
        if (result.rateLimited) {
          aborted = true;
          return;
        }
        if (result.skipped) {
          state.markReconciled(repo.full_name, new Date().toISOString());
          processed++;
          return;
        }

        const override = config.overrides.get(repo.full_name);
        for (const run of result.runs) {
          const changed = hasChanged(state, repo.full_name, run);
          const category = classifyRun(
            { event: run.event, headBranch: run.head_branch, workflowName: run.name ?? '' },
            override,
          );
          state.upsertRun(repo.full_name, toRunUpsertInput(run, category));

          if (changed) {
            const jobsRes = await listJobsForRun(client, owner, name, run.id);
            if (jobsRes.rateRemaining != null) {
              lowestRateSeen =
                lowestRateSeen == null
                  ? jobsRes.rateRemaining
                  : Math.min(lowestRateSeen, jobsRes.rateRemaining);
            }
            for (const job of jobsRes.jobs) {
              state.upsertJob(repo.full_name, run.id, toJobState(job));
            }
          }
        }

        state.markReconciled(repo.full_name, new Date().toISOString());
        processed++;

        if (lowestRateSeen != null && lowestRateSeen < opts.minRateRemaining) {
          aborted = true;
        }
      } catch (err) {
        opts.onRepoError(repo.full_name, err);
      }
    },
    opts.concurrency,
  );

  return { reposProcessed: processed, aborted };
}

function hasChanged(state: StateStore, repoFullName: string, run: WorkflowRunListItem): boolean {
  const existing = state.getRepo(repoFullName)?.runs.get(run.id);
  if (!existing) return true;
  return existing.status !== run.status || existing.conclusion !== run.conclusion;
}

export function toRunUpsertInput(
  run: WorkflowRunListItem,
  category: 'deploy' | 'pipeline',
): RunUpsertInput {
  return {
    id: run.id,
    runNumber: run.run_number,
    workflowName: run.name ?? 'unknown',
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    htmlUrl: run.html_url,
    actor: run.actor?.login ?? null,
    category,
  };
}

export function toJobState(job: {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
}): JobState {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    htmlUrl: job.html_url,
  };
}
