import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import express, { Express, NextFunction, Request, Response } from 'express';
import { StateStore } from '../core/state.js';
import { OidcClient } from './oidc.js';
import { SESSION_COOKIE, SessionStore } from './session.js';

const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 10;

/** Longest a connected tab waits to hear about a change that arrived while a
 * burst was already in flight. Short enough that nobody watching a deploy can
 * tell the difference from an instant push, long enough that a whole
 * reconciliation pass collapses into a handful of refetches instead of one
 * per run and job. */
const EVENT_COALESCE_MS = 300;

/** How many distinct filter combinations keep a built response around. The
 * `q` parameter changes on every keystroke in the search box, so this has to
 * be bounded; a dozen covers everyone watching the same board through the
 * usual handful of tabs and filters, which is what this cache is for. */
const MAX_CACHED_RESPONSES = 12;

interface CachedResponse {
  version: number;
  body: string;
  /** Built on first request from a client that accepts gzip, then reused --
   * compressing a 2MB board is worth doing once per change, never once per
   * viewer. */
  gzipped: Buffer | null;
}

/** Below this, compression costs more than the bytes it saves. */
const GZIP_MIN_BYTES = 1024;

/**
 * One built response per (filter, state version), shared by every viewer.
 *
 * Without this, the cost of the dashboard scales with how many people have it
 * open: each request walks every repo and run, copies each one, sorts, and
 * serializes -- measured at ~6ms and ~2MB for 100 repos, so three people
 * watching a release cost three times that, on a single-threaded process,
 * during the minutes it's least affordable. The board is identical for all of
 * them, so it's built once and handed to everyone.
 *
 * Correctness comes from the version counter, not a timer: any mutation bumps
 * it, which retires every cached entry. A viewer can never be served state
 * older than the last thing that happened.
 */
function createResponseCache(state: StateStore) {
  const entries = new Map<string, CachedResponse>();

  return {
    /** The built JSON, plus a tag identifying exactly which state it
     * reflects -- so a viewer polling an unchanged board gets a 304 and no
     * body at all, instead of the same payload it already has. */
    get(
      key: string,
      build: () => unknown,
      wantsGzip: boolean,
    ): { body: string | Buffer; gzipped: boolean; etag: string } {
      const version = state.version;
      let entry = entries.get(key);

      if (!entry || entry.version !== version) {
        entry = { version, body: JSON.stringify(build()), gzipped: null };
        // Delete before set so a refreshed key moves to the end of the Map's
        // insertion order, making the eviction below drop the least recently
        // built entry rather than an actively used one.
        entries.delete(key);
        entries.set(key, entry);
        if (entries.size > MAX_CACHED_RESPONSES) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
      }

      if (wantsGzip && entry.body.length >= GZIP_MIN_BYTES) {
        entry.gzipped ??= gzipSync(entry.body);
        return { body: entry.gzipped, gzipped: true, etag: etagFor(version, key) };
      }
      return { body: entry.body, gzipped: false, etag: etagFor(version, key) };
    },
  };
}

/**
 * One subscription to state for the whole process, fanned out to however many
 * tabs are connected.
 *
 * The alternative -- a listener and a timer per connection -- makes the
 * server's own bookkeeping scale with the audience, which is backwards for a
 * board whose whole job is being watched by a room full of people during a
 * release. Here, a burst of mutations costs one coalescing timer and one
 * decision no matter whether one person or twenty have it open; all that
 * grows is the socket writes themselves.
 */
function createEventBroadcaster(state: StateStore) {
  const clients = new Set<Response>();
  let pendingChange = false;
  let coalesceTimer: ReturnType<typeof setInterval> | null = null;

  const flush = (): void => {
    pendingChange = false;
    for (const client of clients) client.write('data: change\n\n');
  };

  // Leading edge, then at most one ping per window. An isolated change -- the
  // common case, one webhook arriving -- still goes out the instant it
  // happens; the timer only exists while changes keep arriving, and stops
  // itself on the first quiet window.
  state.on('change', () => {
    if (clients.size === 0) return;
    pendingChange = true;
    if (coalesceTimer) return;
    flush();
    coalesceTimer = setInterval(() => {
      if (pendingChange) {
        flush();
        return;
      }
      clearInterval(coalesceTimer as ReturnType<typeof setInterval>);
      coalesceTimer = null;
    }, EVENT_COALESCE_MS);
  });

  return {
    add(res: Response): void {
      clients.add(res);
    },
    remove(res: Response): void {
      clients.delete(res);
    },
  };
}

