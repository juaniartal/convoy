import { randomBytes } from 'node:crypto';
import * as client from 'openid-client';

const PENDING_TTL_MS = 5 * 60 * 1000;
// /api/auth/oidc/start is unauthenticated by design (it's the login entry
// point) -- bounds memory from someone hitting it in a loop without ever
// completing a login, instead of letting the map grow unbounded for the
// length of PENDING_TTL_MS.
const MAX_PENDING = 1000;

export interface OidcSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  buttonLabel: string;
}

export function loadOidcSettings(env: NodeJS.ProcessEnv): OidcSettings | undefined {
  const issuerUrl = env.CONVOY_OIDC_ISSUER_URL;
  const clientId = env.CONVOY_OIDC_CLIENT_ID;
  const clientSecret = env.CONVOY_OIDC_CLIENT_SECRET;
  const redirectUri = env.CONVOY_OIDC_REDIRECT_URI;
  if (!issuerUrl || !clientId || !clientSecret || !redirectUri) return undefined;
  return {
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    buttonLabel: env.CONVOY_OIDC_BUTTON_LABEL || 'Log in with SSO',
  };
}

interface PendingAuth {
  codeVerifier: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Thin wrapper around openid-client's stateless functional API -- the
 * per-request bookkeeping it deliberately doesn't do (matching state back to
 * its PKCE verifier and nonce across the redirect round-trip) lives here,
 * in-memory, same tradeoff as SessionStore.
 */
export class OidcClient {
  private pending = new Map<string, PendingAuth>();

  private constructor(
    private readonly config: client.Configuration,
    readonly settings: OidcSettings,
  ) {}

  static async create(settings: OidcSettings): Promise<OidcClient> {
    // Every real provider (Azure AD, Google, Okta, ...) is HTTPS -- this
    // only exists so CONVOY_OIDC_ISSUER_URL can point at a plain-HTTP IdP
    // while testing locally, without weakening anything for an actual
    // deployment. Off unless explicitly opted into. Has to be threaded
    // through discovery() itself via `execute` -- discovery's own initial
    // fetch already enforces HTTPS before there's a Configuration object
    // to patch after the fact.
    const allowInsecure = process.env.CONVOY_OIDC_ALLOW_INSECURE === 'true';
    const config = await client.discovery(
      new URL(settings.issuerUrl),
      settings.clientId,
      settings.clientSecret,
      undefined,
      allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    return new OidcClient(config, settings);
  }

  async buildAuthorizationUrl(): Promise<URL> {
    this.sweep();
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const state = randomBytes(32).toString('hex');
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const nonce = client.randomNonce();
    this.pending.set(state, { codeVerifier, nonce, expiresAt: Date.now() + PENDING_TTL_MS });
    return client.buildAuthorizationUrl(this.config, {
      redirect_uri: this.settings.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /** Returns true and consumes the pending state on success; false on any
   * mismatch or failure (expired link, tampered state, rejected code, etc.) --
   * callers don't need to distinguish why, just whether to grant a session. */
  async handleCallback(currentUrl: URL): Promise<boolean> {
    this.sweep();
    const state = currentUrl.searchParams.get('state');
    const pending = state ? this.pending.get(state) : undefined;
    if (!pending) return false;
    this.pending.delete(state!);
    try {
      await client.authorizationCodeGrant(this.config, currentUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: state!,
        expectedNonce: pending.nonce,
      });
      return true;
    } catch {
      return false;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt < now) this.pending.delete(state);
    }
  }
}
