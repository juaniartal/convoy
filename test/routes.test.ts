import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApiApp } from '../src/api/routes.js';
import { StateStore } from '../src/core/state.js';
import type { OidcClient } from '../src/api/oidc.js';

// The real public/ dir, not process.cwd() -- /login serves login.html via
// res.sendFile, which needs an actual file on disk to exist.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));

function listen(
  app: ReturnType<typeof createApiApp>,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (typeof address !== 'object' || address == null) throw new Error('server has no address');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** Extracts the session cookie's "name=value" pair from a Set-Cookie header,
 * dropping the attributes (HttpOnly, Path, etc.) -- that's all `fetch`'s
 * Cookie header needs to send it back on the next request. */
function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no Set-Cookie header in response');
  return setCookie.split(';')[0];
}

describe('createApiApp with an apiKey set', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApiApp(new StateStore(), {
      publicDir,
      apiKey: 'secret123',
      getHealthInfo: () => ({
        installationCount: 0,
        lastReconciledAt: null,
        lastWebhookReceivedAt: null,
      }),
    });
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(() => {
    server.close();
  });

  // /api/healthz stays exempt even when an apiKey is set -- it's what
  // Kubernetes' own liveness/readiness probes hit with no credentials, and
  // it exposes no repo/run data, just "is the process up".
  it('never gates /api/healthz, even with an apiKey set', async () => {
    const res = await fetch(`${baseUrl}/api/healthz`);
    expect(res.status).toBe(200);
  });

  it('surfaces lastWebhookReceivedAt via /api/healthz, distinct from lastReconciledAt', async () => {
    const app = createApiApp(new StateStore(), {
      publicDir,
      getHealthInfo: () => ({
        installationCount: 1,
        lastReconciledAt: '2026-01-01T00:00:00.000Z',
        lastWebhookReceivedAt: '2026-01-01T00:05:00.000Z',
      }),
    });
    const { server, baseUrl: healthzBaseUrl } = await listen(app);
    const res = await fetch(`${healthzBaseUrl}/api/healthz`);
    expect(await res.json()).toEqual({
      status: 'ok',
      installationCount: 1,
      lastReconciledAt: '2026-01-01T00:00:00.000Z',
      lastWebhookReceivedAt: '2026-01-01T00:05:00.000Z',
    });
    server.close();
  });

  it('rejects an /api/* route with no credentials, as plain JSON', async () => {
    const res = await fetch(`${baseUrl}/api/repos`);
    expect(res.status).toBe(401);
  });

  it('redirects a document request with no session to /login', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('always leaves /login, /api/auth/config, and /api/login reachable', async () => {
    const login = await fetch(`${baseUrl}/login`);
    expect(login.status).toBe(200);
    const config = await fetch(`${baseUrl}/api/auth/config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({ passwordEnabled: true, oidc: null });
  });

  // Regression guard: these were briefly caught by the auth gate too, which
  // meant the login page itself couldn't render (broken logo, no font) --
  // a lockout with no way in.
  it("serves the login page's own assets (logo, font, script) without a session", async () => {
    const icon = await fetch(`${baseUrl}/login-owl.png`);
    expect(icon.status).toBe(200);
    const font = await fetch(`${baseUrl}/fonts/inter.woff2`);
    expect(font.status).toBe(200);
    const script = await fetch(`${baseUrl}/login.js`);
    expect(script.status).toBe(200);
  });

  it('accepts a matching Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      headers: { Authorization: 'Bearer secret123' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a login with the wrong password and sets no cookie', async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rate-limits repeated failed login attempts from the same client', async () => {
    const app = createApiApp(new StateStore(), {
      publicDir,
      apiKey: 'secret123',
      getHealthInfo: () => ({
        installationCount: 0,
        lastReconciledAt: null,
        lastWebhookReceivedAt: null,
      }),
    });
    const { server, baseUrl: rlBaseUrl } = await listen(app);

    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${rlBaseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);

    // Locked out applies even to the correct password, until the window resets.
    const correctRes = await fetch(`${rlBaseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret123' }),
    });
    expect(correctRes.status).toBe(429);

    server.close();
  });

  it('logs in with the right password, then the session cookie grants access', async () => {
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret123' }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookieFrom(loginRes);

    const reposRes = await fetch(`${baseUrl}/api/repos`, { headers: { Cookie: cookie } });
    expect(reposRes.status).toBe(200);

    const logoutRes = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);

    // Same cookie, but the session behind it is gone.
    const afterLogout = await fetch(`${baseUrl}/api/repos`, { headers: { Cookie: cookie } });
    expect(afterLogout.status).toBe(401);
  });
});

