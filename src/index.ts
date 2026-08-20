import { fileURLToPath } from 'node:url';
import { ApplicationFunction, Context } from 'probot';
import { createApiApp } from './api/routes.js';
import { loadOidcSettings, OidcClient } from './api/oidc.js';
import { loadConfig } from './config/overrides.js';
import { watchActiveRuns } from './core/activeRunWatcher.js';
import { classifyRun } from './core/classify.js';
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

/** How often to re-check runs still in progress, independent of the slower
 * reconciliation sweep above. Confirmed directly against a real
 * installation: GitHub can and does drop a `completed` webhook under
 * bursty load, and without this a run would sit showing "rolling" for up
 * to the full 5 minutes even though it finished ages ago. This costs
 * nothing when nothing's active (reads local state, no API call), and one
 * cheap single-run request per active run otherwise -- see
 * activeRunWatcher.ts for the exact rate-limit accounting. */
const ACTIVE_RUN_POLL_INTERVAL_MS = 30 * 1000;

/** The gap this closes: a release wave firing across many repos at once,
 * where GitHub drops most of the individual `requested` webhooks (seen
 * directly, not theoretical -- roughly 30-45% missing in bursts against a
 * real installation). Convoy has no way to know a run exists until *some*
 * webhook for it arrives, or reconciliation finds it -- so whichever
 * webhook DOES get through now kicks off an immediate full sweep instead
 * of waiting up to 5 minutes, and the rest of the wave shows up within
 * seconds instead of minutes. The cooldown stops the other 29 webhooks in
 * the same burst from each triggering their own redundant sweep. */
const DEPLOY_TRIGGER_COOLDOWN_MS = 20 * 1000;

/** How long after the immediate sweep to run a follow-up one. Confirmed
 * directly: GitHub itself can take a few seconds to finish creating
 * workflow runs across a large simultaneous batch, so a sweep that fires
 * within ~1 second of the first webhook can genuinely find nothing yet for
 * repos GitHub hasn't gotten to. */
const DEPLOY_TRIGGER_FOLLOWUP_DELAY_MS = 15 * 1000;

/** Every restart starts from empty in-memory state (no database), so the
 * very first reconciliation pass needs a much wider window than the
 * ongoing safety net does — otherwise a repo that last ran more than
 * reconcile.ts's default 2h lookback ago would show as if it never ran at
 * all, until something happens to touch it again. Matches the frontend's
 * own "stale after 48h" threshold, so nothing the UI would still show
 * (muted) is invisible to the backend that feeds it. */
const BOOT_LOOKBACK_HOURS = 48;

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

