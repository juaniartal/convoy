import { describe, expect, it } from 'vitest';
import { RunUpsertInput, StateStore } from '../src/core/state.js';

function makeRun(overrides: Partial<RunUpsertInput> = {}): RunUpsertInput {
  return {
    id: 1,
    runNumber: 1,
    workflowName: 'Build and Deploy',
    event: 'push',
    headBranch: 'main',
    headSha: 'abc123',
    status: 'in_progress',
    conclusion: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    htmlUrl: 'https://github.com/org/repo/actions/runs/1',
    actor: 'octocat',
    category: 'pipeline',
    ...overrides,
  };
}

describe('StateStore', () => {
  it('upserts a repo and retrieves it', () => {
    const store = new StateStore();
    store.upsertRepo({ id: 1, fullName: 'org/repo', private: true, defaultBranch: 'main' });
    expect(store.getRepo('org/repo')).toBeDefined();
    expect(store.listRepos()).toHaveLength(1);
  });

  it('creates a placeholder repo when a run arrives before the repo is known', () => {
    const store = new StateStore();
    store.upsertRun('org/repo', makeRun());
    expect(store.getRepo('org/repo')).toBeDefined();
    expect(store.getSnapshot().runs).toHaveLength(1);
  });

  it('updates a run in place without losing previously recorded jobs', () => {
    const store = new StateStore();
    store.upsertRun('org/repo', makeRun({ status: 'in_progress' }));
    store.upsertJob('org/repo', 1, {
      id: 100,
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      htmlUrl: null,
    });

    store.upsertRun('org/repo', makeRun({ status: 'completed', conclusion: 'success' }));

    const [run] = store.getSnapshot().runs;
    expect(run.status).toBe('completed');
    expect(run.jobs).toHaveLength(1);
    expect(run.jobs[0].name).toBe('build');
  });

  it('creates a stub run when a job event arrives before its workflow_run event', () => {
    const store = new StateStore();
    store.upsertJob('org/repo', 42, {
      id: 1,
      name: 'test',
      status: 'in_progress',
      conclusion: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      htmlUrl: null,
    });

    const [run] = store.getSnapshot().runs;
    expect(run.id).toBe(42);
    expect(run.jobs).toHaveLength(1);

    // The real workflow_run event lands moments later and corrects the stub
    // in place, without dropping the job already recorded against it.
    store.upsertRun('org/repo', makeRun({ id: 42, workflowName: 'Real Name', category: 'deploy' }));
    const [corrected] = store.getSnapshot().runs;
    expect(corrected.workflowName).toBe('Real Name');
    expect(corrected.category).toBe('deploy');
    expect(corrected.jobs).toHaveLength(1);
  });

  it('evicts the oldest runs once a repo exceeds the cap', () => {
    const store = new StateStore();
    for (let i = 1; i <= 25; i++) {
      store.upsertRun(
        'org/repo',
        makeRun({ id: i, updatedAt: new Date(2026, 0, i).toISOString() }),
      );
    }
    const snapshot = store.getSnapshot();
    expect(snapshot.runs.length).toBeLessThanOrEqual(20);
    // Oldest (id 1..5) should have been evicted; newest (id 25) survives.
    expect(snapshot.runs.some((r) => r.id === 25)).toBe(true);
    expect(snapshot.runs.some((r) => r.id === 1)).toBe(false);
  });

  it('filters snapshots by view, repo, and search query', () => {
    const store = new StateStore();
    store.upsertRun('org/api', makeRun({ id: 1, category: 'deploy' }));
    store.upsertRun('org/api', makeRun({ id: 2, category: 'pipeline' }));
    store.upsertRun('org/worker', makeRun({ id: 3, category: 'deploy' }));

    expect(
      store
        .getSnapshot({ view: 'deploys' })
        .runs.map((r) => r.id)
        .sort(),
    ).toEqual([1, 3]);
    expect(store.getSnapshot({ view: 'pipelines' }).runs.map((r) => r.id)).toEqual([2]);
    expect(store.getSnapshot({ repo: 'org/worker' }).runs.map((r) => r.id)).toEqual([3]);
    expect(store.getSnapshot({ q: 'wor' }).runs.map((r) => r.id)).toEqual([3]);
  });

  it('sorts snapshot runs by most recently updated first', () => {
    const store = new StateStore();
    store.upsertRun('org/repo', makeRun({ id: 1, updatedAt: '2026-01-01T00:00:00.000Z' }));
    store.upsertRun('org/repo', makeRun({ id: 2, updatedAt: '2026-01-02T00:00:00.000Z' }));
    expect(store.getSnapshot().runs.map((r) => r.id)).toEqual([2, 1]);
  });
});
