import { Context } from 'probot';
import { CompiledConfig } from '../config/overrides.js';
import { classifyRun } from '../core/classify.js';
import { StateStore } from '../core/state.js';

/** Primary ingestion path for run-level status — this is what keeps the
 * dashboard live without polling. Reconciliation only exists to catch what
 * this handler misses (a dropped webhook delivery). */
export function handleWorkflowRun(state: StateStore, config: CompiledConfig) {
  return async (context: Context<'workflow_run'>): Promise<void> => {
    const { workflow_run: run, repository } = context.payload;
    if (config.isExcluded(repository.full_name)) return;

    state.upsertRepo({
      id: repository.id,
      fullName: repository.full_name,
      private: repository.private,
      defaultBranch: repository.default_branch,
    });

    const override = config.overrides.get(repository.full_name);
    const category = classifyRun(
      { event: run.event, headBranch: run.head_branch, workflowName: run.name ?? '' },
      override,
    );

    state.upsertRun(repository.full_name, {
      id: run.id,
      runNumber: run.run_number,
      workflowName: run.name ?? 'unknown',
      event: run.event,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      status: run.status ?? 'queued',
      conclusion: run.conclusion ?? null,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      htmlUrl: run.html_url,
      actor: run.actor?.login ?? null,
      category,
    });
  };
}
