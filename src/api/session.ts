import { randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'convoy_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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
