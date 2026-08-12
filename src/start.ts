/**
 * `probot run ./lib/index.js` (the CLI form) always registers Probot's own
 * default app first, which unconditionally redirects `GET /` to `/probot` —
 * that beats our own dashboard to the root route no matter what index.ts
 * does. Calling `run()` programmatically with the app function directly
 * skips that CLI-only behavior entirely; the GitHub App manifest/setup flow
 * is unaffected; it's triggered by missing credentials, not by this.
 */
import { readFileSync } from 'node:fs';
import { run } from 'probot';
import app from './index.js';
import { looksLikeGithubAppPrivateKey } from './core/privateKey.js';

function checkPrivateKey(): void {
  const raw = process.env.PRIVATE_KEY;
  const path = process.env.PRIVATE_KEY_PATH;
  if (!raw && !path) return; // nothing set yet -- first-run setup mode, not a misconfiguration

  let content: string;
  try {
    content = raw ?? readFileSync(path as string, 'utf8');
  } catch {
    return; // missing/unreadable file -- Probot's own error for this is already clear
  }

  if (!looksLikeGithubAppPrivateKey(content)) {
    console.error(
      [
        '',
        `${raw ? 'PRIVATE_KEY' : 'PRIVATE_KEY_PATH'} does not look like a GitHub App private key.`,
        'GitHub App keys always start with "-----BEGIN RSA PRIVATE KEY-----" -- generate one on',
        'your App\'s settings page ("Generate a private key"), not an SSH key you already have.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

checkPrivateKey();
void run(app);
