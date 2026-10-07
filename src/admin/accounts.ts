import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { loadCookie, parseCookie, type CookieProvider, type CookieValue } from "../auth/cookie-store.js";
import { ServiceError, invalid } from "../core/errors.js";
import type { Config } from "../config/env.js";
import { writePrivate } from "./files.js";

const healthSchema = z.object({
  status: z.enum(["unknown", "valid", "invalid", "cooldown"]).default("unknown"),
  reason: z.string().optional(), checkedAt: z.number().optional(), cooldownUntil: z.number().default(0),
});
const accountSchema = z.object({
  id: z.string(), name: z.string().min(1).max(64), enabled: z.boolean(),
  cookie: z.string().optional(), revision: z.string(), createdAt: z.number(), updatedAt: z.number(),
  lastUsedAt: z.number().optional(), fingerprint: z.string().optional(), health: healthSchema,
});
const stateSchema = z.object({
  version: z.literal(1), mode: z.enum(["failover", "round-robin", "manual"]), activeId: z.string(),
  accounts: z.array(accountSchema).min(1).max(101),
});
type Account = z.infer<typeof accountSchema>;
type State = z.infer<typeof stateSchema>;
export type Mode = State["mode"];
export interface AccountLease { id: string; revision: string; provider: CookieProvider }
export interface ProbeResult { authenticated: boolean; reason?: string; upstream_code?: number }

