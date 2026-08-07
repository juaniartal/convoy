import { Context } from 'probot';
import { CompiledConfig } from '../config/overrides.js';
import { StateStore } from '../core/state.js';

/** Job-level detail (per-step status shown inside a run's card). Delivery
 * order relative to workflow_run isn't guaranteed by GitHub — StateStore's
 * upsertJob handles that by creating a placeholder run if needed. */
export function handleWorkflowJob(state: StateStore, config: CompiledConfig) {
  return async (context: Context<'workflow_job'>): Promise<void> => {
    const { workflow_job: job, repository } = context.payload;
    if (config.isExcluded(repository.full_name)) return;

    state.upsertJob(repository.full_name, job.run_id, {
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? null,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      htmlUrl: job.html_url ?? null,
    });
  };
}
