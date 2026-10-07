import { afterEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { DoubaoTranslatePlugin } from "../../src/magpie/plugin.js";
import { startMock, type Scenario } from "../fixtures/mock-doubao.js";

const cookieA = "sessionid=account-a; sid_tt=account-a; uid_tt=user-a";
const cookieB = "sessionid=account-b; sid_tt=account-b; uid_tt=user-b";
const base = "https://doubao-translate.invalid/v1";
const nativeFetch = globalThis.fetch;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function setup(scenario: Scenario = "ok", options: Record<string, unknown> = {}) {
  const mock = await startMock(scenario);
  cleanup.push(mock.close);
  const outgoing: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    outgoing.push({ url: url.href, init });
    return nativeFetch(mock.url + url.pathname + url.search, init);
  }));
  const plugin = await DoubaoTranslatePlugin({}, options);
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: cookieA }));
  return { mock, plugin, loader, outgoing };
}

function request(body: Record<string, unknown> = {}) {
  return {
    method: "POST",
    headers: { Authorization: "Bearer gateway-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "doubao-ai", messages: [{ role: "user", content: "hello" }], ...body }),
  };
}

describe("Magpie direct translation plugin", () => {
  it("registers three text-only models and preserves user configuration", async () => {
    const { plugin } = await setup();
    const cfg: any = {};
    await plugin.config(cfg);
    expect(cfg.provider["doubao-translate"].npm).toBe("@ai-sdk/openai-compatible");
    expect(Object.keys(cfg.provider["doubao-translate"].models)).toEqual([
      "doubao-ai", "volcengine-translate", "microsoft-translator",
    ]);
    expect(cfg.provider["doubao-translate"].models["doubao-ai"]).toMatchObject({
      tool_call: false, reasoning: false, modalities: { input: ["text"] },
    });
    const custom = { provider: { "doubao-translate": { name: "My translation" } } };
    await plugin.config(custom);
    expect(custom.provider["doubao-translate"]).toEqual({ name: "My translation" });
    expect(plugin.auth).not.toHaveProperty("usage");
    expect(plugin.auth).not.toHaveProperty("refresh");
  });

  it("validates and probes Header/JSON cookies with stable account labels", async () => {
    const { plugin, mock } = await setup();
    const method = plugin.auth.methods[0]!;
    const login = async (inputs: Record<string, string>) => (await method.authorize(inputs)).callback();
    expect(method.prompts[0]!.validate?.("sessionid=partial")).toBeTruthy();
    const flow = await method.authorize({ cookie: cookieA });
    expect(flow).toMatchObject({ url: "", method: "auto" });
    const header = await login({ cookie: `Cookie: ${cookieA}`, name: "Personal" });
    const json = await login({
      cookie: JSON.stringify([
        { name: "sessionid", value: "account-a", domain: ".doubao.com" },
        { name: "sid_tt", value: "account-a", domain: ".doubao.com" },
        { name: "uid_tt", value: "user-a", domain: ".doubao.com" },
        { name: "secret", value: "unrelated", domain: ".example.com" },
      ]),
      name: "Personal",
    });
    expect(header).toMatchObject({ type: "success", key: cookieA });
    expect(json).toEqual(header);
    expect(header.metadata?.email).toMatch(/^Personal \([a-f0-9]{12}\)$/);
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests.every(value => value.path.includes("user_settings"))).toBe(true);
    mock.state.authCode = 710012001;
    expect(await login({ cookie: cookieA })).toMatchObject({ type: "failed", error: expect.stringContaining("expired") });
    const count = mock.requests.length;
    expect(await login({ cookie: "bad" })).toMatchObject({ type: "failed" });
    expect(mock.requests).toHaveLength(count);
  });

  it("isolates simultaneous accounts and rereads changed auth without a Cookie file", async () => {
    const { plugin, mock, outgoing } = await setup();
    let key = cookieA;
    const a = await plugin.auth.loader(async () => ({ type: "api", key }));
    const b = await plugin.auth.loader(async () => ({ type: "api", key: cookieB }));
    expect(a.apiKey).not.toContain("sessionid");
    const results = await Promise.all([
      a.fetch(`${base}/chat/completions`, request()),
      b.fetch(`${base}/chat/completions`, request()),
    ]);
    expect(results.every(value => value.status === 200)).toBe(true);
    expect(new Set(mock.requests.map(value => value.cookie))).toEqual(new Set([cookieA, cookieB]));
    key = cookieB;
    await a.fetch(`${base}/chat/completions`, request());
    expect(mock.requests.at(-1)?.cookie).toBe(cookieB);
    expect(outgoing.every(value => value.url.startsWith("https://www.doubao.com/samantha/plugin/"))).toBe(true);
    expect(mock.requests.every(value => !value.authorization)).toBe(true);
  });

  it.each([
    ["doubao-ai", "1"], ["volcengine-translate", "0"], ["microsoft-translator", "3"],
  ])("uses %s and respects explicit target language", async (model, engine) => {
    const { loader, mock } = await setup("ok", { targetLang: "ja" });
    const res = await loader.fetch(`${base}/chat/completions`, request({ model, target_lang: "en" }));
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("译:hello");
    expect(mock.requests[0]?.body).toMatchObject({ translate_service: engine, target_lang: "en" });
    await loader.fetch(`${base}/chat/completions`, request({ model }));
    expect(mock.requests.at(-1)?.body.target_lang).toBe("ja");
  });

  it("recognizes language headers/instructions and preserves long-text formatting", async () => {
    const { loader, mock } = await setup();
    const text = Array.from({ length: 51 }, (_, i) => `item${i}`).join("\r\n\r\n");
    const res = await loader.fetch(`${base}/chat/completions`, request({
      messages: [{ role: "system", content: "Translate into English." }, { role: "user", content: text }],
    }));
    expect((await res.json()).choices[0].message.content)
      .toBe(Array.from({ length: 51 }, (_, i) => `译:item${i}`).join("\r\n\r\n"));
    expect(mock.requests.map(value => value.body.raw_text.length)).toEqual([50, 1]);
    expect(mock.requests[0]?.body.target_lang).toBe("en");
    const init = request();
    await loader.fetch(`${base}/chat/completions`, {
      ...init, headers: { ...init.headers, "X-Doubao-Target-Lang": "ja" },
    });
    expect(mock.requests.at(-1)?.body.target_lang).toBe("ja");
  });

  it.each([
    ["chat/completions", {}],
    ["responses", { input: "hello" }],
    ["messages", { max_tokens: 100 }],
  ])("returns complete SSE for %s", async (path, body) => {
    const { loader } = await setup();
    const response = await loader.fetch(`${base}/${path}`, request({ ...body, stream: true }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();
    expect(stream).toContain("译:hello");
    expect(stream).toContain(path === "responses" ? "response.completed" :
      path === "messages" ? "message_stop" : "[DONE]");
  });

  it("marks expired accounts but does not mark temporary/partial failures", async () => {
    const { loader, mock, plugin } = await setup("json-login-error");
    const expired = await loader.fetch(`${base}/chat/completions`, request({ stream: true }));
    expect(expired.status).toBe(401);
    expect(expired.headers.get("X-Magpie-Sign-In")).toBe("expired");
    expect(expired.headers.get("content-type")).toContain("application/json");
    expect(mock.requests).toHaveLength(1);
    mock.state.authCode = 710012001;
    await expect(plugin.provider.models({ models: {} }, { auth: { type: "api", key: cookieA } }))
      .rejects.toMatchObject({ signIn: "expired" });
    mock.state.authCode = 999;
    await expect(plugin.provider.models({ models: {} }, { auth: { type: "api", key: cookieA } }))
      .rejects.not.toHaveProperty("signIn");
    for (const mode of ["http-500", "partial-items"] as const) {
      mock.state.scenario = mode;
      const response = await loader.fetch(`${base}/chat/completions`, request({
        messages: [{ role: "user", content: "hello\nworld" }], stream: true,
      }));
      expect(response.status).toBe(502);
      expect(response.headers.get("X-Magpie-Sign-In")).toBeNull();
      expect(await response.text()).not.toContain("sensitive upstream");
    }
  });

  it("preserves rate limiting and does not retry by default", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return new Response("private details", { status: 429 });
    }));
    const plugin = await DoubaoTranslatePlugin({});
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: cookieA }));
    const response = await loader.fetch(`${base}/chat/completions`, request());
    expect(response.status).toBe(429);
    expect(response.headers.get("X-Magpie-Sign-In")).toBeNull();
    expect(await response.text()).not.toContain("private details");
    expect(calls).toBe(1);
  });

  it("cancels active upstream work and enforces the total timeout", async () => {
    const { loader, mock, outgoing } = await setup("slow-body", { totalTimeoutMs: 15 });
    const timedOut = await loader.fetch(`${base}/chat/completions`, request());
    expect(timedOut.status).toBe(504);
    expect((await timedOut.json()).error.code).toBe("translation_timeout");
    expect(timedOut.headers.get("X-Magpie-Sign-In")).toBeNull();
    const plugin = await DoubaoTranslatePlugin({}, { totalTimeoutMs: 1000 });
    const active = await plugin.auth.loader(async () => ({ type: "api", key: cookieA }));
    const controller = new AbortController();
    const pending = active.fetch(`${base}/chat/completions`, { ...request(), signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(mock.requests).toHaveLength(2), { interval: 1 });
    controller.abort();
    await assertion;
    expect(outgoing.at(-1)?.init?.signal?.aborted).toBe(true);
  });

  it("rejects missing auth, unsupported capabilities and invalid endpoints before upstream calls", async () => {
    const { plugin, loader, mock } = await setup();
    const unsigned = await plugin.auth.loader(async () => undefined);
    expect((await unsigned.fetch(`${base}/chat/completions`, request())).status).toBe(401);
    for (const init of [
      request({ tools: [{ type: "function", function: { name: "run" } }] }),
      request({ model: "unknown" }),
      { ...request(), body: "not json" },
      request({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }] }] }),
    ]) {
      expect((await loader.fetch(`${base}/chat/completions`, init)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await loader.fetch("https://example.com/v1/chat/completions", request())).status).toBe(400);
    expect(mock.requests).toHaveLength(0);
  });

  it("validates options and ignores service environment variables", async () => {
    await expect(DoubaoTranslatePlugin({}, { maxConcurrency: 0 })).rejects.toThrow("maxConcurrency");
    await expect(DoubaoTranslatePlugin({}, { targetLang: "unsupported" })).rejects.toThrow("targetLang");
    await expect(DoubaoTranslatePlugin({}, { unsupported: true })).rejects.toThrow("options");
    vi.stubEnv("DOUBAO_DEFAULT_TARGET_LANG", "en");
    const { loader, mock } = await setup();
    try {
      await loader.fetch(`${base}/chat/completions`, request());
      expect(mock.requests[0]?.body.target_lang).toBe("zh");
    } finally { vi.unstubAllEnvs(); }
  });

  it("loads the built package entry with only a plugin function exported", async () => {
    const module = await import(new URL("../../magpie-plugin/dist/index.mjs", import.meta.url).href);
    expect(Object.keys(module)).toEqual(["DoubaoTranslatePlugin"]);
    const plugin = await module.DoubaoTranslatePlugin({});
    expect(plugin.auth.provider).toBe("doubao-translate");
  });

  it("works through official OpenAI and Anthropic SDKs including streaming and errors", async () => {
    const { loader, mock } = await setup();
    const fetcher: typeof fetch = (input, init) => loader.fetch(input, init);
    const openai = new OpenAI({ baseURL: base, apiKey: "client-key", fetch: fetcher, maxRetries: 0 });
    const anthropic = new Anthropic({
      baseURL: new URL(base).origin, apiKey: "client-key", fetch: fetcher, maxRetries: 0,
    });
    const messages = [{ role: "user" as const, content: "hello" }];
    const chat = await openai.chat.completions.create({ model: "doubao-ai", messages });
    expect(chat.choices[0]?.message.content).toBe("译:hello");
    const stream = await openai.chat.completions.create({ model: "doubao-ai", messages, stream: true });
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
    expect(text).toBe("译:hello");
    const response = await openai.responses.create({ model: "doubao-ai", input: "hello" });
    expect(response.output_text).toBe("译:hello");
    const message = await anthropic.messages.create({ model: "doubao-ai", messages, max_tokens: 100 });
    expect(message.content[0]).toMatchObject({ type: "text", text: "译:hello" });
    mock.state.scenario = "json-login-error";
    await expect(anthropic.messages.create({ model: "doubao-ai", messages, max_tokens: 100 }))
      .rejects.toMatchObject({ status: 401, error: { type: "error", error: { type: "authentication_error" } } });
  });
});
