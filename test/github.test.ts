import { describe, expect, it, vi } from 'vitest';
import {
  getWorkflowRun,
  GithubClient,
  listInstallationRepos,
  listWorkflowRunsForRepo,
  pool,
} from '../src/core/github.js';

describe('pool', () => {
  it('runs all items across a limited number of concurrent workers', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let concurrent = 0;
    let maxConcurrent = 0;
    const seen: number[] = [];

    await pool(
      items,
      async (item) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 1));
        seen.push(item);
        concurrent--;
      },
      4,
    );

    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  });

  it('handles an empty item list without hanging', async () => {
    await expect(pool([], async () => {}, 4)).resolves.toBeUndefined();
  });
});

describe('listInstallationRepos', () => {
  it('paginates GET /installation/repositories', async () => {
    const client: GithubClient = {
      paginate: vi.fn().mockResolvedValue([{ id: 1, full_name: 'org/a' }]),
      request: vi.fn(),
    };
    const repos = await listInstallationRepos(client);
    expect(client.paginate).toHaveBeenCalledWith(
      'GET /installation/repositories',
      expect.objectContaining({ per_page: 100 }),
    );
    expect(repos).toEqual([{ id: 1, full_name: 'org/a' }]);
  });
});

describe('listWorkflowRunsForRepo', () => {
  it('returns runs and the rate-limit remaining header on success', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockResolvedValue({
        data: { workflow_runs: [{ id: 1 }] },
        headers: { 'x-ratelimit-remaining': '4321' },
      }),
    };
    const result = await listWorkflowRunsForRepo(client, 'org', 'repo');
    expect(result.skipped).toBe(false);
    expect(result.rateRemaining).toBe(4321);
    expect(result.runs).toEqual([{ id: 1 }]);
  });

  it('treats a 404 (Actions disabled / archived) as a skip, not an error', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })),
    };
    const result = await listWorkflowRunsForRepo(client, 'org', 'repo');
    expect(result.skipped).toBe(true);
    expect(result.runs).toEqual([]);
  });

  it('treats a plain 403 (Actions disabled) as a skip, not an error', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 })),
    };
    const result = await listWorkflowRunsForRepo(client, 'org', 'repo');
    expect(result.skipped).toBe(true);
    expect(result.rateLimited).toBe(false);
  });

  // A rate-limit-exceeded response is also a plain 403 at the status-code
  // level -- distinguishing it by the x-ratelimit-remaining header is the
  // whole point, since treating it as a skip used to mark a repo
  // "reconciled" with no real data behind that claim.
  it('distinguishes a rate-limit-exceeded 403 from an Actions-disabled 403', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        }),
      ),
    };
    const result = await listWorkflowRunsForRepo(client, 'org', 'repo');
    expect(result.rateLimited).toBe(true);
    expect(result.skipped).toBe(false);
  });

  it('rethrows unexpected errors instead of silently skipping', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Server Error'), { status: 500 })),
    };
    await expect(listWorkflowRunsForRepo(client, 'org', 'repo')).rejects.toThrow('Server Error');
  });
});

describe('getWorkflowRun', () => {
  it('returns the single run on success', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockResolvedValue({
        data: { id: 1, status: 'completed' },
        headers: { 'x-ratelimit-remaining': '4321' },
      }),
    };
    const result = await getWorkflowRun(client, 'org', 'repo', 1);
    expect(result.run).toEqual({ id: 1, status: 'completed' });
    expect(result.rateRemaining).toBe(4321);
    expect(result.rateLimited).toBe(false);
  });

  it('returns run: null for a deleted run (404), not an error', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })),
    };
    const result = await getWorkflowRun(client, 'org', 'repo', 1);
    expect(result.run).toBeNull();
  });

  it('distinguishes a rate-limit-exceeded 403 the same way listWorkflowRunsForRepo does', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0' } },
        }),
      ),
    };
    const result = await getWorkflowRun(client, 'org', 'repo', 1);
    expect(result.rateLimited).toBe(true);
    expect(result.run).toBeNull();
  });
});
