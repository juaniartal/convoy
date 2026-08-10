import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApiApp } from '../src/api/routes.js';
import { StateStore } from '../src/core/state.js';

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

describe('createApiApp with an apiKey set', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApiApp(new StateStore(), {
      publicDir: process.cwd(),
      apiKey: 'secret123',
      getHealthInfo: () => ({ installationCount: 0, lastReconciledAt: null }),
    });
    ({ server, baseUrl } = await listen(app));
  });

  afterAll(() => {
    server.close();
  });

  it('rejects a request with no credentials, prompting for Basic auth', async () => {
    const res = await fetch(`${baseUrl}/api/healthz`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('accepts a matching Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/healthz`, {
      headers: { Authorization: 'Bearer secret123' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/healthz`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts Basic auth with the key as the password, any username', async () => {
    const creds = Buffer.from('anyone:secret123').toString('base64');
    const res = await fetch(`${baseUrl}/api/healthz`, {
      headers: { Authorization: `Basic ${creds}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects Basic auth with the wrong password', async () => {
    const creds = Buffer.from('anyone:wrong').toString('base64');
    const res = await fetch(`${baseUrl}/api/healthz`, {
      headers: { Authorization: `Basic ${creds}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('createApiApp with no apiKey', () => {
  it('allows requests through with no Authorization header at all', async () => {
    const app = createApiApp(new StateStore(), {
      publicDir: process.cwd(),
      getHealthInfo: () => ({ installationCount: 0, lastReconciledAt: null }),
    });
    const { server, baseUrl } = await listen(app);
    const res = await fetch(`${baseUrl}/api/healthz`);
    server.close();
    expect(res.status).toBe(200);
  });
});
