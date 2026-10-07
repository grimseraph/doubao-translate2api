import { mkdtemp, writeFile, readFile, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { startMock } from "../fixtures/mock-doubao.js";
import { AccountPool, importCookie } from "../../src/admin/accounts.js";
import { ServiceError } from "../../src/core/errors.js";
import type { Fetch } from "../../src/doubao/client.js";
import { TranslationSettings } from "../../src/admin/translation-settings.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const cookie = (value: string) => `sessionid=${value}; sid_tt=${value}; uid_tt=${value}`;
async function setup(options: { mode?: "expired" | "limited" | "bad-scene"; noFile?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "doubao-admin-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "cookie.txt"), adminDir = join(dir, "admin");
  if (!options.noFile) await writeFile(file, cookie("primary"));
  const mock = await startMock(); cleanup.push(mock.close);
  const seen: string[] = [];
  const fetcher: Fetch = async (url, init) => {
    const upstreamCookie = new Headers(init?.headers).get("cookie") ?? "";
    seen.push(upstreamCookie);
    if (String(url).includes("stream_article_translate")) {
      if (options.mode === "bad-scene") return Response.json({ code: 710010202 });
      if (upstreamCookie.includes("sessionid=primary")) {
        if (options.mode === "expired") return Response.json({ code: 710012001 });
        if (options.mode === "limited") return new Response("", { status: 429 });
      }
    }
    return mock.fetcher(url, init);
  };
  const config = loadConfig({ API_KEY: "client-key", LOG_LEVEL: "silent", ADMIN_ENABLED: "true",
    DOUBAO_COOKIE_FILE: file, ADMIN_DATA_DIR: adminDir, DOUBAO_MAX_RETRIES: "0" });
  const app = createApp(config, { fetcher }); cleanup.push(() => app.close());
  await app.ready();
  const password = (await readFile(join(adminDir, "initial-password.txt"), "utf8")).trim();
  async function login(value = password) {
    const result = await app.inject({ method: "POST", url: "/admin/api/login", payload: { password: value } });
    const header = result.headers["set-cookie"];
    const signedCookie = (Array.isArray(header) ? header[0] : header)?.split(";")[0] ?? "";
    return { result, headers: { cookie: signedCookie, "x-admin-csrf": result.json().csrf ?? "" } };
  }
  const session = await login();
  async function request(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET", body?: unknown) {
    return app.inject({ method, url: "/admin/api" + path, headers: session.headers,
      ...(method === "GET" ? {} : { payload: body ?? {} }) });
  }
  async function translate(text = "hello") {
    return app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": "client-key" },
      payload: { model: "doubao-ai", target_lang: "zh", messages: [{ role: "user", content: text }] } });
  }
  async function add(name = "backup", value = "backup") {
    const response = await request("/accounts", "POST", { name, cookie: cookie(value) });
    expect(response.statusCode).toBe(200);
    return response.json().id as string;
  }
  return { app, file, config, dir, adminDir, password, login, session, request, add, translate, seen, mock };
}
describe("management authentication", () => {
  it("generates a private persistent password and protects management independently", async () => {
    const { app, adminDir, password, session, config } = await setup();
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect((await stat(join(adminDir, "initial-password.txt"))).mode & 0o777).toBe(0o600);
    const credentials = await readFile(join(adminDir, "credentials.json"), "utf8");
    expect(credentials).not.toContain(password);
    expect(session.result.statusCode).toBe(200);
    expect(session.result.headers["set-cookie"]).toContain("HttpOnly");
    expect(session.result.headers["set-cookie"]).toContain("SameSite=Strict");
    expect((await app.inject({ url: "/admin/api/accounts", headers: { "x-api-key": "client-key" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/models", headers: session.headers })).statusCode).toBe(401);
    const html = await app.inject({ url: "/admin" });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(html.body).not.toContain(password);
    const restarted = createApp(config, { fetcher: async () => Response.json({ code: 0 }) });
    cleanup.push(() => restarted.close()); await restarted.ready();
    expect((await readFile(join(adminDir, "initial-password.txt"), "utf8")).trim()).toBe(password);
  });
  it("rejects CSRF, foreign origins and API-key-only admin access", async () => {
    const { app, session } = await setup();
    for (const headers of [
      { cookie: session.headers.cookie },
      { ...session.headers, origin: "https://attacker.example" },
      { "x-api-key": "client-key" },
    ]) {
      expect((await app.inject({ method: "POST", url: "/admin/api/accounts", headers,
        payload: { name: "bad", cookie: cookie("bad") } })).statusCode).toBeGreaterThanOrEqual(400);
    }
  });
  it("limits login attempts, revokes logout and rejects old sessions after password change", async () => {
    const { app, request, session, password, login, adminDir } = await setup();
    expect((await request("/password", "PUT", { currentPassword: password, newPassword: "a-new-long-password" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/admin/api/accounts", headers: session.headers })).statusCode).toBe(401);
    await expect(readFile(join(adminDir, "initial-password.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const next = await login("a-new-long-password");
    expect(next.result.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/admin/api/logout", headers: next.headers, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ url: "/admin/api/session", headers: next.headers })).statusCode).toBe(401);
    for (let i = 0; i < 5; i++) expect((await login("wrong-password")).result.statusCode).toBe(401);
    expect((await login("a-new-long-password")).result.statusCode).toBe(429);
  });
});

describe("default translation language management", () => {
  it("updates the live default and preserves it after restart", async () => {
    const { app, config, adminDir, request } = await setup();
    expect((await request("/settings/translation")).json().defaultTargetLang).toBe("zh");
    const result = await request("/settings/translation", "PUT", { targetLang: "zh-TW" });
    expect(result.statusCode).toBe(200);
    expect(result.json().defaultTargetLang).toBe("zh-Hant");
    expect((await stat(join(adminDir, "settings.json"))).mode & 0o777).toBe(0o600);
    expect((await app.inject({ url: "/info", headers: { "x-api-key": "client-key" } })).json().default_target_lang).toBe("zh-Hant");
    const restarted = createApp({ ...config, DOUBAO_DEFAULT_TARGET_LANG: "ja" });
    cleanup.push(() => restarted.close()); await restarted.ready();
    expect((await restarted.inject({ url: "/info", headers: { "x-api-key": "client-key" } })).json().default_target_lang).toBe("zh-Hant");
    expect((await request("/settings/translation", "PUT", { targetLang: "unsupported" })).statusCode).toBe(400);
    expect((await request("/settings/translation")).json().defaultTargetLang).toBe("zh-Hant");
  });
  it("rejects unauthenticated, CSRF and cross-origin writes without changing settings", async () => {
    const { app, session, request } = await setup();
    for (const headers of [
      { "x-api-key": "client-key" }, { cookie: session.headers.cookie },
      { ...session.headers, origin: "https://other.example" },
    ]) expect((await app.inject({ method: "PUT", url: "/admin/api/settings/translation", headers, payload: { targetLang: "ja" } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await request("/settings/translation")).json().defaultTargetLang).toBe("zh");
  });
  it("uses the initial environment default and retains the previous value after failed writes", async () => {
    const { config, adminDir } = await setup();
    const path = join(adminDir, "settings.json");
    await rm(path);
    const settings = new TranslationSettings({ ...config, DOUBAO_DEFAULT_TARGET_LANG: "fr" });
    await settings.initialize();
    expect(settings.defaultTargetLang).toBe("fr");
    await rm(path);
    await mkdir(path);
    await expect(settings.update("ja")).rejects.toMatchObject({ code: "admin_storage_error" });
    expect(settings.defaultTargetLang).toBe("fr");
    await rm(path, { recursive: true });
    await writeFile(path, "invalid-private-settings");
    await expect(new TranslationSettings(config).initialize()).rejects.toMatchObject({ code: "admin_storage_error" });
    expect(await readFile(path, "utf8")).toBe("invalid-private-settings");
  });
});

describe("cookie management and scheduling", () => {
  it("keeps successful runtime updates independent of storage errors and flushes on close", async () => {
    const { config } = await setup();
    const pool = new AccountPool(config); await pool.initialize();
    const lease = await pool.choose();
    const path = join(config.ADMIN_DATA_DIR, "accounts.json");
    await rm(path); await mkdir(path);
    await expect(pool.succeeded(lease.id, lease.revision)).resolves.toBeUndefined();
    expect((await pool.list()).accounts[0]?.health.status).toBe("valid");
    await expect(pool.flush()).rejects.toMatchObject({ code: "admin_storage_error" });
    expect(pool.runtimePersistence).toBe("error");
    await rm(path, { recursive: true });
    await pool.flush();
    expect(pool.runtimePersistence).toBe("saved");
    expect(JSON.parse(await readFile(path, "utf8")).accounts[0].health.status).toBe("valid");
  });
  it("imports exported JSON, filters domains and never returns cookie values", async () => {
    const { request, adminDir } = await setup();
    const entries = ["sessionid", "sid_tt", "uid_tt"].map(name => ({ name, value: "managed-cookie-secret", domain: ".doubao.com" }));
    entries.push({ name: "other", value: "foreign-secret", domain: "example.com" });
    const result = await request("/accounts", "POST", { name: "JSON账号", cookie: JSON.stringify(entries) });
    expect(result.statusCode).toBe(200);
    const listing = await request("/accounts");
    expect(listing.body).not.toContain("managed-cookie-secret");
    expect(listing.body).not.toContain("primary");
    expect((await readFile(join(adminDir, "accounts.json"), "utf8"))).not.toContain("foreign-secret");
    expect((await stat(join(adminDir, "accounts.json"))).mode & 0o777).toBe(0o600);
    for (const value of ["sessionid=x", "sessionid=x\r\nbad=true; sid_tt=x; uid_tt=x", "[]"]) {
      expect((await request("/accounts", "POST", { name: "bad", cookie: value })).statusCode).toBe(400);
    }
  });
  it("can update, disable, probe and delete without overwriting the existing file", async () => {
    const { add, request, file } = await setup();
    const id = await add();
    expect((await request(`/accounts/${id}/probe`, "POST")).json().authenticated).toBe(true);
    expect((await request(`/accounts/${id}`, "PATCH", { cookie: cookie("updated"), name: "new" })).statusCode).toBe(200);
    expect((await request(`/accounts/${id}`, "PATCH", { enabled: false })).statusCode).toBe(200);
    expect((await request("/settings", "PUT", { mode: "manual", activeId: id })).statusCode).toBe(400);
    expect((await request("/accounts/file", "DELETE")).statusCode).toBe(400);
    expect((await request(`/accounts/${id}`, "DELETE")).statusCode).toBe(200);
    expect((await readFile(file, "utf8"))).toBe(cookie("primary"));
  });
  it("round robins per request and pins multi-batch requests to one account", async () => {
    const { add, request, translate, seen } = await setup();
    await add();
    expect((await request("/settings", "PUT", { mode: "round-robin", activeId: "file" })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await translate()).statusCode).toBe(200);
    expect(seen.map(x => x.includes("sessionid=primary"))).toEqual([true, false, true, false]);
    seen.length = 0;
    const paragraphs = Array.from({ length: 51 }, (_, i) => `p${i}`).join("\n\n");
    expect((await translate(paragraphs)).statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
  it.each(["expired", "limited"] as const)("fails over %s cookies and skips them on the next request", async mode => {
    const { add, request, translate, seen } = await setup({ mode });
    const id = await add();
    expect((await translate()).statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("sessionid=primary");
    expect(seen[1]).toContain("sessionid=backup");
    const state = (await request("/accounts")).json();
    expect(state.activeId).toBe(id);
    expect(state.accounts.find((x: { id: string }) => x.id === "file").health.status).toBe(mode === "expired" ? "invalid" : "cooldown");
    seen.length = 0;
    expect((await translate()).statusCode).toBe(200);
    expect(seen).toHaveLength(1); expect(seen[0]).toContain("sessionid=backup");
  });
  it("does not fail over known parameter errors or manual mode", async () => {
    const bad = await setup({ mode: "bad-scene" }); await bad.add();
    expect((await bad.translate()).statusCode).toBe(502);
    expect(bad.seen).toHaveLength(1);
    const manual = await setup({ mode: "expired" }); await manual.add();
    await manual.request("/settings", "PUT", { mode: "manual", activeId: "file" });
    expect((await manual.translate()).statusCode).toBe(502);
    expect(manual.seen).toHaveLength(1);
  });
  it("handles missing local files and imported-only pools", async () => {
    const { add, request, translate, app } = await setup({ noFile: true });
    expect((await translate()).json().error.code).toBe("no_available_cookie");
    expect((await app.inject({ url: "/auth/status", headers: { "x-api-key": "client-key" } })).json().reason).toBe("cookie_missing");
    await add();
    expect((await translate()).statusCode).toBe(200);
    expect((await request("/accounts")).json().accounts.find((x: { id: string }) => x.id === "file").health.status).toBe("invalid");
  });
  it("preserves settings across restart and ignores health results for replaced credentials", async () => {
    const { config, add, request } = await setup();
    const id = await add();
    await request("/settings", "PUT", { mode: "round-robin", activeId: id });
    const pool = new AccountPool(config);
    await pool.initialize();
    expect((await pool.list()).mode).toBe("round-robin");
    const lease = await pool.choose(new Set(["file"]));
    await pool.update(lease.id, { cookie: cookie("replacement") });
    await pool.failed(lease.id, new ServiceError("upstream_auth_error", 502, "Expired"), lease.revision);
    expect((await pool.list()).accounts.find(x => x.id === lease.id)?.health.status).toBe("unknown");
  });
  it("recovers expired file credentials after a hot replacement", async () => {
    const { config, file } = await setup();
    const pool = new AccountPool(config); await pool.initialize();
    const lease = await pool.choose();
    await pool.failed(lease.id, new ServiceError("upstream_auth_error", 502, "Expired"), lease.revision);
    await expect(pool.choose()).rejects.toMatchObject({ code: "no_available_cookie" });
    await writeFile(file, cookie("replacement"));
    expect((await pool.choose()).id).toBe("file");
  });
  it("accepts Cookie header labels but rejects unsafe exports", () => {
    expect(importCookie("Cookie: " + cookie("header")).complete).toBe(true);
    expect(() => importCookie(JSON.stringify([{ name: "sessionid", value: "x;y" }]))).toThrow();
  });
});

describe("translation usage and management test", () => {
  it("counts requests once, counts multi-batch calls separately, and protects statistics", async () => {
    const { app, request, translate, config, adminDir } = await setup();
    const text = Array.from({ length: 51 }, (_, i) => `private paragraph ${i}`).join("\n\n");
    expect((await translate(text)).statusCode).toBe(200);
    const usage = (await request("/usage")).json();
    expect(usage.today).toMatchObject({ requests: 1, succeeded: 1, upstreamCalls: 2, retries: 0 });
    expect(usage.concurrency).toMatchObject({ active: 0, queued: 0 });
    expect((await app.inject({ url: "/admin/api/usage", headers: { "x-api-key": "client-key" } })).statusCode).toBe(401);
    expect((await request("/translate", "POST", { text: "private test text", model: "doubao-ai", targetLang: "zh" })).json().text).toBe("译:private test text");
    expect((await request("/usage")).json().today.requests).toBe(2);
    await app.close();
    const stored = await readFile(join(adminDir, "usage.json"), "utf8");
    expect(stored).not.toContain("private");
    const restarted = createApp(config);
    cleanup.push(() => restarted.close()); await restarted.ready();
    const { UsageStore } = await import("../../src/admin/usage.js");
    const reader = new UsageStore(adminDir, () => {});
    await reader.initialize();
    expect(reader.snapshot().today?.requests).toBe(2);
  });
  it("records failover separately and records sanitized failures", async () => {
    const { request, add, translate, mock } = await setup({ mode: "expired" });
    await add();
    expect((await translate()).statusCode).toBe(200);
    expect((await request("/usage")).json().today).toMatchObject({ requests: 1, upstreamCalls: 2, retries: 1, switches: 1 });
    mock.state.scenario = "json-scene-error";
    expect((await translate("secret-body")).statusCode).toBe(502);
    const result = await request("/usage");
    expect(result.json().today).toMatchObject({ requests: 2, succeeded: 1, failed: 1 });
    expect(result.json().failures[0].code).toBe("upstream_bad_request");
    expect(result.body).not.toContain("secret-body");
    expect(result.body).not.toContain("sensitive");
  });
  it("requires management CSRF for translation tests", async () => {
    const { app, session, request } = await setup();
    for (const headers of [{ cookie: session.headers.cookie }, { ...session.headers, origin: "https://attacker.example" }]) {
      expect((await app.inject({ method: "POST", url: "/admin/api/translate", headers,
        payload: { text: "hello", model: "doubao-ai", targetLang: "zh" } })).statusCode).toBe(403);
    }
    expect((await request("/usage")).json().today).toBeNull();
  });
  it("bounds the entire translation including upstream wait", async () => {
    const { config, mock } = await setup();
    mock.state.scenario = "slow-response";
    const app = createApp({ ...config, ADMIN_ENABLED: false, DOUBAO_TOTAL_TIMEOUT_MS: 20 }, { fetcher: mock.fetcher });
    cleanup.push(() => app.close()); await app.ready();
    const response = await app.inject({ method: "POST", url: "/v1/responses", headers: { "x-api-key": "client-key" },
      payload: { model: "doubao-ai", input: "hello", target_lang: "zh" } });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe("translation_timeout");
  });
});
