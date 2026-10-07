import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MFResponse, type V4FetchHandler } from "miniflare";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { startMock, type Scenario } from "../fixtures/mock-doubao.js";

const key = "workers-test-access-key";
const cookie = "sessionid=workers-cookie; sid_tt=workers-cookie; uid_tt=workers-user";
let bundle: string;
let configuration: { compatibility_date: string; compatibility_flags: string[]; vars: Record<string, string> };
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  configuration = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  const result = await build({
    entryPoints: ["src/workers/index.ts"], bundle: true, format: "esm", platform: "browser",
    target: "es2023", write: false, metafile: true,
  });
  expect(Object.keys(result.metafile!.inputs).some(path => path.includes("cookie-store") || path.includes("admin/accounts"))).toBe(false);
  expect(result.outputFiles[0]!.text).not.toMatch(/from ["']node:/);
  bundle = result.outputFiles[0]!.text;
});
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
});

async function setup(scenario: Scenario = "ok", overrides: Record<string, string> = {}, upstream?: V4FetchHandler) {
  const mock = await startMock(scenario);
  cleanup.push(mock.close);
  const outgoing: string[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle, compatibilityDate: configuration.compatibility_date,
    compatibilityFlags: configuration.compatibility_flags,
    bindings: { ...configuration.vars, API_KEY: key, DOUBAO_COOKIE: cookie, ...overrides },
    cf: false, telemetry: { enabled: false }, log: new Log(LogLevel.NONE),
    outboundService: upstream ?? (async request => {
      outgoing.push(request.url);
      const url = new URL(request.url);
      expect(url.origin).toBe("https://www.doubao.com");
      const response = await fetch(mock.url + url.pathname + url.search, {
        method: request.method, headers: Object.fromEntries(request.headers),
        body: request.method === "POST" ? await request.arrayBuffer() : undefined,
        redirect: "manual",
      });
      return new MFResponse(response.body as any, { status: response.status, headers: Object.fromEntries(response.headers) });
    }),
  }));
  cleanup.push(() => mf.dispose());
  await mf.ready;
  const post = (body: Record<string, unknown> = {}, path = "/v1/chat/completions") =>
    mf.dispatchFetch(`https://worker.test${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "doubao-ai", messages: [{ role: "user", content: "hello" }], ...body }),
    });
  return { mf, mock, outgoing, post };
}

describe("Cloudflare Workers runtime", () => {
  it("exposes health without secrets but closes protected endpoints on missing configuration", async () => {
    const { mf, mock } = await setup("ok", { API_KEY: "", DOUBAO_COOKIE: "" });
    const health = await mf.dispatchFetch("https://worker.test/health");
    expect(await health.json()).toEqual({ status: "ok" });
    const response = await mf.dispatchFetch("https://worker.test/v1/models");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "configuration_error" } });
    expect(mock.requests).toHaveLength(0);
  });

  it("requires API Key, accepts x-api-key, and never returns credentials", async () => {
    const { mf, mock } = await setup();
    for (const authorization of ["", "Bearer wrong-key", "Basic token"]) {
      const response = await mf.dispatchFetch("https://worker.test/v1/models", { headers: { authorization } });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-request-id")).toBeTruthy();
      const text = await response.text();
      expect(text).not.toContain(cookie);
      expect(text).not.toContain(key);
    }
    const response = await mf.dispatchFetch("https://worker.test/v1/models?limit=1", { headers: { "x-api-key": key } });
    expect(await response.json()).toMatchObject({ data: [{ id: "doubao-ai" }], has_more: true });
    expect(mock.requests).toHaveLength(0);
  });

  it("handles browser preflight without authentication and rejects forbidden origins and headers", async () => {
    const { mf, mock } = await setup("ok", { CORS_ORIGINS: "https://client.test" });
    const headers = { Origin: "https://client.test", "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization,x-doubao-target-lang" };
    const response = await mf.dispatchFetch("https://worker.test/v1/chat/completions", { method: "OPTIONS", headers });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.test");
    const denied = await mf.dispatchFetch("https://worker.test/v1/models", {
      headers: { Origin: "https://unknown.test", Authorization: `Bearer ${key}` },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const invalid = await mf.dispatchFetch("https://worker.test/v1/chat/completions", {
      method: "OPTIONS", headers: { ...headers, "Access-Control-Request-Headers": "cookie" },
    });
    expect(invalid.status).toBe(400);
    expect(mock.requests).toHaveLength(0);
  });

  it.each([
    ["doubao-ai", "1"], ["volcengine-translate", "0"], ["microsoft-translator", "3"],
  ])("translates using %s without forwarding the client's access key", async (model, engine) => {
    const { post, mock, outgoing } = await setup();
    const response = await post({ model, target_lang: "ja" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "译:hello" } }] });
    expect(mock.requests[0]).toMatchObject({ cookie, body: { target_lang: "ja", translate_service: engine } });
    expect(mock.requests[0]?.authorization).toBeUndefined();
    expect(outgoing).toEqual(["https://www.doubao.com/samantha/plugin/stream_article_translate"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("restores ordered paragraphs across batches in the Workers runtime", async () => {
    const { post, mock } = await setup("out-of-order");
    const text = Array.from({ length: 51 }, (_, i) => `item${i}`).join("\r\n\r\n");
    const response = await post({ messages: [{ role: "user", content: text }] });
    expect(response.status).toBe(200);
    expect(mock.requests.map(value => value.body.raw_text.length)).toEqual([50, 1]);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: Array.from({ length: 51 }, (_, i) => `译:item${i}`).join("\r\n\r\n") } }],
    });
  });

  it("keeps Immersive Translate separators out of upstream text and restores them exactly", async () => {
    const { post, mock } = await setup();
    const response = await post({ messages: [{
      role: "user", content: "Translate to Chinese:\n\nhello\r\n\r\n%%\r\n\r\nworld",
    }] });
    expect(response.status).toBe(200);
    expect(mock.requests[0]?.body.raw_text).toEqual(["hello", "world"]);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "译:hello\r\n\r\n%%\r\n\r\n译:world" } }],
    });
    for (const content of ["<yaml>\n- id: 1\n  source: hello\n</yaml>", "<p>hello</p>", "%%\n%%"]) {
      expect((await post({ messages: [{ role: "user", content }] })).status).toBe(400);
    }
    expect(mock.requests).toHaveLength(1);
  });

  it("leaves literal separators available to ordinary translation clients", async () => {
    const { post, mock } = await setup("ok", { TRANSLATION_PROFILE: "plain" });
    expect((await post({ messages: [{ role: "user", content: "hello\n%%\nworld" }] })).status).toBe(200);
    expect(mock.requests[0]?.body.raw_text).toEqual(["hello", "%%", "world"]);
  });

  it("refuses redirects without following them or returning a successful translation", async () => {
    const { post, mock } = await setup("redirect");
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "upstream_network_error" } });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.path).toContain("stream_article_translate");
  });

  it("supports OpenAI SDK non-stream and SSE plus Responses and Anthropic", async () => {
    const { mf } = await setup();
    const address = (await mf.ready).href;
    const openai = new OpenAI({ apiKey: key, baseURL: `${address}v1`, maxRetries: 0 });
    expect((await openai.chat.completions.create({
      model: "doubao-ai", messages: [{ role: "user", content: "hello" }],
    })).choices[0]?.message.content).toBe("译:hello");
    const stream = await openai.chat.completions.create({
      model: "doubao-ai", messages: [{ role: "user", content: "hello" }], stream: true,
    });
    let text = "";
    for await (const part of stream) text += part.choices[0]?.delta.content ?? "";
    expect(text).toBe("译:hello");
    expect((await openai.responses.create({ model: "doubao-ai", input: "hello" })).output_text).toBe("译:hello");
    const anthropic = new Anthropic({ apiKey: key, baseURL: address, maxRetries: 0 });
    const message = await anthropic.messages.create({
      model: "doubao-ai", max_tokens: 100, messages: [{ role: "user", content: "hello" }],
    });
    expect(message.content[0]).toMatchObject({ type: "text", text: "译:hello" });
    const responseStream = await openai.responses.create({ model: "doubao-ai", input: "hello", stream: true });
    let responseText = "";
    for await (const event of responseStream) {
      if (event.type === "response.output_text.delta") responseText += event.delta;
    }
    expect(responseText).toBe("译:hello");
    const messageStream = await anthropic.messages.create({
      model: "doubao-ai", max_tokens: 100, messages: [{ role: "user", content: "hello" }], stream: true,
    });
    let messageText = "";
    for await (const event of messageStream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") messageText += event.delta.text;
    }
    expect(messageText).toBe("译:hello");
  });

  it("does not return SSE success or partial text when upstream results are incomplete", async () => {
    const { post } = await setup("partial-items");
    const response = await post({ stream: true, messages: [{ role: "user", content: "hello\nworld" }] });
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "upstream_incomplete_result" } });
  });

  it.each([256 * 1024 + 1, 1024 * 1024 + 1])("bounds output and upstream body at %s bytes", async length => {
    const { post } = await setup("ok", {}, () => new MFResponse(
      `event: json\ndata: ${JSON.stringify({ code: 0, data: { items: [{ index: 0, res: "x".repeat(length) }] } })}\n\n` +
      "event: done\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } },
    ));
    const response = await post({ stream: true });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "upstream_stream_error" } });
  });

  it("distinguishes confirmed expiry from access refusals and propagates upstream rate limits", async () => {
    const { post, mf, mock } = await setup("json-login-error");
    expect(await (await post()).json()).toMatchObject({ error: { code: "upstream_auth_error" } });
    let upstreamStatus = 403;
    const refused = await setup("ok", {}, () => new MFResponse("private upstream body", { status: upstreamStatus }));
    const response = await refused.post();
    expect(await response.json()).toMatchObject({ error: { code: "upstream_http_error" } });
    upstreamStatus = 429;
    expect((await refused.post()).status).toBe(429);
    mock.state.authCode = 710012001;
    const status = await mf.dispatchFetch("https://worker.test/auth/status", { headers: { "x-api-key": key } });
    expect(await status.json()).toMatchObject({ authenticated: false, reason: "cookie_expired" });
  });

  it("enforces upstream timeouts", async () => {
    const { post } = await setup("slow-response", { DOUBAO_REQUEST_TIMEOUT_MS: "100" });
    const response = await post();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "upstream_timeout" } });
  });

  it("bounds concurrent requests and releases the slot after a failed upstream call", async () => {
    const { post, mock } = await setup("slow-response", { DOUBAO_MAX_CONCURRENCY: "1", DOUBAO_QUEUE_MAX: "0" });
    const first = post();
    await vi.waitFor(() => expect(mock.requests).toHaveLength(1), { interval: 5, timeout: 1000 });
    const second = await post();
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: { code: "queue_full" } });
    expect((await first).status).toBe(502);
    mock.state.scenario = "ok";
    expect((await post()).status).toBe(200);
  });

  it("rejects malformed, oversized and unsupported requests before calling Doubao", async () => {
    const { post, mf, mock } = await setup();
    const headers = { "x-api-key": key, "content-type": "application/json" };
    expect((await mf.dispatchFetch("https://worker.test/v1/chat/completions", {
      method: "POST", headers, body: "{bad",
    })).status).toBe(400);
    expect((await mf.dispatchFetch("https://worker.test/v1/chat/completions", {
      method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(65536) }),
    })).status).toBe(413);
    expect((await post({ messages: [{ role: "user", content: "x".repeat(20001) }] })).status).toBe(413);
    expect((await post({ messages: [{ role: "user", content: Array(201).fill("x").join("\n") }] })).status).toBe(413);
    expect((await post({ tools: [{ type: "function" }] })).status).toBe(400);
    expect((await post({ model: "unknown" })).status).toBe(404);
    expect((await mf.dispatchFetch("https://worker.test/v1/chat/completions", { headers })).status).toBe(405);
    expect((await mf.dispatchFetch("https://worker.test/missing", { headers })).status).toBe(404);
    expect(mock.requests).toHaveLength(0);
  });
});
