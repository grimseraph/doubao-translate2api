import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config/env.js";
import { ServiceError, invalid } from "../core/errors.js";
import { AccountPool } from "./accounts.js";
import { AdminCredentials } from "./credentials.js";
import { BoundedSessionStore } from "./sessions.js";
import type { Translator } from "../core/translator.js";
import type { CookieProvider } from "../auth/cookie-store.js";
import type { ApiKeyStore } from "../auth/api-key-store.js";
import type { TranslationSettings } from "./translation-settings.js";
import type { UsageStore } from "./usage.js";
import { adaptRequest } from "../protocols/adapter.js";

const fields = z.object({ name: z.string().trim().min(1).max(64), cookie: z.string().min(1).max(131072) });
const update = fields.partial().extend({ enabled: z.boolean().optional() }).refine(x => Object.keys(x).length > 0);
const password = z.string().min(12).max(256);
function validate<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw invalid("Invalid management form.");
  return result.data;
}
export function registerAdmin(app: FastifyInstance, config: Config, pool: AccountPool, translator: Translator,
  signalFor: (id: string) => AbortSignal, apiKeys: ApiKeyStore, settings: TranslationSettings, usage: UsageStore) {
  app.register(async admin => {
    await pool.initialize();
    const credentials = new AdminCredentials(config);
    await credentials.initialize();
    const sessions = new BoundedSessionStore();
    await admin.register(cookie);
    await admin.register(session, {
      secret: credentials.secret, cookieName: "doubao_admin", store: sessions,
      saveUninitialized: false, rolling: false,
      cookie: { path: "/admin", httpOnly: true, secure: config.ADMIN_COOKIE_SECURE, sameSite: "strict", maxAge: 8 * 60 * 60 * 1000 },
    });
    const attempts = new Map<string, { count: number; until: number }>();
    admin.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer").header("X-Frame-Options", "DENY");
      const path = request.url.split("?")[0]!;
      if (!path.startsWith("/admin/api/")) return;
      const origin = request.headers.origin;
      const expected = config.ADMIN_ORIGIN ? new URL(config.ADMIN_ORIGIN).origin :
        `${request.protocol}://${request.headers.host}`;
      if (origin && origin !== expected) throw new ServiceError("admin_origin_error", 403, "Management requests must use the same origin.");
      if (!["GET", "HEAD"].includes(request.method) && !request.headers["content-type"]?.startsWith("application/json"))
        throw invalid("Management requests must use JSON.");
      if (path === "/admin/api/login") return;
      if (request.session.adminVersion !== credentials.version) {
        reply.clearCookie("doubao_admin", { path: "/admin" });
        throw new ServiceError("admin_login_required", 401, "Management login is required.");
      }
      if (!["GET", "HEAD"].includes(request.method) && request.headers["x-admin-csrf"] !== request.session.csrf)
        throw new ServiceError("admin_csrf_error", 403, "Management session verification failed.");
    });
    const uiDir = fileURLToPath(new URL("../../dist/ui/", import.meta.url));
    admin.get("/admin", async (_request, reply) => {
      reply.type("text/html").header("Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return readFile(join(uiDir, "index.html"), "utf8");
    });
    admin.get("/admin/", async (_request, reply) => reply.redirect("/admin"));
    for (const [file, type] of [["admin.js", "application/javascript"], ["admin.css", "text/css"]]) {
      admin.get(`/admin/assets/${file}`, async (_request, reply) => reply.type(type!).send(await readFile(join(uiDir, file!))));
    }
    admin.post("/admin/api/login", async request => {
      const { password: input } = validate(z.object({ password: z.string().min(1).max(256) }), request.body);
      const now = Date.now();
      for (const [ip, attempt] of attempts) if (attempt.until <= now) attempts.delete(ip);
      const current = attempts.get(request.ip);
      if (current && current.count >= 5) throw new ServiceError("admin_login_rate_limited", 429, "Too many login attempts. Try again in 15 minutes.");
      if (attempts.size >= 1000 && !current) throw new ServiceError("admin_login_rate_limited", 429, "Too many login attempts.");
      attempts.set(request.ip, { count: (current?.count ?? 0) + 1, until: current?.until ?? now + 15 * 60 * 1000 });
      if (!(await credentials.verify(input))) throw new ServiceError("invalid_admin_password", 401, "Incorrect management password.");
      attempts.delete(request.ip);
      await request.session.regenerate();
      request.session.adminVersion = credentials.version;
      request.session.csrf = randomBytes(24).toString("hex");
      return { csrf: request.session.csrf };
    });
    admin.get("/admin/api/session", async request => ({ csrf: request.session.csrf }));
    admin.get("/admin/api/usage", async () => ({
      ...usage.snapshot(), concurrency: translator.semaphore.status, accountPersistence: pool.runtimePersistence,
    }));
    admin.post("/admin/api/translate", async request => {
      const input = validate(z.object({ text: z.string().trim().min(1).max(10000), model: z.string(), targetLang: z.string() }), request.body);
      const adapted = adaptRequest("openai-chat", { model: input.model, target_lang: input.targetLang,
        messages: [{ role: "user", content: input.text }] }, undefined, config.DOUBAO_DEFAULT_SCENE, request.id, settings.defaultTargetLang);
      return translator.translate(adapted.canonical, signalFor(request.id));
    });
    admin.get("/admin/api/settings/translation", async () => settings.metadata);
    admin.put("/admin/api/settings/translation", async request =>
      settings.update(validate(z.object({ targetLang: z.string().min(1) }), request.body).targetLang));
    admin.get("/admin/api/api-key", async () => apiKeys.metadata);
    admin.post("/admin/api/api-key/reveal", async () => apiKeys.reveal());
    admin.post("/admin/api/api-key/rotate", async () => apiKeys.rotate());
    admin.post("/admin/api/logout", async (request, reply) => {
      await request.session.destroy();
      reply.clearCookie("doubao_admin", { path: "/admin" });
      return { ok: true };
    });
    admin.get("/admin/api/accounts", async () => { await pool.refreshFile(); return pool.list(); });
    admin.post("/admin/api/accounts", async request => {
      const input = validate(fields, request.body);
      return { id: await pool.add(input.name, input.cookie) };
    });
    admin.patch<{ Params: { id: string } }>("/admin/api/accounts/:id", async request => {
      await pool.update(request.params.id, validate(update, request.body)); return { ok: true };
    });
    admin.delete<{ Params: { id: string } }>("/admin/api/accounts/:id", async request => {
      await pool.remove(request.params.id); return { ok: true };
    });
    admin.post<{ Params: { id: string } }>("/admin/api/accounts/:id/probe", async request =>
      pool.probe(request.params.id, (provider: CookieProvider) => translator.authStatus(signalFor(request.id), provider)));
    admin.put("/admin/api/settings", async request => {
      const { mode, activeId } = validate(z.object({
        mode: z.enum(["failover", "round-robin", "manual"]), activeId: z.string().min(1),
      }), request.body);
      await pool.configure(mode, activeId); return { ok: true };
    });
    admin.put("/admin/api/password", async (request, reply) => {
      const input = validate(z.object({ currentPassword: z.string().min(1).max(256), newPassword: password }), request.body);
      if (!(await credentials.verify(input.currentPassword))) throw new ServiceError("invalid_admin_password", 401, "Incorrect current password.");
      await credentials.change(input.newPassword);
      sessions.clear();
      await request.session.destroy();
      reply.clearCookie("doubao_admin", { path: "/admin" });
      return { ok: true };
    });
  });
}