const app: ApplicationFunction = async (probotApp, { addHandler }) => {
  const oidcSettings = loadOidcSettings(process.env);
  // Neither gate configured: the dashboard has no login of its own (same
  // tradeoff Prometheus makes without an auth proxy in front). Someone
  // deploying without either one deserves a nudge before they find out the
  // hard way that the dashboard is wide open.
  if (!process.env.CONVOY_API_KEY && !oidcSettings) {
    probotApp.log.warn(
      'Neither CONVOY_API_KEY nor CONVOY_OIDC_* are set — the dashboard has no access control of its own. ' +
        'Do not expose it directly to the public internet without an authenticating proxy, VPN, or SSO in front. See the README\'s "Access control" section.',
    );
  }

  let oidc: OidcClient | undefined;
  if (oidcSettings) {
    try {
      oidc = await OidcClient.create(oidcSettings);
    } catch (err) {
      probotApp.log.error(
        { err },
        'failed to set up OIDC login — check CONVOY_OIDC_ISSUER_URL and that the discovery document is reachable. ' +
          'Falling back to CONVOY_API_KEY only, if set.',
      );
    }
  }

  const state = new StateStore();
  const config = loadConfig(process.env.CONVOY_CONFIG_PATH ?? './convoy.yaml');

  // Tracked separately from lastReconciledAt so /api/healthz can answer "is
  // GitHub actually reaching me right now" -- the one thing that determines
  // whether updates are instant or waiting on the next reconciliation pass,
  // and the one thing that's easy to get wrong (webhook URL pointing at a
  // different port/host than where this process is actually listening).
  let lastWebhookReceivedAt: string | null = null;
  function trackWebhook<Ctx>(handler: (ctx: Ctx) => unknown) {
    return (ctx: Ctx): unknown => {
      lastWebhookReceivedAt = new Date().toISOString();
      return handler(ctx);
    };
  }

  let lastDeployTriggeredReconcileAt = 0;
  const runWorkflowRunHandler = handleWorkflowRun(state, config);

  probotApp.on(
    'workflow_run',
    trackWebhook(async (context: Context<'workflow_run'>) => {
      await runWorkflowRunHandler(context);

      const run = context.payload.workflow_run;
      const override = config.overrides.get(context.payload.repository.full_name);
      const category = classifyRun(
        { event: run.event, headBranch: run.head_branch, workflowName: run.name ?? '' },
        override,
      );
      if (category !== 'deploy') return;

      const now = Date.now();
      if (now - lastDeployTriggeredReconcileAt < DEPLOY_TRIGGER_COOLDOWN_MS) return;
      lastDeployTriggeredReconcileAt = now;
      void reconcileAll();
      // Confirmed directly: GitHub can still be mid-creating the *other*
      // runs in the same simultaneous batch when this first sweep runs --
      // an immediate reconciliation can genuinely find nothing for a repo
      // whose run GitHub hadn't finished registering yet, not because of
      // any bug here. This follow-up catches whatever wasn't there yet the
      // first time, well before the next regular 5-minute pass would.
      setTimeout(() => void reconcileAll(), DEPLOY_TRIGGER_FOLLOWUP_DELAY_MS);
    }),
  );
  probotApp.on('workflow_job', trackWebhook(handleWorkflowJob(state, config)));
  probotApp.on('installation.created', trackWebhook(handleInstallationCreated(state)));
  probotApp.on('installation.deleted', trackWebhook(handleInstallationDeleted(state)));
  probotApp.on(
    'installation_repositories.added',
    trackWebhook(handleInstallationRepositoriesAdded(state)),
  );
  probotApp.on(
    'installation_repositories.removed',
    trackWebhook(handleInstallationRepositoriesRemoved(state)),
  );

  let lastReconciledAt: string | null = null;
  let installationCount = 0;

  async function reconcileAll(options: { lookbackHours?: number } = {}): Promise<void> {
    try {
      const appClient = await probotApp.auth();
      const installations = await appClient.paginate<{ id: number }>('GET /app/installations');
      installationCount = installations.length;

      for (const installation of installations) {
        const client = await probotApp.auth(installation.id);
        const result = await runReconciliation(client, state, config, {
          ...options,
          onRepoError: (repoFullName, err) => {
            probotApp.log.warn(
              { repoFullName, err },
              'reconciliation failed for this repo, will retry next pass',
            );
          },
        });
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

  async function watchAllActiveRuns(): Promise<void> {
    try {
      const appClient = await probotApp.auth();
      const installations = await appClient.paginate<{ id: number }>('GET /app/installations');
      for (const installation of installations) {
        const client = await probotApp.auth(installation.id);
        const result = await watchActiveRuns(client, state, config);
        if (result.aborted) {
          probotApp.log.warn(
            { installationId: installation.id },
            'active-run watcher stopped early: rate limit running low',
          );
        }
      }
    } catch (err) {
      probotApp.log.error({ err }, 'active-run watch tick failed');
    }
  }
  setInterval(() => void watchAllActiveRuns(), ACTIVE_RUN_POLL_INTERVAL_MS);

  const apiApp = createApiApp(state, {
    publicDir,
    apiKey: process.env.CONVOY_API_KEY,
    oidc,
    getHealthInfo: () => ({ installationCount, lastReconciledAt, lastWebhookReceivedAt }),
  });

  addHandler((req, res) => {
    apiApp(req, res);
    return true;
  });
};

export default app;
