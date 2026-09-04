import { EventEmitter } from 'node:events';
import { JobState, RepoState, RunSnapshot, RunState, StateSnapshot } from './types.js';

/**
 * How many recent runs to keep per repo. Convoy has no database in v1 — this
 * is a live status board, not a history tool — so state must stay bounded or
 * a long-running process would leak memory across weeks of runs.
 */
const MAX_RUNS_PER_REPO = 20;

export interface RepoIdentity {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export type RunUpsertInput = Omit<RunState, 'jobs'>;

export interface StateFilter {
  view?: 'deploys' | 'pipelines' | 'all';
  repo?: string;
  /** Matches against repo name OR the run's ref (branch/tag) — typing a
   * release tag during a deploy narrows the board to just that release,
   * the same way the personal single-file tool did with a pasted list. */
  q?: string;
  /** Drop runs whose last update is older than this many hours. A repo that
   * hasn't run anything recently should age out of the board on its own
   * rather than sit there forever as stale noise. */
  maxAgeHours?: number;
}

/**
 * In-memory pipeline state, populated by webhooks and corrected by periodic
 * reconciliation. Deliberately not persisted anywhere — restart clears it,
 * and reconciliation repopulates it within one pass.
 *
 * Also an EventEmitter: every mutation emits 'change' so the API layer can
 * push a live update to connected browsers (see api/routes.ts's SSE
 * endpoint) instead of making them wait for their next poll.
 */
export class StateStore extends EventEmitter {
  private repos = new Map<string, RepoState>();

  private _version = 0;

  /** Bumped on every mutation. Lets a caller tell "nothing has changed since
   * I last built this" without diffing anything -- the API layer uses it to
   * build one shared response for every connected viewer instead of one per
   * viewer (see api/routes.ts). */
  get version(): number {
    return this._version;
  }

  /** Every mutation goes through here instead of calling emit directly, so
   * the version counter can never drift out of step with the event. */
  private changed(): void {
    this._version++;
    this.emit('change');
  }

  constructor() {
    super();
    // The API layer subscribes exactly once and fans out to every connected
    // tab itself (see api/routes.ts's broadcaster), so this never grows with
    // the audience. The headroom over Node's default of 10 is for tests and
    // any future internal subscriber, not per-viewer listeners.
    this.setMaxListeners(20);
  }

  upsertRepo(identity: RepoIdentity): RepoState {
    const existing = this.repos.get(identity.fullName);
    if (existing) {
      existing.id = identity.id;
      existing.private = identity.private;
      existing.defaultBranch = identity.defaultBranch;
      this.changed();
      return existing;
    }
    const repo: RepoState = { ...identity, runs: new Map(), lastReconciledAt: null };
    this.repos.set(identity.fullName, repo);
    this.changed();
    return repo;
  }

  removeRepo(fullName: string): void {
    this.repos.delete(fullName);
    this.changed();
  }

  markReconciled(fullName: string, at: string): void {
    const repo = this.repos.get(fullName);
    if (repo) repo.lastReconciledAt = at;
  }

  getRepo(fullName: string): RepoState | undefined {
    return this.repos.get(fullName);
  }

  listRepos(): RepoState[] {
    return [...this.repos.values()];
  }

  /** Every run not yet in a terminal state -- what the fast active-run
   * watcher needs to know what to check, without an API call of its own
   * (this is purely a read of what's already in memory). Sorted oldest
   * updatedAt first, so if a tick can't check everything, it's the
   * longest-stale ones that get priority. */
  listActiveRuns(): Array<{ repoFullName: string; run: RunState }> {
    const active: Array<{ repoFullName: string; run: RunState }> = [];
    for (const repo of this.repos.values()) {
      for (const run of repo.runs.values()) {
        if (run.status !== 'completed') active.push({ repoFullName: repo.fullName, run });
      }
    }
    active.sort((a, b) => a.run.updatedAt.localeCompare(b.run.updatedAt));
    return active;
  }

