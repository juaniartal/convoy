import { randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'convoy_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface Session {
  expiresAt: number;
}

/**
 * In-memory only, same tradeoff as StateStore -- Convoy is single-replica by
 * design (no shared state backend), so a restart or a second pod would lose
 * sessions anyway. That's an acceptable cost for "log in again", not a
 * correctness problem.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor() {
    // Sweeping only on create leaves expired sessions resident for as long as
    // nobody logs in -- on a dashboard people sign into once and leave open
    // for weeks, that's most of the time. unref'd so it never holds the
    // process open on its own.
    const timer = setInterval(() => this.sweep(), SESSION_SWEEP_INTERVAL_MS);
    timer.unref();
  }

  create(): string {
    this.sweep();
    const id = randomBytes(32).toString('hex');
    this.sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
    return id;
  }

  isValid(id: string | undefined): boolean {
    if (!id) return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(id);
    }
  }
}
