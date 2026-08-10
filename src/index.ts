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

/** Every restart starts from empty in-memory state (no database), so the
 * very first reconciliation pass needs a much wider window than the
 * ongoing safety net does — otherwise a repo that last ran more than
 * reconcile.ts's default 2h lookback ago would show as if it never ran at
 * all, until something happens to touch it again. Matches the frontend's
 * own "stale after 48h" threshold, so nothing the UI would still show
 * (muted) is invisible to the backend that feeds it. */
const BOOT_LOOKBACK_HOURS = 48;

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

const app: ApplicationFunction = (probotApp, { addHandler }) => {
  // Convoy has no login of its own (same tradeoff Prometheus makes) --
  // CONVOY_API_KEY is the only built-in gate. Someone deploying without
  // either that or their own SSO/VPN in front deserves a nudge before they
  // find out the hard way that the dashboard is wide open.
  if (!process.env.CONVOY_API_KEY) {
    probotApp.log.warn(
      'CONVOY_API_KEY is not set — the dashboard has no access control of its own. ' +
        'Do not expose it directly to the public internet without an authenticating proxy, VPN, or SSO in front. See the README\'s "Access control" section.',
    );
  }

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

  async function reconcileAll(options: { lookbackHours?: number } = {}): Promise<void> {
    try {
      const appClient = await probotApp.auth();
      const installations = await appClient.paginate<{ id: number }>('GET /app/installations');
      installationCount = installations.length;

      for (const installation of installations) {
        const client = await probotApp.auth(installation.id);
        const result = await runReconciliation(client, state, config, options);
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
  // waiting for the first timer tick — with a wide lookback since state is
  // empty at this point. Later passes use reconcile.ts's narrower default;
  // they're a safety net for recent webhook misses, not repopulation.
  void reconcileAll({ lookbackHours: BOOT_LOOKBACK_HOURS });
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