  /** Creates a minimal placeholder repo entry so a run/job is never dropped
   * just because its parent repo hasn't been registered yet (e.g. a webhook
   * arriving before the first reconciliation pass completes at boot). */
  private ensureRepo(fullName: string): RepoState {
    return (
      this.repos.get(fullName) ??
      this.upsertRepo({ id: -1, fullName, private: true, defaultBranch: 'main' })
    );
  }

  upsertRun(repoFullName: string, data: RunUpsertInput): RunState {
    const repo = this.ensureRepo(repoFullName);
    const existing = repo.runs.get(data.id);
    const run: RunState = { ...data, jobs: existing?.jobs ?? new Map() };
    repo.runs.set(data.id, run);
    this.evictOldest(repo);
    this.changed();
    return run;
  }

  /** Job events can arrive before the workflow_run event that would normally
   * create the run (delivery order isn't guaranteed) — a stub run is created
   * if needed and gets corrected in place once the real event lands, since
   * upsertRun always preserves the jobs collected so far. */
  upsertJob(repoFullName: string, runId: number, job: JobState): void {
    const repo = this.ensureRepo(repoFullName);
    let run = repo.runs.get(runId);
    if (!run) {
      const now = new Date().toISOString();
      run = {
        id: runId,
        runNumber: 0,
        workflowName: 'unknown',
        event: 'unknown',
        headBranch: null,
        headSha: '',
        status: 'queued',
        conclusion: null,
        createdAt: now,
        updatedAt: now,
        htmlUrl: '',
        actor: null,
        category: 'pipeline',
        jobs: new Map(),
      };
      repo.runs.set(runId, run);
    }
    run.jobs.set(job.id, job);
    this.changed();
  }

  private evictOldest(repo: RepoState): void {
    if (repo.runs.size <= MAX_RUNS_PER_REPO) return;
    const sorted = [...repo.runs.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const run of sorted.slice(0, repo.runs.size - MAX_RUNS_PER_REPO)) {
      repo.runs.delete(run.id);
    }
  }

  getSnapshot(filter: StateFilter = {}): StateSnapshot {
    const view = filter.view ?? 'all';
    const q = filter.q?.toLowerCase().trim();
    const cutoff = filter.maxAgeHours != null ? Date.now() - filter.maxAgeHours * 3_600_000 : null;

    let runs: RunSnapshot[] = [];
    for (const repo of this.repos.values()) {
      if (filter.repo && repo.fullName !== filter.repo) continue;

      for (const run of repo.runs.values()) {
        if (view === 'deploys' && run.category !== 'deploy') continue;
        if (view === 'pipelines' && run.category !== 'pipeline') continue;
        if (cutoff != null && new Date(run.updatedAt).getTime() < cutoff) continue;
        if (q) {
          const matchesRepo = repo.fullName.toLowerCase().includes(q);
          const matchesRef = (run.headBranch ?? '').toLowerCase().includes(q);
          if (!matchesRepo && !matchesRef) continue;
        }
        const { jobs, ...rest } = run;
        runs.push({ ...rest, repo: repo.fullName, jobs: [...jobs.values()] });
      }
    }

    runs = dedupeByLatestPerWorkflow(runs);
    runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return { generatedAt: new Date().toISOString(), repoCount: this.repos.size, runs };
  }
}

/**
 * A board shows current state, not history. A repo re-running the same
 * workflow five times in an hour (a busy qa branch merging repeatedly)
 * should occupy one card, not five.
 *
 * Grouped by repo+workflow+ref+category, not just repo+workflow, because
 * plenty of setups trigger the same workflow name from several branches at
 * once (qa, sandbox, staging). Keying on the workflow name alone would
 * collapse "qa just finished" and "sandbox just finished" into one card and
 * silently drop one of them; the ref is what actually tells them apart.
 */
function dedupeByLatestPerWorkflow(runs: RunSnapshot[]): RunSnapshot[] {
  const latest = new Map<string, RunSnapshot>();
  for (const run of runs) {
    const key = `${run.repo}::${run.workflowName}::${run.headBranch}::${run.category}`;
    const existing = latest.get(key);
    if (!existing || run.updatedAt > existing.updatedAt) {
      latest.set(key, run);
    }
  }
  return [...latest.values()];
}