/**
 * Whether the client already holds this exact version of the board.
 *
 * Deliberately not Express's `req.fresh`: that treats a request carrying
 * `Cache-Control: no-cache` as "send the whole body", which is right for a
 * caching proxy in the middle and wrong here. This *is* the origin, and a 304
 * is precisely what revalidating with the origin is supposed to produce.
 * Node's own fetch attaches that header to every conditional request, so
 * relying on `req.fresh` silently costs a full payload on each poll.
 */
function isNotModified(req: Request, etag: string): boolean {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  return header
    .split(',')
    .map((token) => token.trim())
    .some((token) => token === '*' || token === etag);
}

/** A filter key can hold anything someone typed into the search box, and an
 * ETag header is a quoted string -- so the key is folded into a short hex
 * hash (FNV-1a) rather than embedded raw. */
function etagFor(version: number, key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `W/"${version}-${hash.toString(16)}"`;
}

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

  /** Entries are otherwise only cleaned up lazily, when *that same* key is
   * queried again after expiring -- an IP that fails once and never comes
   * back (a scanner, a one-off typo from someone who then succeeded a
   * different way) would sit here forever on a long-lived process
   * otherwise. Convoy is meant to stay running indefinitely, not restart
   * on a schedule, so this can't rely on a restart to reclaim it. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.attempts) {
      if (entry.resetAt < now) this.attempts.delete(key);
    }
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

  const cache = createResponseCache(state);
  const broadcaster = createEventBroadcaster(state);

  /**
   * Serves a JSON response built once and shared by every viewer.
   *
   * Three things keep the cost of an extra pair of eyes at roughly zero: the
   * board is built once per change rather than once per request, it's
   * compressed once, and a viewer whose copy is already current gets a 304
   * with no body instead of the payload again -- which is what the 30-second
   * safety-net poll in every open tab does most of the time.
   */
  function sendCached(req: Request, res: Response, key: string, build: () => unknown): void {
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const { body, gzipped, etag } = cache.get(key, build, wantsGzip);

    res.set('ETag', etag);
    // Whether a cache may reuse this response depends on the request's
    // Accept-Encoding, since the same URL can answer with either form.
    res.set('Vary', 'Accept-Encoding');
    // Store it, but never reuse it without asking first. A board on a screen
    // during a deploy showing something a browser decided was still fresh
    // would be worse than any amount of bandwidth saved -- and asking is
    // cheap, since the answer is usually 304 with no body.
    res.set('Cache-Control', 'no-cache');
    res.type('application/json');

    if (isNotModified(req, etag)) {
      res.status(304).end();
      return;
    }

    if (gzipped) res.set('Content-Encoding', 'gzip');
    res.send(body);
  }

  // Registered before the auth gate on purpose: Kubernetes' own liveness/
  // readiness probes hit this with no credentials, and health status isn't
  // sensitive (no repo/run data) -- gating it would make an apiKey-protected
  // deployment permanently unhealthy in the eyes of its own orchestrator.
  app.get('/api/healthz', (_req, res) => {
    res.json({ status: 'ok', ...options.getHealthInfo() });
  });

  const sessions = new SessionStore();
  const loginLimiter = new LoginRateLimiter();
  const sweepInterval = setInterval(() => loginLimiter.sweep(), LOGIN_RATE_WINDOW_MS * 2);
  sweepInterval.unref();
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
    sendCached(req, res, `state|${view ?? ''}|${repo ?? ''}|${q ?? ''}|${maxAgeHours ?? ''}`, () =>
      state.getSnapshot({ view, repo, q, maxAgeHours }),
    );
  });

  app.get('/api/repos', (req, res) => {
    sendCached(req, res, 'repos', () => ({
      repos: state.listRepos().map((r) => ({
        fullName: r.fullName,
        private: r.private,
        runCount: r.runs.size,
        lastReconciledAt: r.lastReconciledAt,
      })),
    }));
  });

  // Push, not poll: tells connected tabs the instant a webhook changes
  // something, instead of making them wait for their next 30s safety-net
  // poll. Only ever sends a "something changed, go refetch" ping -- the
  // actual data still comes from /api/state, so there's one source of
  // truth for the shape of a run instead of two.
  //
  // Coalesced, because a ping is never free on the client: every one of them
  // makes every connected tab refetch the whole board. State emits 'change'
  // per mutation -- per run, per job -- so one reconciliation pass or one
  // release wave is hundreds of emissions within seconds, and five tabs open
  // during a deploy turn that into hundreds of requests this single-threaded
  // process serves to itself, exactly when people are watching. Batching them
  // costs nothing that matters: the first change still goes out immediately,
  // and a burst is worth one refetch, not four hundred.
  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    broadcaster.add(res);

    // Without a periodic write, an idle connection gets silently dropped by
    // most proxies/load balancers after their own timeout (often ~60s).
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      broadcaster.remove(res);
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
