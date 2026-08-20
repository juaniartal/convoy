import { describe, expect, it, vi } from 'vitest';
import { watchActiveRuns } from '../src/core/activeRunWatcher.js';
import { compileConfig, parseConfig } from '../src/config/overrides.js';
import { GithubClient } from '../src/core/github.js';
import { StateStore } from '../src/core/state.js';

const emptyConfig = compileConfig(parseConfig({}));

function seedActiveRun(state: StateStore, repoFullName: string, id: number): void {
  state.upsertRepo({ id: 1, fullName: repoFullName, private: true, defaultBranch: 'main' });
  state.upsertRun(repoFullName, {
    id,
    runNumber: 1,
    workflowName: 'CI',
    event: 'push',
    headBranch: 'main',
    headSha: 'abc',
    status: 'in_progress',
    conclusion: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    htmlUrl: '',
    actor: null,
    category: 'pipeline',
  });
}

describe('watchActiveRuns', () => {
  it('makes zero API calls when nothing is active', async () => {
    const client: GithubClient = { paginate: vi.fn(), request: vi.fn() };
    const state = new StateStore();
    const result = await watchActiveRuns(client, state, emptyConfig);
    expect(result.checked).toBe(0);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('corrects a run that finished on GitHub but is still shown as active', async () => {
    const state = new StateStore();
    seedActiveRun(state, 'org/api', 1);

    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn(async (route: string) => {
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') {
          return {
            data: {
              id: 1,
              run_number: 1,
              name: 'CI',
              event: 'push',
              head_branch: 'main',
              head_sha: 'abc',
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:05:00.000Z',
              html_url: 'https://github.com/org/api/actions/runs/1',
              actor: { login: 'octocat' },
            },
            headers: { 'x-ratelimit-remaining': '4999' },
          };
        }
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs') {
          return { data: { jobs: [] }, headers: {} };
        }
        throw new Error(`unexpected route ${route}`);
      }),
    };

    const result = await watchActiveRuns(client, state, emptyConfig);
    expect(result.checked).toBe(1);
    const run = state.getRepo('org/api')?.runs.get(1);
    expect(run?.status).toBe('completed');
    expect(run?.conclusion).toBe('success');
  });

  it('does not re-fetch job details when the run has not actually changed', async () => {
    const state = new StateStore();
    seedActiveRun(state, 'org/api', 1);

    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn(async (route: string) => {
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') {
          return {
            data: {
              id: 1,
              run_number: 1,
              name: 'CI',
              event: 'push',
              head_branch: 'main',
              head_sha: 'abc',
              status: 'in_progress', // unchanged
              conclusion: null,
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              html_url: '',
              actor: null,
            },
            headers: { 'x-ratelimit-remaining': '4999' },
          };
        }
        throw new Error(`unexpected route ${route}`);
      }),
    };

    await watchActiveRuns(client, state, emptyConfig);
    // Only the single-run check should have happened -- the mock throws on
    // any other route, so reaching the jobs endpoint would fail the test.
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('caps how many active runs it checks in one tick', async () => {
    const state = new StateStore();
    for (let i = 1; i <= 5; i++) seedActiveRun(state, `org/repo-${i}`, i);

    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockResolvedValue({
        data: {
          id: 1,
          run_number: 1,
          name: 'CI',
          event: 'push',
          head_branch: 'main',
          head_sha: 'abc',
          status: 'in_progress',
          conclusion: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          html_url: '',
          actor: null,
        },
        headers: { 'x-ratelimit-remaining': '4999' },
      }),
    };

    const result = await watchActiveRuns(client, state, emptyConfig, { maxRunsPerTick: 2 });
    expect(result.checked).toBe(2);
  });

  it('stops immediately, without crashing, when it hits a real rate-limit-exceeded response', async () => {
    const state = new StateStore();
    seedActiveRun(state, 'org/api', 1);
    seedActiveRun(state, 'org/other', 2);

    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        }),
      ),
    };

    const result = await watchActiveRuns(client, state, emptyConfig);
    expect(result.aborted).toBe(true);
    expect(result.checked).toBe(0);
  });

  it('respects excludeRepos from config', async () => {
    const state = new StateStore();
    seedActiveRun(state, 'org/test-fixtures', 1);
    const config = compileConfig(parseConfig({ excludeRepos: ['test-*'] }));

    const client: GithubClient = { paginate: vi.fn(), request: vi.fn() };
    const result = await watchActiveRuns(client, state, config);
    expect(result.checked).toBe(0);
    expect(client.request).not.toHaveBeenCalled();
  });
});