export function importCookie(input: string): CookieValue {
  let text = input.trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw invalid("Cookie JSON is invalid."); }
    const list = Array.isArray(value) ? value :
      value && typeof value === "object" && "cookies" in value ? (value as { cookies: unknown }).cookies : undefined;
    if (!Array.isArray(list)) throw invalid("Expected an exported cookie array.");
    text = list.filter(item => item && (item.domain === undefined ||
      (typeof item.domain === "string" && /^(?:\.)?(?:www\.)?doubao\.com$/i.test(item.domain))))
      .map(item => {
        if (typeof item.name !== "string" || !/^[A-Za-z0-9_!#$%&'*+.^`|~-]+$/.test(item.name) ||
          typeof item.value !== "string" || /[;\r\n]/.test(item.value)) throw invalid("Invalid exported cookie entry.");
        return `${item.name}=${item.value}`;
      }).join("; ");
  }
  try {
    const result = parseCookie(text);
    if (!result.complete) throw invalid("Cookie must contain sessionid, sid_tt and uid_tt.");
    return result;
  } catch (error) {
    if (error instanceof ServiceError && error.status === 400) throw error;
    throw invalid("Cookie contains unsafe characters or is empty.");
  }
}
export { isAccountFailure } from "../core/account-source.js";
export class AccountPool {
  private state!: State;
  private pending: Promise<unknown> = Promise.resolve();
  private cursor = 0;
  private path: string;
  private dirty = false;
  private storageError = false;
  get runtimePersistence() { return this.storageError ? "error" : this.dirty ? "pending" : "saved"; }
  constructor(private config: Config) { this.path = join(config.ADMIN_DATA_DIR, "accounts.json"); }
  async initialize() {
    try {
      this.state = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      if (this.state.accounts.filter(x => x.id === "file").length !== 1 ||
          new Set(this.state.accounts.map(x => x.id)).size !== this.state.accounts.length ||
          !this.state.accounts.some(x => x.id === this.state.activeId)) throw new Error("Invalid account state.");
      for (const account of this.state.accounts) {
        if (account.id !== "file" && (!account.cookie || !parseCookie(account.cookie).complete)) throw new Error("Invalid saved cookie.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ServiceError("admin_storage_error", 500, "Saved cookie configuration is invalid.");
      const now = Date.now();
      this.state = {
        version: 1, mode: "failover", activeId: "file",
        accounts: [{ id: "file", name: "本地 Cookie 文件", enabled: true, revision: randomUUID(),
          createdAt: now, updatedAt: now, health: { status: "unknown", cooldownUntil: 0 } }],
      };
      await writePrivate(this.path, JSON.stringify(this.state));
    }
  }
  private mutate<T>(fn: (state: State) => T, persist = true): Promise<T> {
    const task = this.pending.then(async () => {
      const state = structuredClone(this.state);
      const result = fn(state);
      if (persist) {
        await writePrivate(this.path, JSON.stringify(state));
        this.storageError = false;
      }
      this.state = state;
      this.dirty = !persist;
      return result;
    });
    this.pending = task.catch(() => {});
    return task;
  }
  flush() {
    const task = this.pending.then(async () => {
      if (!this.dirty) return;
      try { await writePrivate(this.path, JSON.stringify(this.state)); }
      catch (error) { this.storageError = true; throw error; }
      this.storageError = false;
      this.dirty = false;
    });
    this.pending = task.catch(() => {});
    return task;
  }
  private find(state: State, id: string) {
    const account = state.accounts.find(x => x.id === id);
    if (!account) throw new ServiceError("account_not_found", 404, "Cookie account not found.");
    return account;
  }
  async list() {
    await this.pending;
    return {
      mode: this.state.mode, activeId: this.state.activeId,
      accounts: this.state.accounts.map(({ cookie: _cookie, fingerprint: _fingerprint, revision: _revision, ...account }) => ({
        ...account, source: account.id === "file" ? "file" : "managed",
      })),
    };
  }
  async add(name: string, input: string) {
    const { cookie } = importCookie(input);
    return this.mutate(state => {
      if (state.accounts.length >= 101) throw invalid("At most 100 imported cookies can be saved.");
      const now = Date.now(), id = randomUUID();
      state.accounts.push({ id, name, cookie, enabled: true, revision: randomUUID(),
        createdAt: now, updatedAt: now, health: { status: "unknown", cooldownUntil: 0 } });
      return id;
    });
  }
  async update(id: string, patch: { name?: string; enabled?: boolean; cookie?: string }) {
    const value = patch.cookie !== undefined ? importCookie(patch.cookie).cookie : undefined;
    return this.mutate(state => {
      const account = this.find(state, id);
      if (id === "file" && value !== undefined) throw invalid("Edit the local cookie file directly.");
      if (patch.name !== undefined) account.name = patch.name;
      if (patch.enabled !== undefined) account.enabled = patch.enabled;
      if (value !== undefined) {
        account.cookie = value; account.revision = randomUUID();
        account.health = { status: "unknown", cooldownUntil: 0 };
      }
      account.updatedAt = Date.now();
    });
  }
  async remove(id: string) {
    if (id === "file") throw invalid("The local cookie file entry cannot be deleted.");
    return this.mutate(state => {
      this.find(state, id);
      state.accounts = state.accounts.filter(x => x.id !== id);
      if (state.activeId === id) state.activeId = "file";
    });
  }
  async configure(mode: Mode, activeId: string) {
    return this.mutate(state => {
      const selected = this.find(state, activeId);
      if (!selected.enabled) throw invalid("Enable the selected cookie first.");
      state.mode = mode; state.activeId = activeId; this.cursor = 0;
    });
  }
  async getCookie(id: string): Promise<CookieValue> {
    await this.pending;
    if (id === "file") return loadCookie(this.config.DOUBAO_COOKIE_FILE);
    return parseCookie(this.find(this.state, id).cookie!);
  }
  async refreshFile() {
    let fingerprint: string, reason: string | undefined;
    try {
      const cookie = await loadCookie(this.config.DOUBAO_COOKIE_FILE);
      fingerprint = createHash("sha256").update(cookie.cookie).digest("hex");
      if (!cookie.complete) reason = "cookie_invalid";
    } catch (error) {
      reason = error instanceof ServiceError ? error.code : "cookie_invalid";
      fingerprint = reason;
    }
    await this.pending;
    if (this.find(this.state, "file").fingerprint === fingerprint) return;
    await this.mutate(state => {
      const account = this.find(state, "file");
      account.fingerprint = fingerprint; account.revision = randomUUID();
      account.health = reason ? { status: "invalid", reason, cooldownUntil: 0, checkedAt: Date.now() } :
        { status: "unknown", cooldownUntil: 0 };
    });
  }
  async choose(excluded: Set<string> = new Set()): Promise<AccountLease> {
    await this.refreshFile();
    const accounts = this.state.accounts;
    const usable = (account: Account) => account.enabled && !excluded.has(account.id) &&
      account.health.status !== "invalid" && account.health.cooldownUntil <= Date.now();
    let ordered: Account[];
    if (this.state.mode === "manual") ordered = [this.find(this.state, this.state.activeId)];
    else if (this.state.mode === "round-robin") {
      const candidates = accounts.filter(usable);
      if (!candidates.length) throw new ServiceError("no_available_cookie", 502, "No cookie account is currently available.");
      const index = this.cursor++ % candidates.length;
      ordered = [...candidates.slice(index), ...candidates.slice(0, index)];
    } else {
      const index = accounts.findIndex(x => x.id === this.state.activeId);
      ordered = [...accounts.slice(index), ...accounts.slice(0, index)];
    }
    const account = ordered.find(usable);
    if (!account) throw new ServiceError("no_available_cookie", 502, "No cookie account is currently available.");
    return { id: account.id, revision: account.revision, provider: () => this.getCookie(account.id) };
  }
  async allowsFailover() { await this.pending; return this.state.mode !== "manual"; }
  async succeeded(id: string, revision?: string) {
    await this.mutate(state => {
      const account = state.accounts.find(x => x.id === id);
      if (!account) return;
      if (revision && account.revision !== revision) return;
      account.lastUsedAt = Date.now();
      account.health = { status: "valid", checkedAt: Date.now(), cooldownUntil: 0 };
      if (state.mode === "failover") state.activeId = id;
    }, false);
  }
  async failed(id: string, error: ServiceError, revision?: string) {
    await this.mutate(state => {
      const account = state.accounts.find(x => x.id === id);
      if (!account) return;
      if (revision && account.revision !== revision) return;
      const permanent = ["cookie_missing", "cookie_invalid", "upstream_auth_error"].includes(error.code);
      account.health = {
        status: permanent ? "invalid" : "cooldown", reason: error.code, checkedAt: Date.now(),
        cooldownUntil: permanent ? 0 : Date.now() + 60000,
      };
    }, false);
  }
  async probe(id: string, inspect: (provider: CookieProvider) => Promise<ProbeResult>) {
    await this.refreshFile();
    const revision = this.find(this.state, id).revision;
    const result = await inspect(() => this.getCookie(id));
    await this.mutate(state => {
      const account = state.accounts.find(x => x.id === id);
      if (!account || account.revision !== revision) return;
      const permanent = ["cookie_expired", "cookie_missing", "cookie_invalid", "upstream_auth_error"].includes(result.reason ?? "");
      account.health = result.authenticated ? { status: "valid", checkedAt: Date.now(), cooldownUntil: 0 } : {
        status: permanent ? "invalid" : "cooldown", reason: result.reason ?? "upstream_auth_error",
        checkedAt: Date.now(), cooldownUntil: permanent ? 0 : Date.now() + 60000,
      };
    });
    return result;
  }
}
