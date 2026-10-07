import type { Session } from "fastify";
import type { SessionStore } from "@fastify/session";

const LIFETIME = 8 * 60 * 60 * 1000;
export class BoundedSessionStore implements SessionStore {
  private values = new Map<string, { session: Session; expires: number }>();
  set(id: string, session: Session, callback: (error?: unknown) => void) {
    this.prune();
    if (!this.values.has(id) && this.values.size >= 1000) this.values.delete(this.values.keys().next().value!);
    this.values.set(id, { session, expires: session.cookie.expires ? new Date(session.cookie.expires).getTime() : Date.now() + LIFETIME });
    callback();
  }
  get(id: string, callback: (error: unknown, value?: Session | null) => void) {
    this.prune(); callback(null, this.values.get(id)?.session ?? null);
  }
  destroy(id: string, callback: (error?: unknown) => void) { this.values.delete(id); callback(); }
  clear() { this.values.clear(); }
  private prune() {
    const now = Date.now();
    for (const [id, value] of this.values) if (value.expires <= now) this.values.delete(id);
  }
}

declare module "fastify" {
  interface Session { adminVersion?: string; csrf?: string }
}
