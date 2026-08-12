import { describe, expect, it } from 'vitest';
import { looksLikeGithubAppPrivateKey } from '../src/core/privateKey.js';

describe('looksLikeGithubAppPrivateKey', () => {
  it('accepts a real GitHub App key (RSA, PKCS#1)', () => {
    expect(
      looksLikeGithubAppPrivateKey(
        '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
      ),
    ).toBe(true);
  });

  it('tolerates leading/trailing whitespace', () => {
    expect(looksLikeGithubAppPrivateKey('\n  -----BEGIN RSA PRIVATE KEY-----\nabc\n  ')).toBe(true);
  });

  // The exact real-world mistake this check exists to catch: someone's own
  // SSH key, not a GitHub App key.
  it('rejects an OpenSSH key', () => {
    expect(
      looksLikeGithubAppPrivateKey(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n',
      ),
    ).toBe(false);
  });

  it('rejects a generic PKCS#8 key', () => {
    expect(
      looksLikeGithubAppPrivateKey('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n'),
    ).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(looksLikeGithubAppPrivateKey('')).toBe(false);
  });
});
