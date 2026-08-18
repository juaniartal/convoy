import express, { Express, NextFunction, Request, Response } from 'express';
import { StateStore } from '../core/state.js';

export interface ApiAppOptions {
  publicDir: string;
  apiKey?: string;
  /** For /api/healthz — surfaced for operators debugging a stuck deployment. */
  getHealthInfo: () => { installationCount: number; lastReconciledAt: string | null };
}

/**
 * The only HTTP surface Convoy exposes beyond the GitHub webhook endpoint
 * (which Probot mounts separately). Read-only by design — there are no
 * mutation routes in v1.
 */
export function createApiApp(state: StateStore, options: ApiAppOptions): Express {
  const app = express();

  // Registered before the auth gate on purpose: Kubernetes' own liveness/
  // readiness probes hit this with no credentials, and health status isn't
  // sensitive (no repo/run data) -- gating it would make an apiKey-protected
  // deployment permanently unhealthy in the eyes of its own orchestrator.
  app.get('/api/healthz', (_req, res) => {
    res.json({ status: 'ok', ...options.getHealthInfo() });
  });

  if (options.apiKey) {
    app.use(requireAuth(options.apiKey));
  }

  app.get('/api/state', (req, res) => {
    const view = parseView(req.query.view);
    const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    // maxAgeHours is opt-in, not a default — a repo that's gone quiet still
    // belongs on the board with its last known state. Only filter it out
    // when the frontend's "hide inactive" toggle explicitly asks for it.
    const maxAgeHoursRaw = req.query.maxAgeHours;
    const maxAgeHours =
      typeof maxAgeHoursRaw === 'string' && Number.isFinite(Number(maxAgeHoursRaw))
        ? Number(maxAgeHoursRaw)
        : undefined;
    res.json(state.getSnapshot({ view, repo, q, maxAgeHours }));
  });

  app.get('/api/repos', (_req, res) => {
    const repos = state.listRepos().map((r) => ({
      fullName: r.fullName,
      private: r.private,
      runCount: r.runs.size,
      lastReconciledAt: r.lastReconciledAt,
    }));
    res.json({ repos });
  });

  // Push, not poll: tells connected tabs the instant a webhook changes
  // something, instead of making them wait for their next 30s safety-net
  // poll. Only ever sends a "something changed, go refetch" ping -- the
  // actual data still comes from /api/state, so there's one source of
  // truth for the shape of a run instead of two.
  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const onChange = (): void => {
      res.write('data: change\n\n');
    };
    state.on('change', onChange);

    // Without a periodic write, an idle connection gets silently dropped by
    // most proxies/load balancers after their own timeout (often ~60s).
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      state.off('change', onChange);
    });
  });

  app.use(express.static(options.publicDir));

  return app;
}

function parseView(raw: unknown): 'deploys' | 'pipelines' | 'all' | undefined {
  return raw === 'deploys' || raw === 'pipelines' || raw === 'all' ? raw : undefined;
}

/**
 * Accepts either scheme against the same shared secret:
 *  - Bearer <apiKey>, for scripts and reverse proxies (unchanged from before)
 *  - Basic <base64(anything:apiKey)>, so a plain browser tab gets a real,
 *    native login prompt (via WWW-Authenticate below) instead of a silent
 *    401 that only a script could ever get past. Convoy still doesn't have
 *    to build or maintain any login UI of its own.
 */
function requireAuth(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthorized(req, apiKey)) {
      next();
      return;
    }
    res.set('WWW-Authenticate', 'Basic realm="Convoy"');
    res.status(401).json({ error: 'unauthorized' });
  };
}

function isAuthorized(req: Request, apiKey: string): boolean {
  const header = req.header('authorization') ?? '';
  const [scheme, credentials] = header.split(' ');
  if (scheme === 'Bearer') return credentials === apiKey;
  if (scheme === 'Basic' && credentials) {
    const decoded = Buffer.from(credentials, 'base64').toString('utf8');
    // Basic Auth is "username:password" — the username is ignored on
    // purpose, there's only one shared secret, not per-user accounts.
    const password = decoded.slice(decoded.indexOf(':') + 1);
    return password === apiKey;
  }
  return false;
}
