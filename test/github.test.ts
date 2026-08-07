import { describe, expect, it, vi } from 'vitest';
import {
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

  it('treats a 403 as a skip, not an error', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 })),
    };
    const result = await listWorkflowRunsForRepo(client, 'org', 'repo');
    expect(result.skipped).toBe(true);
  });

  it('rethrows unexpected errors instead of silently skipping', async () => {
    const client: GithubClient = {
      paginate: vi.fn(),
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Server Error'), { status: 500 })),
    };
    await expect(listWorkflowRunsForRepo(client, 'org', 'repo')).rejects.toThrow('Server Error');
  });
});
