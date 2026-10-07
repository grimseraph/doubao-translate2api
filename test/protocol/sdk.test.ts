import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { startMock, type Scenario } from "../fixtures/mock-doubao.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });
async function setup(scenario: Scenario = "ok", options: NodeJS.ProcessEnv = {}, logs?: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "doubao-sdk-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "cookie.txt"), "sessionid=cookie-secret; sid_tt=cookie-secret; uid_tt=cookie-secret");
  const mock = await startMock(scenario); cleanup.push(mock.close);
  const app = createApp(loadConfig({
    API_KEY: "api-secret", LOG_LEVEL: "silent", ADMIN_ENABLED: "false", DOUBAO_COOKIE_FILE: join(dir, "cookie.txt"), ...options,
  }), {
    fetcher: mock.fetcher,
    ...(logs ? { logger: {
      level: "info",
      stream: new Writable({ write(chunk, _encoding, callback) { logs.push(chunk.toString()); callback(); } }),
    } } : {}),
  });
  cleanup.push(() => app.close());
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const openai = new OpenAI({ apiKey: "api-secret", baseURL: url + "/v1", maxRetries: 0 });
  const anthropic = new Anthropic({ apiKey: "api-secret", baseURL: url, maxRetries: 0 });
  return { app, mock, openai, anthropic, url };
}
const chat = {
  model: "doubao-ai",
  messages: [
    { role: "system", content: "Translate into Simplified Chinese." },
    { role: "user", content: "Hello world" },
  ],
} as const;
const chatBody = () => ({ ...chat, messages: chat.messages.map(x => ({ ...x })) });
const responses = { model: "doubao-ai", instructions: "Translate into Simplified Chinese.", input: "Hello world" };
const anthBody = () => ({
  model: "doubao-ai", max_tokens: 1024, system: "Translate into Simplified Chinese.",
  messages: [{ role: "user" as const, content: "Hello world" }],
});
const paths = ["/v1/chat/completions", "/v1/responses", "/v1/messages"];
const bodies = () => [chatBody(), responses, anthBody()];

