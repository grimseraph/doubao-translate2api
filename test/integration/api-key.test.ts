import { mkdtemp, writeFile, readFile, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, it, expect } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup(env: NodeJS.ProcessEnv = {}, logs?: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "doubao-api-key-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ LOG_LEVEL: "silent", ADMIN_DATA_DIR: dir, DOUBAO_COOKIE_FILE: join(dir, "cookie.txt"), ...env });
  const app = createApp(config, logs ? { logger: {
    level: "info", stream: new Writable({ write(chunk, _encoding, callback) { logs.push(String(chunk)); callback(); } }),
  } } : {});
  cleanup.push(() => app.close());
  await app.ready();
  const path = join(dir, "api-key.txt");
  const password = config.ADMIN_ENABLED ? (await readFile(join(dir, "initial-password.txt"), "utf8")).trim() : "";
  const login = config.ADMIN_ENABLED ? await app.inject({
    method: "POST", url: "/admin/api/login", payload: { password },
  }) : undefined;
  const cookieHeader = login?.headers["set-cookie"];
  const headers = { cookie: (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";")[0] ?? "",
    "x-admin-csrf": login?.json().csrf ?? "" };
  const request = (url: string, method: "GET" | "POST" = "GET") => app.inject({
    url: "/admin/api" + url, method, headers, ...(method === "POST" ? { payload: {} } : {}),
  });
  const models = (key?: string) => app.inject({ url: "/v1/models", headers: key ? { "x-api-key": key } : {} });
  return { app, config, dir, path, password, headers, request, models };
}

