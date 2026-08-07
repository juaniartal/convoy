import { Context } from 'probot';
import { describe, expect, it } from 'vitest';
import { compileConfig, parseConfig } from '../src/config/overrides.js';
import {
  handleInstallationCreated,
  handleInstallationDeleted,
  handleInstallationRepositoriesAdded,
  handleInstallationRepositoriesRemoved,
} from '../src/handlers/installation.js';
import { handleWorkflowJob } from '../src/handlers/workflowJob.js';
import { handleWorkflowRun } from '../src/handlers/workflowRun.js';
import { StateStore } from '../src/core/state.js';

/** Handlers only read `context.payload` — a plain object with that shape is
 * enough to exercise the real logic without spinning up Probot's dispatcher. */
function fakeContext<T>(payload: T): Context<never> {
  return { payload } as unknown as Context<never>;
}

const emptyConfig = compileConfig(parseConfig({}));

describe('handleWorkflowRun', () => {
  it('classifies and stores a run from a realistic workflow_run payload', async () => {
    const state = new StateStore();
    const handler = handleWorkflowRun(state, emptyConfig);

    await handler(
      fakeContext({
        repository: { id: 1, full_name: 'org/api', private: true, default_branch: 'main' },
        workflow_run: {
          id: 100,
          run_number: 5,
          name: 'Containerize and Deploy',
          event: 'push',
          head_branch: 'v1.4.23',
          head_sha: 'abc123',
          status: 'in_progress',
          conclusion: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          html_url: 'https://github.com/org/api/actions/runs/100',
          actor: { login: 'octocat' },
        },
      }) as never,
    );

    const [run] = state.getSnapshot().runs;
    expect(run.id).toBe(100);
    expect(run.category).toBe('deploy');
    expect(run.repo).toBe('org/api');
  });

  it('does not store runs for excluded repos', async () => {
    const config = compileConfig(parseConfig({ excludeRepos: ['test-*'] }));
    const state = new StateStore();
    const handler = handleWorkflowRun(state, config);

    await handler(
      fakeContext({
        repository: {
          id: 1,
          full_name: 'org/test-fixtures',
          private: true,
          default_branch: 'main',
        },
        workflow_run: {
          id: 1,
          run_number: 1,
          name: 'CI',
          event: 'push',
          head_branch: 'main',
          head_sha: 'abc',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          html_url: '',
          actor: null,
        },
      }) as never,
    );

    expect(state.getSnapshot().runs).toHaveLength(0);
  });
});

describe('handleWorkflowJob', () => {
  it('attaches job detail to the run it belongs to', async () => {
    const state = new StateStore();
    await handleWorkflowJob(
      state,
      emptyConfig,
    )(
      fakeContext({
        repository: { id: 1, full_name: 'org/api', private: true, default_branch: 'main' },
        workflow_job: {
          id: 10,
          run_id: 100,
          name: 'build',
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: null,
          html_url: 'https://github.com/org/api/actions/runs/100/job/10',
        },
      }) as never,
    );

    const [run] = state.getSnapshot().runs;
    expect(run.id).toBe(100);
    expect(run.jobs).toHaveLength(1);
    expect(run.jobs[0].name).toBe('build');
  });
});

describe('installation handlers', () => {
  it('adds repos on installation.created and removes them on installation.deleted', async () => {
    const state = new StateStore();
    await handleInstallationCreated(state)(
      fakeContext({
        repositories: [{ id: 1, full_name: 'org/a', private: true }],
      }) as never,
    );
    expect(state.getRepo('org/a')).toBeDefined();

    await handleInstallationDeleted(state)(
      fakeContext({
        repositories: [{ id: 1, full_name: 'org/a', private: true }],
      }) as never,
    );
    expect(state.getRepo('org/a')).toBeUndefined();
  });

  it('adds and removes repos as installation_repositories scope changes', async () => {
    const state = new StateStore();
    await handleInstallationRepositoriesAdded(state)(
      fakeContext({
        repositories_added: [{ id: 2, full_name: 'org/b', private: false }],
      }) as never,
    );
    expect(state.getRepo('org/b')).toBeDefined();

    await handleInstallationRepositoriesRemoved(state)(
      fakeContext({
        repositories_removed: [{ id: 2, full_name: 'org/b', private: false }],
      }) as never,
    );
    expect(state.getRepo('org/b')).toBeUndefined();
  });
});
