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

  if (options.apiKey) {
    app.use(requireBearerToken(options.apiKey));
  }

  app.get('/api/healthz', (_req, res) => {
    res.json({ status: 'ok', ...options.getHealthInfo() });
  });

  app.get('/api/state', (req, res) => {
    const view = parseView(req.query.view);
    const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json(state.getSnapshot({ view, repo, q }));
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

  app.use(express.static(options.publicDir));

  return app;
}

function parseView(raw: unknown): 'deploys' | 'pipelines' | 'all' | undefined {
  return raw === 'deploys' || raw === 'pipelines' || raw === 'all' ? raw : undefined;
}

function requireBearerToken(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token === apiKey) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}
