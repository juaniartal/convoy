/**
 * `probot run ./lib/index.js` (the CLI form) always registers Probot's own
 * default app first, which unconditionally redirects `GET /` to `/probot` —
 * that beats our own dashboard to the root route no matter what index.ts
 * does. Calling `run()` programmatically with the app function directly
 * skips that CLI-only behavior entirely; the GitHub App manifest/setup flow
 * is unaffected; it's triggered by missing credentials, not by this.
 */
import { run } from 'probot';
import app from './index.js';

void run(app);