describe('createApiApp with OIDC configured', () => {
  let server: http.Server;
  let baseUrl: string;
  let lastCallbackState: string | undefined;

  const fakeOidc = {
    settings: { buttonLabel: 'Log in with Test IdP' },
    buildAuthorizationUrl: async () => new URL('https://idp.example.test/authorize?state=abc123'),
    handleCallback: async (url: URL) => {
      lastCallbackState = url.searchParams.get('state') ?? undefined;
      return url.searchParams.get('state') === 'good-state';
    },
  } as unknown as OidcClient;

  beforeAll(async () => {
    const app = createApiApp(new StateStore(), {
      publicDir,
      oidc: fakeOidc,
      getHealthInfo: () => ({
        installationCount: 0,
        lastReconciledAt: null,
        lastWebhookReceivedAt: null,
      }),
    });
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(() => {
    server.close();
  });

  it('advertises the button label via /api/auth/config', async () => {
    const res = await fetch(`${baseUrl}/api/auth/config`);
    expect(await res.json()).toEqual({
      passwordEnabled: false,
      oidc: { label: 'Log in with Test IdP' },
    });
  });

  it('redirects /api/auth/oidc/start to the IdP authorization URL', async () => {
    const res = await fetch(`${baseUrl}/api/auth/oidc/start`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://idp.example.test/authorize?state=abc123');
  });

  it('rejects an invalid callback with 401 and sets no cookie', async () => {
    const res = await fetch(`${baseUrl}/api/auth/oidc/callback?state=bad-state&code=x`);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(lastCallbackState).toBe('bad-state');
  });

  it('grants a session and redirects home on a valid callback', async () => {
    const res = await fetch(`${baseUrl}/api/auth/oidc/callback?state=good-state&code=x`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookie = sessionCookieFrom(res);

    const reposRes = await fetch(`${baseUrl}/api/repos`, { headers: { Cookie: cookie } });
    expect(reposRes.status).toBe(200);
  });
});

describe('createApiApp SSE events endpoint', () => {
  it('pushes a change event to connected clients when state mutates', async () => {
    const state = new StateStore();
    const app = createApiApp(state, {
      publicDir,
      getHealthInfo: () => ({
        installationCount: 0,
        lastReconciledAt: null,
        lastWebhookReceivedAt: null,
      }),
    });
    const { server, baseUrl } = await listen(app);
    const controller = new AbortController();

    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    setTimeout(
      () => state.upsertRepo({ id: 1, fullName: 'org/repo', private: true, defaultBranch: 'main' }),
      20,
    );

    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('data: change');

    controller.abort();
    server.close();
  });

  // The failure this guards against isn't a wrong board, it's a slow one:
  // every ping makes every connected tab refetch everything, and state emits
  // 'change' per run and per job. Unbatched, one reconciliation pass over a
  // busy org is hundreds of pings within seconds -- multiplied by every tab
  // open during a release.
  it('collapses a burst of mutations into a small number of pings', async () => {
    const state = new StateStore();
    const app = createApiApp(state, {
      publicDir,
      getHealthInfo: () => ({
        installationCount: 0,
        lastReconciledAt: null,
        lastWebhookReceivedAt: null,
      }),
    });
    const { server, baseUrl } = await listen(app);
    const controller = new AbortController();

    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    // Stands in for a reconciliation pass: 200 mutations back to back, the
    // shape of upsertRun/upsertJob walking an org's worth of runs.
    for (let i = 0; i < 200; i++) {
      state.upsertRepo({ id: i, fullName: `org/repo-${i}`, private: true, defaultBranch: 'main' });
    }

    // One read is enough to prove the leading edge fired; the count below is
    // what proves the rest of the burst was collapsed rather than sent.
    const { value } = await reader.read();
    const pings = new TextDecoder().decode(value).match(/data: change/g) ?? [];
    expect(pings.length).toBe(1);

    controller.abort();
    server.close();
  });

  // The audience is the thing that must not multiply cost: a board watched by
  // five people during a release has to be the same work for the server as a
  // board watched by one.
  it('subscribes to state once no matter how many clients connect', async () => {
    const state = new StateStore();
    const before = state.listenerCount('change');
    const app = createApiApp(state, {
      publicDir,
      getHealthInfo: () => ({
        installationCount: 0,
        lastReconciledAt: null,
        lastWebhookReceivedAt: null,
      }),
    });
    const { server, baseUrl } = await listen(app);

    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    await Promise.all(controllers.map((c) => fetch(`${baseUrl}/api/events`, { signal: c.signal })));

    expect(state.listenerCount('change') - before).toBe(1);

    controllers.forEach((c) => c.abort());
    server.close();
  });
});

describe('createApiApp shared board', () => {
  function appWith(state: StateStore) {
    return createApiApp(state, {
      publicDir,
      getHealthInfo: () => ({
        installationCount: 0,
        lastReconciledAt: null,
        lastWebhookReceivedAt: null,
      }),
    });
  }

  function seed(state: StateStore, count: number): void {
    for (let i = 0; i < count; i++) {
      const full = `org/repo-${i}`;
      state.upsertRepo({ id: i, fullName: full, private: true, defaultBranch: 'main' });
      state.upsertRun(full, {
        id: i,
        runNumber: i,
        workflowName: 'deploy',
        event: 'push',
        headBranch: 'main',
        headSha: 'a'.repeat(40),
        status: 'completed',
        conclusion: 'success',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        htmlUrl: `https://github.com/${full}/actions/runs/${i}`,
        actor: { login: 'someone' },
        category: 'deploy',
      });
    }
  }

  it('builds the board once for many viewers, and again after a change', async () => {
    const state = new StateStore();
    seed(state, 5);
    const buildSpy = vi.spyOn(state, 'getSnapshot');
    const { server, baseUrl } = await listen(appWith(state));

    // Three people opening the same board.
    const bodies = await Promise.all(
      [1, 2, 3].map(async () => (await fetch(`${baseUrl}/api/state?view=all`)).text()),
    );
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(new Set(bodies).size).toBe(1); // everyone sees the identical board

    // A new run must retire it -- a cache that can serve stale state during a
    // deploy is worse than no cache at all.
    seed(state, 6);
    await fetch(`${baseUrl}/api/state?view=all`);
    expect(buildSpy).toHaveBeenCalledTimes(2);

    server.close();
  });

  it('answers an unchanged poll with 304 and no body', async () => {
    const state = new StateStore();
    seed(state, 3);
    const { server, baseUrl } = await listen(appWith(state));

    const first = await fetch(`${baseUrl}/api/state?view=all`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    // What every open tab's 30-second safety-net poll looks like when nothing
    // has happened since -- which is most polls, most of the time.
    const second = await fetch(`${baseUrl}/api/state?view=all`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');

    // ...and stops being fresh the moment something actually happens.
    seed(state, 4);
    const third = await fetch(`${baseUrl}/api/state?view=all`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(third.status).toBe(200);

    server.close();
  });

  it('compresses a large board once and serves it to everyone', async () => {
    const state = new StateStore();
    seed(state, 60); // comfortably past the compression threshold
    const { server, baseUrl } = await listen(appWith(state));

    const res = await fetch(`${baseUrl}/api/state?view=all`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    // fetch decompresses transparently -- the board still has to arrive whole.
    const parsed = (await res.json()) as { runs: unknown[] };
    expect(parsed.runs).toHaveLength(60);

    server.close();
  });
});

describe('createApiApp with no apiKey and no oidc', () => {
  it('allows requests through with no Authorization header or session at all', async () => {
    const app = createApiApp(new StateStore(), {
      publicDir,
      getHealthInfo: () => ({
        installationCount: 0,
        lastReconciledAt: null,
        lastWebhookReceivedAt: null,
      }),
    });
    const { server, baseUrl } = await listen(app);
    const res = await fetch(`${baseUrl}/api/repos`);
    server.close();
    expect(res.status).toBe(200);
  });
});