describe("official SDK compatibility", () => {
  it("lists and retrieves exactly three models", async () => {
    const { openai } = await setup();
    expect((await openai.models.list()).data.map(x => x.id)).toEqual(["doubao-ai", "volcengine-translate", "microsoft-translator"]);
    expect((await openai.models.retrieve("volcengine-translate")).owned_by).toBe("volcengine");
    await expect(openai.models.retrieve("unknown")).rejects.toMatchObject({ status: 404 });
  });
  it("supports Anthropic model discovery, retrieval and automatic pagination without upstream calls", async () => {
    const { anthropic, mock, app } = await setup();
    const listing = await anthropic.models.list();
    expect(listing.has_more).toBe(false);
    expect(listing.first_id).toBe("doubao-ai");
    expect(listing.last_id).toBe("microsoft-translator");
    expect(listing.data.every(model => model.type === "model" && model.display_name && model.created_at)).toBe(true);
    const ids: string[] = [];
    for await (const model of anthropic.models.list({ limit: 1 })) ids.push(model.id);
    expect(ids).toEqual(["doubao-ai", "volcengine-translate", "microsoft-translator"]);
    const earlier: string[] = [];
    for await (const model of anthropic.models.list({ limit: 1, before_id: "microsoft-translator" })) earlier.push(model.id);
    expect(earlier).toEqual(["volcengine-translate", "doubao-ai"]);
    expect((await anthropic.models.retrieve("doubao-ai")).display_name).toBe("Doubao AI Translation");
    for (const query of ["limit=0", "limit=NaN", "after_id=unknown", "before_id=unknown"])
      expect((await app.inject({ url: "/v1/models?" + query, headers: { "x-api-key": "api-secret" } })).statusCode).toBe(400);
    const empty = await app.inject({ url: "/v1/models?after_id=microsoft-translator", headers: { "x-api-key": "api-secret" } });
    expect(empty.json()).toMatchObject({ data: [], has_more: false, first_id: null, last_id: null });
    expect(mock.requests).toHaveLength(0);
  });
  it("accepts protocol probe text with default Chinese across all three SDKs and streams", async () => {
    const { openai, anthropic, mock } = await setup();
    const message = { role: "user" as const, content: "Say OK" };
    expect((await openai.chat.completions.create({ model: "doubao-ai", messages: [message] })).choices[0]?.message.content).toBe("译:Say OK");
    expect((await openai.responses.create({ model: "doubao-ai", input: "Say OK" })).output_text).toBe("译:Say OK");
    expect((await anthropic.messages.create({ model: "doubao-ai", max_tokens: 32, messages: [message] })).content[0]).toEqual({ type: "text", text: "译:Say OK" });
    const chatFinal = await openai.chat.completions.stream({ model: "doubao-ai", messages: [message] }).finalChatCompletion();
    expect(chatFinal.choices[0]?.message.content).toBe("译:Say OK");
    expect((await openai.responses.stream({ model: "doubao-ai", input: "Say OK" }).finalResponse()).output_text).toBe("译:Say OK");
    expect((await anthropic.messages.stream({ model: "doubao-ai", max_tokens: 32, messages: [message] }).finalMessage()).content[0]).toEqual({ type: "text", text: "译:Say OK" });
    expect(mock.requests).toHaveLength(6);
    expect(mock.requests.every(request => request.body.target_lang === "zh")).toBe(true);
  });
  it("uses a configured default while allowing body, header and prompt overrides", async () => {
    const { app, mock } = await setup("ok", { DOUBAO_DEFAULT_TARGET_LANG: "zh-TW" });
    const inputs = [
      { payload: { model: "doubao-ai", input: "Hello" }, headers: {}, language: "zh-Hant" },
      { payload: { model: "doubao-ai", target_lang: "ja", input: "Hello" }, headers: {}, language: "ja" },
      { payload: { model: "doubao-ai", input: "Hello" }, headers: { "x-doubao-target-lang": "ko" }, language: "ko" },
      { payload: { model: "doubao-ai", instructions: "Translate into French.", input: "Hello" }, headers: {}, language: "fr" },
    ];
    for (const input of inputs) {
      const result = await app.inject({ method: "POST", url: "/v1/responses", headers: { "x-api-key": "api-secret", ...input.headers }, payload: input.payload });
      expect(result.statusCode).toBe(200);
      expect(mock.requests.at(-1)?.body.target_lang).toBe(input.language);
    }
    expect((await app.inject({ url: "/info", headers: { "x-api-key": "api-secret" } })).json().default_target_lang).toBe("zh-Hant");
  });
  it("supports chat JSON, stream iteration, usage and final completion", async () => {
    const { openai } = await setup();
    const result = await openai.chat.completions.create(chatBody());
    expect(result.choices[0]?.message.content).toBe("译:Hello world");
    expect(result.usage?.total_tokens).toBe(0);
    const stream = await openai.chat.completions.create({ ...chatBody(), stream: true, stream_options: { include_usage: true } });
    let text = "", usage = false;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? "";
      if (chunk.usage) usage = chunk.usage.total_tokens === 0;
    }
    expect(text).toBe("译:Hello world"); expect(usage).toBe(true);
    const completion = await openai.chat.completions.stream(chatBody()).finalChatCompletion();
    expect(completion.choices[0]?.message.content).toBe("译:Hello world");
  });
  it("supports Responses JSON, typed events and final response helper", async () => {
    const { openai } = await setup();
    const result = await openai.responses.create(responses);
    expect(result.output_text).toBe("译:Hello world");
    const stream = await openai.responses.create({ ...responses, stream: true });
    const types: string[] = [], sequences: number[] = [];
    let text = "";
    for await (const event of stream) {
      types.push(event.type);
      if ("sequence_number" in event) sequences.push(event.sequence_number);
      if (event.type === "response.output_text.delta") text += event.delta;
    }
    expect(text).toBe("译:Hello world");
    expect(types.at(-1)).toBe("response.completed");
    expect(sequences).toEqual(sequences.map((_, i) => i));
    const final = await openai.responses.stream(responses).finalResponse();
    expect(final.output_text).toBe("译:Hello world");
    expect(final.status).toBe("completed");
  });
  it("supports Anthropic JSON, stream iteration and final message helper", async () => {
    const { anthropic } = await setup();
    const result = await anthropic.messages.create(anthBody());
    expect(result.content[0]).toEqual({ type: "text", text: "译:Hello world" });
    const stream = await anthropic.messages.create({ ...anthBody(), stream: true });
    let text = "";
    for await (const event of stream)
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") text += event.delta.text;
    expect(text).toBe("译:Hello world");
    const final = await anthropic.messages.stream(anthBody()).finalMessage();
    expect(final.content[0]).toEqual({ type: "text", text: "译:Hello world" });
    expect(final.stop_reason).toBe("end_turn");
  });
});

