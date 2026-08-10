/**
 * Standalone demo server — seeds fake data and serves the real frontend
 * against it, so anyone can see Convoy working without registering a GitHub
 * App first. Deliberately does NOT import Probot or touch the network: this
 * is a separate entry point on purpose, so demo data can never leak into a
 * real run and a real run never depends on anything defined here.
 */
import { fileURLToPath } from 'node:url';
import { createApiApp } from './api/routes.js';
import { JobState } from './core/types.js';
import { RunUpsertInput, StateStore } from './core/state.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const state = new StateStore();

let nextId = 1;
function seedRun(
  repo: string,
  overrides: Partial<RunUpsertInput> = {},
  jobs: JobState[] = [],
): number {
  const id = nextId++;
  const now = Date.now();
  state.upsertRepo({ id, fullName: repo, private: true, defaultBranch: 'main' });
  state.upsertRun(repo, {
    id,
    runNumber: id,
    workflowName: 'Containerize and Deploy',
    event: 'push',
    headBranch: 'main',
    headSha: 'abc123',
    status: 'completed',
    conclusion: 'success',
    createdAt: new Date(now - 300_000).toISOString(),
    updatedAt: new Date(now - 30_000).toISOString(),
    htmlUrl: `https://github.com/${repo}/actions/runs/${id}`,
    actor: 'octocat',
    category: 'pipeline',
    ...overrides,
  });
  for (const job of jobs) state.upsertJob(repo, id, job);
  return id;
}

function job(
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  startedSecAgo: number,
  completedSecAgo: number | null,
): JobState {
  const now = Date.now();
  return {
    id,
    name,
    status,
    conclusion,
    startedAt: new Date(now - startedSecAgo * 1000).toISOString(),
    completedAt:
      completedSecAgo == null ? null : new Date(now - completedSecAgo * 1000).toISOString(),
    htmlUrl: null,
  };
}

// --- Deploys ---
seedRun(
  'acme-corp/auth0-system-api',
  { headBranch: 'v1.4.23', category: 'deploy', status: 'completed', conclusion: 'success' },
  [
    job(1, 'build', 'completed', 'success', 240, 180),
    job(2, 'deploy', 'completed', 'success', 180, 30),
  ],
);
seedRun(
  'acme-corp/payments-core',
  { headBranch: 'v1.4.23', category: 'deploy', status: 'completed', conclusion: 'failure' },
  [job(3, 'test', 'completed', 'failure', 120, 60)],
);
const rollingDeployId = seedRun(
  'acme-corp/ledger-worker',
  { headBranch: 'v1.4.23', category: 'deploy', status: 'in_progress', conclusion: null },
  [
    job(4, 'build', 'completed', 'success', 90, 50),
    job(5, 'deploy', 'in_progress', null, 50, null),
  ],
);
seedRun('acme-corp/batch-jobs', {
  headBranch: 'v1.4.22-hotfix',
  category: 'deploy',
  status: 'completed',
  conclusion: 'cancelled',
});

// --- Pipelines ---
seedRun(
  'acme-corp/kyc-worker',
  { headBranch: 'qa', status: 'in_progress', conclusion: null, actor: 'grace' },
  [job(6, 'build', 'in_progress', null, 20, null)],
);
seedRun('acme-corp/notify-svc', {
  event: 'pull_request',
  headBranch: 'bugfix/POS-5975',
  status: 'queued',
  conclusion: null,
  actor: 'marco',
});
seedRun(
  'acme-corp/risk-engine',
  { headBranch: 'main', status: 'completed', conclusion: 'success', actor: 'alex' },
  [
    job(7, 'build', 'completed', 'success', 200, 150),
    job(8, 'test', 'completed', 'success', 150, 60),
  ],
);
seedRun('acme-corp/web-app', {
  headBranch: 'feature/new-dashboard',
  status: 'completed',
  conclusion: 'skipped',
  actor: 'priya',
});

// Installed but nothing has run in this view yet -- e.g. a repo the App
// watches that has no release tags, so it never shows up on Deploys. Never
// hidden: still gets a card, just an empty one.
state.upsertRepo({
  id: nextId++,
  fullName: 'acme-corp/legacy-billing',
  private: true,
  defaultBranch: 'main',
});

// A gentle heartbeat so the demo actually looks "live": the rolling deploy
// eventually lands, then a fresh one kicks off a bit later. Loops forever.
let phase: 'rolling' | 'landed' | 'restarting' = 'rolling';
setInterval(() => {
  if (phase === 'rolling') {
    state.upsertJob(
      'acme-corp/ledger-worker',
      rollingDeployId,
      job(5, 'deploy', 'completed', 'success', 50, 0),
    );
    state.upsertRun('acme-corp/ledger-worker', {
      id: rollingDeployId,
      runNumber: rollingDeployId,
      workflowName: 'Containerize and Deploy',
      event: 'push',
      headBranch: 'v1.4.23',
      headSha: 'abc123',
      status: 'completed',
      conclusion: 'success',
      createdAt: new Date(Date.now() - 90_000).toISOString(),
      updatedAt: new Date().toISOString(),
      htmlUrl: `https://github.com/acme-corp/ledger-worker/actions/runs/${rollingDeployId}`,
      actor: 'octocat',
      category: 'deploy',
    });
    phase = 'landed';
  } else if (phase === 'landed') {
    phase = 'restarting';
  } else {
    seedRun(
      'acme-corp/ledger-worker',
      { headBranch: 'v1.4.24', category: 'deploy', status: 'in_progress', conclusion: null },
      [job(100 + nextId, 'build', 'in_progress', null, 5, null)],
    );
    phase = 'rolling';
  }
}, 20_000);

const app = createApiApp(state, {
  publicDir,
  getHealthInfo: () => ({ installationCount: 0, lastReconciledAt: null }),
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Convoy demo running at http://localhost:${port} (fake data, no GitHub App needed)`);
});
