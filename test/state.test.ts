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
      // Distinct workflow names so eviction (a storage concern) is being
      // tested independently of the display-time dedup-by-workflow below.
      store.upsertRun(
        'org/repo',
        makeRun({
          id: i,
          workflowName: `Workflow ${i}`,
          updatedAt: new Date(2026, 0, i).toISOString(),
        }),
      );
    }
    const snapshot = store.getSnapshot();
    expect(snapshot.runs.length).toBeLessThanOrEqual(20);
    // Oldest (id 1..5) should have been evicted; newest (id 25) survives.
    expect(snapshot.runs.some((r) => r.id === 25)).toBe(true);
    expect(snapshot.runs.some((r) => r.id === 1)).toBe(false);
  });

  it('collapses repeated runs of the same workflow down to just the latest', () => {
    // e.g. several merges into qa firing the same CI workflow back to back —
    // the board should show one card, not one per run.
    const store = new StateStore();
    store.upsertRun(
      'org/repo',
      makeRun({
        id: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'completed',
        conclusion: 'failure',
      }),
    );
    store.upsertRun(
      'org/repo',
      makeRun({
        id: 2,
        updatedAt: '2026-01-01T00:05:00.000Z',
        status: 'completed',
        conclusion: 'failure',
      }),
    );
    store.upsertRun(
      'org/repo',
      makeRun({
        id: 3,
        updatedAt: '2026-01-01T00:10:00.000Z',
        status: 'completed',
        conclusion: 'success',
      }),
    );

    const snapshot = store.getSnapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0].id).toBe(3);
    expect(snapshot.runs[0].conclusion).toBe('success');
  });

  it('keeps two distinct workflows on the same repo as separate cards', () => {
    const store = new StateStore();
    store.upsertRun('org/repo', makeRun({ id: 1, workflowName: 'CI' }));
    store.upsertRun('org/repo', makeRun({ id: 2, workflowName: 'Deploy' }));
    expect(store.getSnapshot().runs).toHaveLength(2);
  });

  it('does not collapse the same workflow running on two different branches', () => {
    // Real-world setups often trigger one workflow (e.g. "Containerize and
    // Deploy") from many branches — qa and sandbox finishing minutes apart
    // must not collapse into a single card, or one environment silently
    // disappears from the board.
    const store = new StateStore();
    store.upsertRun(
      'org/repo',
      makeRun({ id: 1, workflowName: 'Containerize and Deploy', headBranch: 'qa' }),
    );
    store.upsertRun(
      'org/repo',
      makeRun({ id: 2, workflowName: 'Containerize and Deploy', headBranch: 'sandbox' }),
    );
    expect(
      store
        .getSnapshot()
        .runs.map((r) => r.headBranch)
        .sort(),
    ).toEqual(['qa', 'sandbox']);
  });

  it('excludes runs older than maxAgeHours only when explicitly asked', () => {
    const store = new StateStore();
    const old = new Date(Date.now() - 72 * 3600_000).toISOString();
    const recent = new Date().toISOString();
    store.upsertRun('org/quiet', makeRun({ id: 1, workflowName: 'CI', updatedAt: old }));
    store.upsertRun('org/active', makeRun({ id: 2, workflowName: 'CI', updatedAt: recent }));

    // Default: nothing is hidden — a quiet repo still shows its last known state.
    expect(store.getSnapshot().runs).toHaveLength(2);

    // Opt-in filtering (the frontend's "hide inactive" toggle) drops it.
    const filtered = store.getSnapshot({ maxAgeHours: 48 });
    expect(filtered.runs.map((r) => r.repo)).toEqual(['org/active']);
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

  it('matches the search query against the ref/tag too, not just repo name', () => {
    // Lets someone scope the board down to one release the way the old
    // paste-a-list tool did, just by typing the tag instead of a repo name.
    const store = new StateStore();
    store.upsertRun('org/api', makeRun({ id: 1, headBranch: 'v3.4.0' }));
    store.upsertRun('org/worker', makeRun({ id: 2, headBranch: 'v3.4.0' }));
    store.upsertRun('org/other', makeRun({ id: 3, headBranch: 'main' }));

    expect(
      store
        .getSnapshot({ q: 'v3.4.0' })
        .runs.map((r) => r.id)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('sorts snapshot runs by most recently updated first', () => {
    const store = new StateStore();
    store.upsertRun(
      'org/repo',
      makeRun({ id: 1, workflowName: 'CI', updatedAt: '2026-01-01T00:00:00.000Z' }),
    );
    store.upsertRun(
      'org/repo',
      makeRun({ id: 2, workflowName: 'Deploy', updatedAt: '2026-01-02T00:00:00.000Z' }),
    );
    expect(store.getSnapshot().runs.map((r) => r.id)).toEqual([2, 1]);
  });
});
