import { fileURLToPath } from 'node:url';
import { ApplicationFunction } from 'probot';
import { createApiApp } from './api/routes.js';
import { loadConfig } from './config/overrides.js';
import { runReconciliation } from './core/reconcile.js';
import { StateStore } from './core/state.js';
import { handleWorkflowJob } from './handlers/workflowJob.js';
import { handleWorkflowRun } from './handlers/workflowRun.js';
import {
  handleInstallationCreated,
  handleInstallationDeleted,
  handleInstallationRepositoriesAdded,
  handleInstallationRepositoriesRemoved,
} from './handlers/installation.js';

/** Safety-net cadence — webhooks are the primary update path, this only
 * exists to catch deliveries GitHub failed to send. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

const app: ApplicationFunction = (probotApp, { addHandler }) => {
  const state = new StateStore();
  const config = loadConfig(process.env.CONVOY_CONFIG_PATH ?? './convoy.yaml');

  probotApp.on('workflow_run', handleWorkflowRun(state, config));
  probotApp.on('workflow_job', handleWorkflowJob(state, config));
  probotApp.on('installation.created', handleInstallationCreated(state));
  probotApp.on('installation.deleted', handleInstallationDeleted(state));
  probotApp.on('installation_repositories.added', handleInstallationRepositoriesAdded(state));
  probotApp.on('installation_repositories.removed', handleInstallationRepositoriesRemoved(state));

  let lastReconciledAt: string | null = null;
  let installationCount = 0;

  async function reconcileAll(): Promise<void> {
    try {
      const appClient = await probotApp.auth();
      const installations = await appClient.paginate<{ id: number }>('GET /app/installations');
      installationCount = installations.length;

      for (const installation of installations) {
        const client = await probotApp.auth(installation.id);
        const result = await runReconciliation(client, state, config);
        if (result.aborted) {
          probotApp.log.warn(
            { installationId: installation.id },
            'reconciliation stopped early: rate limit running low',
          );
        }
      }
      lastReconciledAt = new Date().toISOString();
    } catch (err) {
      probotApp.log.error({ err }, 'reconciliation pass failed');
    }
  }

  // Run once immediately so a fresh boot isn't a blank dashboard while
  // waiting for the first timer tick, then keep it as a background safety net.
  void reconcileAll();
  setInterval(() => void reconcileAll(), RECONCILE_INTERVAL_MS);

  const apiApp = createApiApp(state, {
    publicDir,
    apiKey: process.env.CONVOY_API_KEY,
    getHealthInfo: () => ({ installationCount, lastReconciledAt }),
  });

  addHandler((req, res) => {
    apiApp(req, res);
    return true;
  });
};

export default app;
