import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import nock from 'nock';
import { loadOidcSettings, OidcClient } from '../src/api/oidc.js';

const ISSUER = 'https://idp.test.example';
const CLIENT_ID = 'convoy-test-client';
const CLIENT_SECRET = 'convoy-test-secret';
const REDIRECT_URI = 'https://convoy.example.com/api/auth/oidc/callback';
const KID = 'test-key-1';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signIdToken(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(data), privateKey);
  return `${data}.${base64url(signature)}`;
}

describe('loadOidcSettings', () => {
  it('is undefined unless all four required env vars are set', () => {
    expect(loadOidcSettings({})).toBeUndefined();
    expect(
      loadOidcSettings({
        CONVOY_OIDC_ISSUER_URL: ISSUER,
        CONVOY_OIDC_CLIENT_ID: CLIENT_ID,
        CONVOY_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        // redirect URI missing
      }),
    ).toBeUndefined();
  });

  it('defaults the button label when not set', () => {
    const settings = loadOidcSettings({
      CONVOY_OIDC_ISSUER_URL: ISSUER,
      CONVOY_OIDC_CLIENT_ID: CLIENT_ID,
      CONVOY_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      CONVOY_OIDC_REDIRECT_URI: REDIRECT_URI,
    });
    expect(settings?.buttonLabel).toBe('Log in with SSO');
  });
});

describe('OidcClient against a mocked spec-compliant IdP', () => {
  let privateKey: KeyObject;
  let jwk: Record<string, unknown>;

  function mockDiscoveryAndJwks(): void {
    nock(ISSUER)
      .persist()
      .get('/.well-known/openid-configuration')
      .reply(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    nock(ISSUER)
      .persist()
      .get('/jwks')
      .reply(200, { keys: [jwk] });
  }

  beforeEach(() => {
    nock.cleanAll();
    if (!privateKey) {
      const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      privateKey = keyPair.privateKey;
      jwk = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
    }
    mockDiscoveryAndJwks();
  });

  async function createClient(): Promise<OidcClient> {
    return OidcClient.create({
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      buttonLabel: 'Log in with Test IdP',
    });
  }

  it('builds an authorization URL with PKCE, state, and nonce', async () => {
    const oidcClient = await createClient();
    const authUrl = await oidcClient.buildAuthorizationUrl();
    expect(authUrl.origin + authUrl.pathname).toBe(`${ISSUER}/authorize`);
    expect(authUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authUrl.searchParams.get('state')).toBeTruthy();
    expect(authUrl.searchParams.get('nonce')).toBeTruthy();
  });

  it('completes a full authorization code + PKCE + nonce round trip', async () => {
    const oidcClient = await createClient();
    const authUrl = await oidcClient.buildAuthorizationUrl();
    const state = authUrl.searchParams.get('state')!;
    const nonce = authUrl.searchParams.get('nonce')!;

    const now = Math.floor(Date.now() / 1000);
    const idToken = signIdToken(
      { iss: ISSUER, aud: CLIENT_ID, sub: 'user-123', exp: now + 300, iat: now, nonce },
      privateKey,
    );

    nock(ISSUER).post('/token').reply(200, {
      access_token: 'test-access-token',
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const callbackUrl = new URL(REDIRECT_URI);
    callbackUrl.searchParams.set('code', 'test-auth-code');
    callbackUrl.searchParams.set('state', state);

    await expect(oidcClient.handleCallback(callbackUrl)).resolves.toBe(true);
  });

  it('rejects a callback whose state was never issued', async () => {
    const oidcClient = await createClient();
    const callbackUrl = new URL(REDIRECT_URI);
    callbackUrl.searchParams.set('code', 'whatever');
    callbackUrl.searchParams.set('state', 'never-issued');
    await expect(oidcClient.handleCallback(callbackUrl)).resolves.toBe(false);
  });

  it('rejects a state that was already consumed once', async () => {
    const oidcClient = await createClient();
    const authUrl = await oidcClient.buildAuthorizationUrl();
    const state = authUrl.searchParams.get('state')!;
    const nonce = authUrl.searchParams.get('nonce')!;
    const now = Math.floor(Date.now() / 1000);
    const idToken = signIdToken(
      { iss: ISSUER, aud: CLIENT_ID, sub: 'user-123', exp: now + 300, iat: now, nonce },
      privateKey,
    );
    nock(ISSUER)
      .post('/token')
      .reply(200, { access_token: 'a', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });

    const callbackUrl = new URL(REDIRECT_URI);
    callbackUrl.searchParams.set('code', 'test-auth-code');
    callbackUrl.searchParams.set('state', state);

    await expect(oidcClient.handleCallback(callbackUrl)).resolves.toBe(true);
    // Replaying the exact same callback URL a second time must not work --
    // this is the CSRF-replay protection the single-use pending map exists for.
    await expect(oidcClient.handleCallback(callbackUrl)).resolves.toBe(false);
  });

  it('rejects an ID token signed for the wrong nonce (a forged/replayed token)', async () => {
    const oidcClient = await createClient();
    const authUrl = await oidcClient.buildAuthorizationUrl();
    const state = authUrl.searchParams.get('state')!;

    const now = Math.floor(Date.now() / 1000);
    const idToken = signIdToken(
      {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'user-123',
        exp: now + 300,
        iat: now,
        nonce: 'wrong-nonce',
      },
      privateKey,
    );
    nock(ISSUER)
      .post('/token')
      .reply(200, { access_token: 'a', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });

    const callbackUrl = new URL(REDIRECT_URI);
    callbackUrl.searchParams.set('code', 'test-auth-code');
    callbackUrl.searchParams.set('state', state);

    await expect(oidcClient.handleCallback(callbackUrl)).resolves.toBe(false);
  });
});