describe("service behavior", () => {
  it("has public health, protected diagnostics and auth header precedence", async () => {
    const { app, mock } = await setup();
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/" })).statusCode).toBe(200);
    expect(mock.requests).toHaveLength(0);
    for (const path of ["/info", "/auth/status", "/v1/models"])
      expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect((await app.inject({ url: "/info", headers: { "x-api-key": "api-secret" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/info", headers: { authorization: "Bearer bad", "x-api-key": "api-secret" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/info", headers: { authorization: "Bearer api-secret", "x-api-key": "bad" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/auth/status", headers: { authorization: "Bearer api-secret" } })).json().authenticated).toBe(true);
  });
  it.each(["doubao-ai", "volcengine-translate", "microsoft-translator"])("routes %s to the right engine", async model => {
    const { app, mock } = await setup();
    const result = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": "api-secret" },
      payload: { model, target_lang: "ja", doubao_scene: 3, messages: [{ role: "user", content: "hello" }] },
    });
    expect(result.statusCode).toBe(200);
    expect(mock.requests[0]?.body.translate_service).toBe({ "doubao-ai": "1", "volcengine-translate": "0", "microsoft-translator": "3" }[model]);
    expect(mock.requests[0]?.body.scene).toBe(3);
  });
  it.each(paths)("supports explicit language on %s", async path => {
    const { app, mock } = await setup();
    const body = bodies()[paths.indexOf(path)]!;
    const result = await app.inject({
      method: "POST", url: path, headers: { authorization: "Bearer api-secret", "x-doubao-target-lang": "ko" },
      payload: { ...body, target_lang: "zh-TW" },
    });
    expect(result.statusCode).toBe(200);
    expect(mock.requests[0]?.body.target_lang).toBe("zh-Hant");
  });
  it("extracts text blocks, the last user and Responses message input", async () => {
    const { app, mock } = await setup();
    for (const [path, body] of [
      ["/v1/chat/completions", { model: "doubao-ai", target_lang: "zh", messages: [
        { role: "user", content: "old" }, { role: "assistant", content: "previous" },
        { role: "user", content: [{ type: "text", text: "new" }] },
      ] }],
      ["/v1/responses", { model: "doubao-ai", instructions: "Translate to Chinese", input: [
        { role: "user", content: [{ type: "input_text", text: "new" }] },
      ] }],
      ["/v1/messages", { model: "doubao-ai", max_tokens: 3, system: [{ type: "text", text: "Translate to Chinese" }],
        messages: [{ role: "user", content: [{ type: "text", text: "new" }] }] }],
    ] as const) {
      expect((await app.inject({ method: "POST", url: path, headers: { "x-api-key": "api-secret" }, payload: body })).statusCode).toBe(200);
      expect(mock.requests.at(-1)?.body.raw_text).toEqual(["new"]);
    }
  });
  it.each(paths)("rejects unsupported features and input on %s", async path => {
    const { app, mock } = await setup();
    for (const extra of [
      { tools: [{ type: "function" }] }, { tool_choice: "auto" }, { response_format: { type: "json_schema" } },
      { reasoning: { effort: "high" } }, { n: 2 }, { modalities: ["audio"] }, { previous_response_id: "resp_old" },
    ]) {
      const response = await app.inject({
        method: "POST", url: path, headers: { "x-api-key": "api-secret" }, payload: { ...bodies()[paths.indexOf(path)], ...extra },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.type).toBe("invalid_request_error");
    }
    const content = [{ type: path === "/v1/responses" ? "input_image" : "image", source: {} }];
    const body = path === "/v1/responses" ? { model: "doubao-ai", target_lang: "zh", input: [{ role: "user", content }] } :
      { model: "doubao-ai", target_lang: "zh", messages: [{ role: "user", content }] };
    expect((await app.inject({ method: "POST", url: path, headers: { "x-api-key": "api-secret" }, payload: body })).statusCode).toBe(400);
    expect(mock.requests).toHaveLength(0);
  });
  it.each(paths)("returns upstream failures before SSE headers on %s", async path => {
    const { app } = await setup("json-login-error");
    const response = await app.inject({
      method: "POST", url: path, headers: { "x-api-key": "api-secret" },
      payload: { ...bodies()[paths.indexOf(path)], stream: true },
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).not.toContain("sensitive upstream");
  });
  it("validates scenes, empty input and body size while defaulting absent language to Chinese", async () => {
    const { app } = await setup();
    for (const extra of [{ doubao_scene: "2" }, { doubao_scene: 7 }, { target_lang: "xx" }, { messages: [{ role: "user", content: "" }] }]) {
      expect((await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": "api-secret" }, payload: { ...chatBody(), ...extra },
      })).statusCode).toBe(400);
    }
    const missing = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": "api-secret" },
      payload: { model: "doubao-ai", messages: [{ role: "user", content: "hello" }] },
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().choices[0].message.content).toBe("译:hello");
    const large = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": "api-secret" },
      payload: { ...chatBody(), messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }] },
    });
    expect(large.statusCode).toBe(413);
  });
  it("allows configured browser preflight and omits CORS by default", async () => {
    const { app } = await setup("ok", { CORS_ORIGINS: "https://client.example.com" });
    const preflight = await app.inject({
      method: "OPTIONS", url: "/v1/chat/completions",
      headers: { origin: "https://client.example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://client.example.com");
    const { app: noCors } = await setup();
    expect((await noCors.inject({ url: "/health", headers: { origin: "https://client.example.com" } }))
      .headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("keeps secrets and source/translation out of logs", async () => {
    const logs: string[] = [];
    const { app, mock } = await setup("ok", {}, logs);
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": "api-secret" }, payload: chatBody() });
    mock.state.scenario = "json-login-error";
    await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": "api-secret" }, payload: chatBody() });
    const text = logs.join("");
    expect(text).toContain("Translation completed");
    for (const secret of ["api-secret", "cookie-secret", "Hello world", "译:Hello world", "sensitive upstream"])
      expect(text).not.toContain(secret);
  });
  it("tolerates empty capability fields and ignores generation controls", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: { "x-api-key": "api-secret" },
      payload: { ...chatBody(), tools: [], functions: [], tool_choice: "none", n: 1, temperature: 0.7,
        response_format: { type: "text" }, max_tokens: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("译:Hello world");
  });
  it("requires explicit no-auth configuration and sanitizes malformed JSON", async () => {
    const { app } = await setup("ok", { ALLOW_NO_AUTH: "true" });
    expect((await app.inject({ url: "/v1/models" })).statusCode).toBe(200);
    const result = await app.inject({
      method: "POST", url: "/v1/messages", headers: { "Content-Type": "application/json" }, payload: '{"secret-original"',
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().type).toBe("error");
    expect(result.body).not.toContain("secret-original");
  });
  it("aborts active upstream requests and releases the concurrency slot", async () => {
    const { url, mock } = await setup("slow-response", {
      DOUBAO_MAX_CONCURRENCY: "1", DOUBAO_QUEUE_MAX: "0", DOUBAO_MAX_RETRIES: "0",
    });
    const controller = new AbortController();
    const pending = fetch(url + "/v1/chat/completions", {
      method: "POST", headers: { "x-api-key": "api-secret", "Content-Type": "application/json" },
      body: JSON.stringify(chatBody()), signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    for (let i = 0; i < 100 && !mock.requests.length; i++) await delay(5);
    expect(mock.requests).toHaveLength(1);
    controller.abort(); await rejected; await delay(30);
    mock.state.scenario = "ok";
    const next = await fetch(url + "/v1/chat/completions", {
      method: "POST", headers: { "x-api-key": "api-secret", "Content-Type": "application/json" }, body: JSON.stringify(chatBody()),
    });
    expect(next.status).toBe(200); await next.text();
    expect(mock.requests).toHaveLength(2);
  });
});
