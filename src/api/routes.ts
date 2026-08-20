import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express, { Express, NextFunction, Request, Response } from 'express';
import { StateStore } from '../core/state.js';
import { OidcClient } from './oidc.js';
import { SESSION_COOKIE, SessionStore } from './session.js';

const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 10;

/** Bounds brute-force guessing of a weak CONVOY_API_KEY -- a strong random
 * key (the README recommends `openssl rand -base64 32`) doesn't need this,
 * but nothing stops someone from setting a short one, and there's no other
 * defense against unlimited guesses. */
class LoginRateLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  isBlocked(key: string): boolean {
    const entry = this.attempts.get(key);
    if (!entry) return false;
    if (entry.resetAt < Date.now()) {
      this.attempts.delete(key);
      return false;
    }
    return entry.count >= LOGIN_RATE_MAX_ATTEMPTS;
  }

  recordFailure(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt < Date.now()) {
      this.attempts.set(key, { count: 1, resetAt: Date.now() + LOGIN_RATE_WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}

/** Same length-independent compare either way: a naive `===` short-circuits
 * on the first differing byte, which in principle leaks how many leading
 * characters of a guess are correct via response timing. Comparing against
 * a same-length dummy on a length mismatch keeps that path constant-time
 * too, rather than returning early. */
function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface ApiAppOptions {
  publicDir: string;
  apiKey?: string;
  oidc?: OidcClient;
  /** For /api/healthz — surfaced for operators debugging a stuck deployment,
   * and for answering "is this instance actually getting live webhooks or
   * just running on the reconciliation safety net". */
  getHealthInfo: () => {
    installationCount: number;
    lastReconciledAt: string | null;
    lastWebhookReceivedAt: string | null;
  };
}

/**
 * The only HTTP surface Convoy exposes beyond the GitHub webhook endpoint
 * (which Probot mounts separately). Read-only by design — there are no
 * mutation routes in v1, aside from the login/logout pair below.
 */
export function createApiApp(state: StateStore, options: ApiAppOptions): Express {
  const app = express();
  // Without this, req.protocol/req.secure reflect the connection from the
  // ingress/reverse proxy (always http), not the browser's real scheme --
  // that would make secure cookies never get set in production.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));

  // Registered before the auth gate on purpose: Kubernetes' own liveness/
  // readiness probes hit this with no credentials, and health status isn't
  // sensitive (no repo/run data) -- gating it would make an apiKey-protected
  // deployment permanently unhealthy in the eyes of its own orchestrator.
  app.get('/api/healthz', (_req, res) => {
    res.json({ status: 'ok', ...options.getHealthInfo() });
  });

  const sessions = new SessionStore();
  const loginLimiter = new LoginRateLimiter();
  const authEnabled = Boolean(options.apiKey) || Boolean(options.oidc);

  // Auth endpoints and the handful of static assets the login page itself
  // needs stay reachable even when the gate below is active -- otherwise
  // the login page can't render (broken logo, no font) and there'd be no
  // way to ever pass the gate in the first place.
  app.get('/login', (_req, res) => {
    res.sendFile(path.join(options.publicDir, 'login.html'));
  });
  app.get('/login.js', (_req, res) => {
    res.sendFile(path.join(options.publicDir, 'login.js'));
  });
  app.get('/login-owl.png', (_req, res) => {
    res.sendFile(path.join(options.publicDir, 'login-owl.png'));
  });
  app.use('/fonts', express.static(path.join(options.publicDir, 'fonts')));

  app.get('/api/auth/config', (_req, res) => {
    res.json({
      passwordEnabled: Boolean(options.apiKey),
      oidc: options.oidc ? { label: options.oidc.settings.buttonLabel } : null,
    });
  });

  app.post('/api/login', (req, res) => {
    const rateKey = req.ip ?? 'unknown';
    if (loginLimiter.isBlocked(rateKey)) {
      res.status(429).json({ error: 'too many attempts, try again later' });
      return;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!options.apiKey || !secureCompare(password, options.apiKey)) {
      loginLimiter.recordFailure(rateKey);
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }
    loginLimiter.reset(rateKey);
    setSessionCookie(res, sessions.create(), req.secure);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    sessions.destroy(readSessionCookie(req));
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  if (options.oidc) {
    const oidc = options.oidc;

    app.get('/api/auth/oidc/start', async (_req, res) => {
      const authUrl = await oidc.buildAuthorizationUrl();
      res.redirect(authUrl.toString());
    });

    app.get('/api/auth/oidc/callback', async (req, res) => {
      const currentUrl = new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`);
      const ok = await oidc.handleCallback(currentUrl);
      if (!ok) {
        res
          .status(401)
          .send('SSO login failed — the link may have expired. Go back and try again.');
        return;
      }
      setSessionCookie(res, sessions.create(), req.secure);
      res.redirect('/');
    });
  }

  if (authEnabled) {
    app.use(requireAuth(sessions, options.apiKey));
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

function setSessionCookie(res: Response, sessionId: string, secure: boolean): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
}

function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Two ways in: a valid session cookie (browser, set by /api/login or the
 * OIDC callback), or a Bearer token matching apiKey (scripts, curl, a
 * reverse proxy). API routes that fail either get a plain 401 -- the
 * frontend redirects to /login itself on that. Document/navigation requests
 * get redirected straight there instead of showing a bare JSON error.
 */
function requireAuth(sessions: SessionStore, apiKey?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthorized(req, sessions, apiKey)) {
      next();
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.redirect('/login');
  };
}

function isAuthorized(req: Request, sessions: SessionStore, apiKey?: string): boolean {
  if (sessions.isValid(readSessionCookie(req))) return true;
  if (!apiKey) return false;
  const header = req.header('authorization') ?? '';
  const [scheme, credentials] = header.split(' ');
  return scheme === 'Bearer' && !!credentials && secureCompare(credentials, apiKey);
}
