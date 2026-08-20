import { CompiledConfig } from '../config/overrides.js';
import { classifyRun } from './classify.js';
import { getWorkflowRun, GithubClient, listJobsForRun } from './github.js';
import { toJobState, toRunUpsertInput } from './reconcile.js';
import { StateStore } from './state.js';

export interface WatchActiveRunsOptions {
  /** Caps the worst case even if far more than this are active at once
   * (a burst) -- the rest just wait for the next tick or the slower full
   * reconciliation pass, rather than this tick trying to do everything at
   * once and risking the rate limit on its own. */
  maxRunsPerTick?: number;
  minRateRemaining?: number;
}

const DEFAULTS: Required<WatchActiveRunsOptions> = {
  maxRunsPerTick: 50,
  minRateRemaining: 200,
};

/**
 * The gap this closes: a run stuck showing "rolling" because GitHub never
 * delivered its `completed` webhook (this happens for real under bursts --
 * confirmed directly against a real installation, not theoretical) used to
 * sit wrong for up to the full 5-minute reconciliation interval. This runs
 * far more often (tens of seconds) but only ever asks about runs Convoy
 * already knows are still in progress -- reading that list costs nothing
 * (it's local state, not an API call), and checking one specific run by id
 * is a single cheap request, not the ~100-run list reconciliation uses.
 *
 * Deliberately NOT a replacement for reconciliation: an org with no active
 * runs right now costs this function exactly zero API calls, and one with
 * many active runs still hits maxRunsPerTick/minRateRemaining before doing
 * anything reconciliation's own throttling wouldn't also allow.
 */
export async function watchActiveRuns(
  client: GithubClient,
  state: StateStore,
  config: CompiledConfig,
  options: WatchActiveRunsOptions = {},
): Promise<{ checked: number; aborted: boolean }> {
  const opts = { ...DEFAULTS, ...options };
  const active = state.listActiveRuns().slice(0, opts.maxRunsPerTick);

  let checked = 0;
  let aborted = false;

  for (const { repoFullName, run } of active) {
    if (aborted) break;
    if (config.isExcluded(repoFullName)) continue;

    const [owner, name] = repoFullName.split('/') as [string, string];
    const result = await getWorkflowRun(client, owner, name, run.id);

    if (result.rateLimited) {
      aborted = true;
      break;
    }
    if (result.rateRemaining != null && result.rateRemaining < opts.minRateRemaining) {
      aborted = true;
    }
    checked++;

    // Gone from GitHub's side (rare) or genuinely nothing changed yet --
    // either way, no point re-writing state or spending a second call on
    // job details for a run whose top-level status hasn't moved.
    if (!result.run) continue;
    const changed = result.run.status !== run.status || result.run.conclusion !== run.conclusion;
    if (!changed) continue;

    const override = config.overrides.get(repoFullName);
    const category = classifyRun(
      {
        event: result.run.event,
        headBranch: result.run.head_branch,
        workflowName: result.run.name ?? '',
      },
      override,
    );
    state.upsertRun(repoFullName, toRunUpsertInput(result.run, category));

    if (result.run.status === 'completed') {
      const jobsRes = await listJobsForRun(client, owner, name, run.id);
      for (const job of jobsRes.jobs) {
        state.upsertJob(repoFullName, run.id, toJobState(job));
      }
    }
  }

  return { checked, aborted };
}