describe("generated API key lifecycle", () => {
  it("generates a private persistent key while keeping authentication required", async () => {
    const { app, config, path, request, models } = await setup();
    const key = (await readFile(path, "utf8")).trim();
    expect(key).toMatch(/^dbt_[A-Za-z0-9_-]{43}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await models()).statusCode).toBe(401);
    expect((await models("incorrect")).statusCode).toBe(401);
    expect((await models(key)).statusCode).toBe(200);
    expect((await request("/api-key")).json()).toEqual({ source: "generated", count: 1, canRotate: true });
    expect((await request("/api-key/reveal", "POST")).json()).toEqual({ key });
    await app.close();
    const restarted = createApp(config); cleanup.push(() => restarted.close());
    await restarted.ready();
    expect((await readFile(path, "utf8")).trim()).toBe(key);
    expect((await restarted.inject({ url: "/v1/models", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
  });
  it("protects metadata, reveal and rotation with management sessions, CSRF and origin checks", async () => {
    const { app, headers, path } = await setup();
    const key = (await readFile(path, "utf8")).trim();
    for (const [url, method] of [["/api-key", "GET"], ["/api-key/reveal", "POST"], ["/api-key/rotate", "POST"]] as const) {
      for (const input of [{}, { "x-api-key": key }])
        expect((await app.inject({ url: "/admin/api" + url, method, headers: input,
          ...(method === "POST" ? { payload: {} } : {}) })).statusCode).toBe(401);
    }
    for (const url of ["/api-key/reveal", "/api-key/rotate"]) {
      for (const input of [{ cookie: headers.cookie }, { ...headers, origin: "https://other.example" }])
        expect((await app.inject({ url: "/admin/api" + url, method: "POST", headers: input, payload: {} })).statusCode).toBe(403);
    }
    expect((await readFile(path, "utf8")).trim()).toBe(key);
  });
  it("rotates atomically, invalidates the old key immediately and preserves the new key after restart", async () => {
    const { app, config, path, request, models } = await setup();
    const old = (await readFile(path, "utf8")).trim();
    expect((await request("/api-key/rotate", "POST")).statusCode).toBe(200);
    const next = (await request("/api-key/reveal", "POST")).json().key;
    expect(next).not.toBe(old);
    expect((await readFile(path, "utf8")).trim()).toBe(next);
    expect((await models(old)).statusCode).toBe(401);
    expect((await models(next)).statusCode).toBe(200);
    await app.close();
    const restarted = createApp(config); cleanup.push(() => restarted.close()); await restarted.ready();
    expect((await restarted.inject({ url: "/v1/models", headers: { "x-api-key": next } })).statusCode).toBe(200);
  });
  it("keeps the working key on a failed save and serializes concurrent rotations", async () => {
    const { path, request, models } = await setup();
    const old = (await readFile(path, "utf8")).trim();
    await rm(path); await mkdir(path);
    const failed = await request("/api-key/rotate", "POST");
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe("api_key_storage_error");
    expect((await models(old)).statusCode).toBe(200);
    await rm(path, { recursive: true });
    const results = await Promise.all([request("/api-key/rotate", "POST"), request("/api-key/rotate", "POST")]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200]);
    const key = (await readFile(path, "utf8")).trim();
    expect((await request("/api-key/reveal", "POST")).json().key).toBe(key);
    expect((await models(key)).statusCode).toBe(200);
    expect((await models(old)).statusCode).toBe(401);
  });
  it("fails startup for corrupt or unreadable stored keys without replacing them", async () => {
    const { app, config, path } = await setup();
    await app.close();
    for (const directory of [false, true]) {
      await rm(path, { recursive: true, force: true });
      if (directory) await mkdir(path);
      else await writeFile(path, "private-invalid-value");
      const restarted = createApp(config); cleanup.push(() => restarted.close());
      await expect(restarted.ready()).rejects.toMatchObject({ code: "api_key_storage_error" });
      if (directory) expect((await stat(path)).isDirectory()).toBe(true);
      else expect(await readFile(path, "utf8")).toBe("private-invalid-value");
    }
  });
  it("works without the management UI and does not leak generated keys through logs or public routes", async () => {
    const logs: string[] = [];
    const managed = await setup({}, logs);
    const key = (await readFile(managed.path, "utf8")).trim();
    await managed.request("/api-key/reveal", "POST");
    await managed.models("bad-key");
    for (const url of ["/", "/health", "/admin", "/info"]) {
      const response = await managed.app.inject({ url, headers: { "x-api-key": key } });
      expect(response.body).not.toContain(key);
      expect(response.body).not.toContain(managed.password);
    }
    expect(logs.join("")).not.toContain(key);
    expect(logs.join("")).not.toContain(managed.password);
    const disabledUI = await setup({ ADMIN_ENABLED: "false" });
    const fileKey = (await readFile(disabledUI.path, "utf8")).trim();
    expect((await disabledUI.models(fileKey)).statusCode).toBe(200);
    expect((await disabledUI.app.inject({ url: "/admin", headers: { "x-api-key": fileKey } })).statusCode).toBe(404);
  });
});

describe("configured API keys", () => {
  it("gives environment keys precedence and rejects management rotation", async () => {
    const { path, config, app, request, models } = await setup({ API_KEY: "manual-key" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await request("/api-key")).json()).toEqual({ source: "environment", count: 1, canRotate: false });
    expect((await request("/api-key/reveal", "POST")).json().key).toBe("manual-key");
    expect((await request("/api-key/rotate", "POST")).json().error.code).toBe("api_key_managed_externally");
    expect((await models("manual-key")).statusCode).toBe(200);
    await writeFile(path, "invalid-generated-file");
    await app.close();
    const restarted = createApp(config); cleanup.push(() => restarted.close()); await restarted.ready();
    expect((await restarted.inject({ url: "/v1/models", headers: { "x-api-key": "manual-key" } })).statusCode).toBe(200);
    expect(await readFile(path, "utf8")).toBe("invalid-generated-file");
  });
  it("preserves API_KEYS precedence and both configured keys", async () => {
    const { request, models } = await setup({ API_KEY: "ignored-key", API_KEYS: "key-one, key-two" });
    expect((await request("/api-key")).json()).toEqual({ source: "environment", count: 2, canRotate: false });
    expect((await request("/api-key/reveal", "POST")).json().key).toBe("key-one");
    expect((await models("ignored-key")).statusCode).toBe(401);
    for (const key of ["key-one", "key-two"]) expect((await models(key)).statusCode).toBe(200);
  });
  it("honors explicit no-auth mode without generating or exposing a key", async () => {
    const { request, models, path } = await setup({ ALLOW_NO_AUTH: "true" });
    expect((await models()).statusCode).toBe(200);
    expect((await request("/api-key")).json()).toEqual({ source: "disabled", count: 0, canRotate: false });
    expect((await request("/api-key/reveal", "POST")).json().error.code).toBe("api_auth_disabled");
    expect((await request("/api-key/rotate", "POST")).statusCode).toBe(409);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
