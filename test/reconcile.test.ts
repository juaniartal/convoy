import { describe, expect, it, vi } from 'vitest';
import { compileConfig, parseConfig } from '../src/config/overrides.js';
import { GithubClient } from '../src/core/github.js';
import { runReconciliation } from '../src/core/reconcile.js';
import { StateStore } from '../src/core/state.js';

function fakeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    run_number: 1,
    name: 'CI',
    event: 'push',
    head_branch: 'v1.0.0',
    head_sha: 'abc',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:05:00.000Z',
    html_url: 'https://github.com/org/repo/actions/runs/1',
    actor: { login: 'octocat' },
    ...overrides,
  };
}

function makeClient(opts: {
  repos: Array<{
    id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
    archived: boolean;
  }>;
  runsByRepo: Record<string, ReturnType<typeof fakeRun>[]>;
  jobsByRun?: Record<number, unknown[]>;
}): GithubClient {
  return {
    paginate: vi.fn().mockResolvedValue(opts.repos),
    request: vi.fn(async (route: string, params?: Record<string, unknown>) => {
      if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
        const fullName = `${params?.owner}/${params?.repo}`;
        return { data: { workflow_runs: opts.runsByRepo[fullName] ?? [] }, headers: {} };
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs') {
        return { data: { jobs: opts.jobsByRun?.[params?.run_id as number] ?? [] }, headers: {} };
      }
      throw new Error(`unexpected route ${route}`);
    }),
  };
}

const emptyConfig = compileConfig(parseConfig({}));

describe('runReconciliation', () => {
  it('populates state from discovered repos and classifies each run', async () => {
    const client = makeClient({
      repos: [
        { id: 1, full_name: 'org/api', private: true, default_branch: 'main', archived: false },
      ],
      runsByRepo: { 'org/api': [fakeRun()] },
      jobsByRun: {
        1: [
          {
            id: 10,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            started_at: null,
            completed_at: null,
            html_url: null,
          },
        ],
      },
    });
    const state = new StateStore();

    const result = await runReconciliation(client, state, emptyConfig);

    expect(result.reposProcessed).toBe(1);
    const snapshot = state.getSnapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0].category).toBe('deploy'); // push + semver tag
    expect(snapshot.runs[0].jobs).toHaveLength(1);
  });

  it('skips archived repos entirely', async () => {
    const client = makeClient({
      repos: [
        { id: 1, full_name: 'org/old', private: true, default_branch: 'main', archived: true },
      ],
      runsByRepo: {},
    });
    const state = new StateStore();
    await runReconciliation(client, state, emptyConfig);
    expect(state.getSnapshot().runs).toHaveLength(0);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('respects excludeRepos from config', async () => {
    const client = makeClient({
      repos: [
        {
          id: 1,
          full_name: 'org/test-fixtures',
          private: true,
          default_branch: 'main',
          archived: false,
        },
      ],
      runsByRepo: { 'org/test-fixtures': [fakeRun()] },
    });
    const config = compileConfig(parseConfig({ excludeRepos: ['test-*'] }));
    const state = new StateStore();
    await runReconciliation(client, state, config);
    expect(state.getSnapshot().runs).toHaveLength(0);
  });

  it('applies a per-repo override during reconciliation, not just the default heuristic', async () => {
    const client = makeClient({
      repos: [
        { id: 1, full_name: 'org/legacy', private: true, default_branch: 'main', archived: false },
      ],
      runsByRepo: { 'org/legacy': [fakeRun({ head_branch: 'production', event: 'push' })] },
    });
    const config = compileConfig(
      parseConfig({
        overrides: [{ repo: 'org/legacy', strategy: 'branch', deployBranches: ['production'] }],
      }),
    );
    const state = new StateStore();
    await runReconciliation(client, state, config);
    expect(state.getSnapshot().runs[0].category).toBe('deploy');
  });

  it('does not re-fetch job details for a run whose status is unchanged from what is already known', async () => {
    const client = makeClient({
      repos: [
        { id: 1, full_name: 'org/api', private: true, default_branch: 'main', archived: false },
      ],
      runsByRepo: { 'org/api': [fakeRun()] },
    });
    const state = new StateStore();
    // Seed state as if this run's current status was already recorded (e.g. by a webhook).
    state.upsertRun('org/api', {
      id: 1,
      runNumber: 1,
      workflowName: 'CI',
      event: 'push',
      headBranch: 'v1.0.0',
      headSha: 'abc',
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      htmlUrl: '',
      actor: null,
      category: 'deploy',
    });

    await runReconciliation(client, state, emptyConfig);

    const jobsCall = (client.request as ReturnType<typeof vi.fn>).mock.calls.find(
      ([route]) => route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
    );
    expect(jobsCall).toBeUndefined();
  });

  it('one repo failing unexpectedly does not stop the rest of the batch from being processed', async () => {
    const client: GithubClient = {
      paginate: vi.fn().mockResolvedValue([
        { id: 1, full_name: 'org/flaky', private: true, default_branch: 'main', archived: false },
        { id: 2, full_name: 'org/healthy', private: true, default_branch: 'main', archived: false },
      ]),
      request: vi.fn(async (route: string, params?: Record<string, unknown>) => {
        if (route === 'GET /repos/{owner}/{repo}/actions/runs') {
          if (params?.repo === 'flaky')
            throw Object.assign(new Error('ECONNRESET'), { status: 500 });
          return { data: { workflow_runs: [fakeRun()] }, headers: {} };
        }
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs') {
          return { data: { jobs: [] }, headers: {} };
        }
        throw new Error(`unexpected route ${route}`);
      }),
    };
    const state = new StateStore();
    const onRepoError = vi.fn();

    const result = await runReconciliation(client, state, emptyConfig, { onRepoError });

    expect(onRepoError).toHaveBeenCalledWith('org/flaky', expect.any(Error));
    expect(result.reposProcessed).toBe(1);
    expect(state.getRepo('org/healthy')?.lastReconciledAt).not.toBeNull();
    expect(state.getRepo('org/flaky')?.lastReconciledAt).toBeNull();
  });

  it('marks a skipped (403/404) repo as reconciled without throwing', async () => {
    const client: GithubClient = {
      paginate: vi.fn().mockResolvedValue([
        {
          id: 1,
          full_name: 'org/no-actions',
          private: true,
          default_branch: 'main',
          archived: false,
        },
      ]),
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })),
    };
    const state = new StateStore();
    const result = await runReconciliation(client, state, emptyConfig);
    expect(result.reposProcessed).toBe(1);
    expect(state.getRepo('org/no-actions')?.lastReconciledAt).not.toBeNull();
  });

  // The bug this guards against: a rate-limit-exceeded 403 used to be
  // indistinguishable from "this repo has Actions disabled" and got marked
  // reconciled anyway, with no real data behind that claim -- silently
  // hiding a rate-limit problem instead of backing off and retrying later.
  it('aborts without marking a repo reconciled when the rate limit is actually exhausted', async () => {
    const client: GithubClient = {
      paginate: vi.fn().mockResolvedValue([
        { id: 1, full_name: 'org/first', private: true, default_branch: 'main', archived: false },
        { id: 2, full_name: 'org/second', private: true, default_branch: 'main', archived: false },
      ]),
      request: vi.fn().mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        }),
      ),
    };
    const state = new StateStore();
    const result = await runReconciliation(client, state, emptyConfig, { concurrency: 1 });
    expect(result.aborted).toBe(true);
    expect(result.reposProcessed).toBe(0);
    expect(state.getRepo('org/first')?.lastReconciledAt).toBeNull();
  });
});
