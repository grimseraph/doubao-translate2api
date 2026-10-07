import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MFResponse, type V4FetchHandler } from "miniflare";
import OpenAI from "openai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/workers-lite/index.js";

const key = "lite-test-access-key";
const cookie = "sessionid=lite-cookie; sid_tt=lite-cookie; uid_tt=lite-user";
let bundle: string;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  const result = await build({
    entryPoints: ["src/workers-lite/index.ts"], bundle: true, minify: true,
    format: "esm", platform: "browser", target: "es2023", write: false, metafile: true,
  });
  expect(Object.keys(result.metafile!.inputs)).toEqual(["src/workers-lite/index.ts"]);
  expect(result.outputFiles).toHaveLength(1);
  expect(result.outputFiles[0]!.contents.byteLength).toBeLessThanOrEqual(32_000);
  expect(Buffer.byteLength(await readFile("src/workers-lite/index.ts", "utf8"))).toBeLessThanOrEqual(32_000);
  bundle = await readFile("deploy/workers-lite/worker.js", "utf8");
  expect(bundle).toBe(result.outputFiles[0]!.text);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const finish of cleanup.splice(0).reverse()) await finish();
});

async function setup(outbound?: V4FetchHandler, bindings: Record<string, string> = {}) {
  const requests: Array<{ body: any; headers: Headers }> = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle, compatibilityDate: "2026-10-06",
    bindings: { API_KEY: key, DOUBAO_COOKIE: cookie, ...bindings },
    cf: false, telemetry: { enabled: false }, log: new Log(LogLevel.NONE),
    outboundService: async (request, context) => {
      expect(request.url).toBe("https://www.doubao.com/samantha/plugin/stream_article_translate");
      requests.push({ body: await request.clone().json(), headers: new Headers(Object.fromEntries(request.headers)) });
      if (outbound) return outbound(request, context);
      const items = requests.at(-1)!.body.raw_text.map((text: string, index: number) => ({ index, res: `译:${text}` })).reverse();
      return sse(items);
    },
  }));
  cleanup.push(() => mf.dispose());
  await mf.ready;
  const post = (body: Record<string, unknown> = {}) => mf.dispatchFetch("https://worker.test/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "doubao-ai", messages: [{ role: "user", content: "hello" }], ...body }),
  });
  return { mf, post, requests };
}
function sse(items: unknown[], done = true) {
  return new MFResponse(
    `event: json\ndata: ${JSON.stringify({ code: 0, data: { items } })}\n\n` +
    (done ? "event: done\ndata: {}\n\n" : ""), { headers: { "content-type": "text/event-stream" } },
  );
}

describe("Lite Worker single-file runtime", () => {
  it("allows public health and preflight, but protects translation and returns CORS on errors", async () => {
    const { mf, requests } = await setup();
    expect(await (await mf.dispatchFetch("https://worker.test/health")).json()).toMatchObject({ status: "ok" });
    expect((await mf.dispatchFetch("https://worker.test/v1/chat/completions", { method: "OPTIONS" })).status).toBe(204);
    const denied = await mf.dispatchFetch("https://worker.test/v1/chat/completions", { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe("*");
    expect(denied.headers.get("x-request-id")).toBeTruthy();
    expect(await denied.text()).not.toContain(cookie);
    expect(requests).toHaveLength(0);
  });

  it("fails closed when secrets are invalid", async () => {
    const { post, requests } = await setup(undefined, { DOUBAO_COOKIE: "sessionid=only" });
    expect((await post()).status).toBe(503);
    expect(requests).toHaveLength(0);
  });

  it("supports x-api-key and Cookie Header prefixes without forwarding client credentials", async () => {
    const { mf, requests } = await setup(undefined, { DOUBAO_COOKIE: `Cookie: ${cookie}` });
    const response = await mf.dispatchFetch("https://worker.test/v1/chat/completions", {
      method: "POST", headers: { "x-api-key": key, "x-doubao-target-lang": "ja" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    expect(requests[0]!.headers.get("cookie")).toBe(cookie);
    expect(requests[0]!.headers.get("authorization")).toBeNull();
    expect(requests[0]!.body).toMatchObject({ target_lang: "ja", translate_service: "1" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("strips the template prefix and preserves CRLF, blank lines, spaces and %% separators", async () => {
    const { post, requests } = await setup();
    const response = await post({ messages: [{ role: "user", content: "Translate to Traditional Chinese:\n\nhello\r\n\r\n  %% \r\n\r\nworld\n" }] });
    expect(response.status).toBe(200);
    expect(requests[0]!.body.raw_text).toEqual(["hello", "world"]);
    expect(requests[0]!.body.target_lang).toBe("zh-Hant");
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "译:hello\r\n\r\n  %% \r\n\r\n译:world\n" } }] });
  });

  it("uses system language instructions while treating source text as literal text", async () => {
    const { post, requests } = await setup();
    expect((await post({ messages: [
      { role: "system", content: "Translate to Japanese." },
      { role: "user", content: "We traveled to German cities." },
    ] })).status).toBe(200);
    expect(requests[0]!.body.target_lang).toBe("ja");
    expect(requests[0]!.body.raw_text).toEqual(["We traveled to German cities."]);
  });

  it("gives explicit target_lang precedence over prompt instructions", async () => {
    const { post, requests } = await setup();
    expect((await post({ target_lang: "zh-TW", messages: [{ role: "user", content: "Translate to Klingon:\nhello" }] })).status).toBe(200);
    expect(requests[0]!.body.target_lang).toBe("zh-Hant");
  });

  it("restores ordered translations over sequential 50-line batches", async () => {
    const { post, requests } = await setup();
    const lines = Array.from({ length: 51 }, (_, index) => `line${index}`);
    const response = await post({ messages: [{ role: "user", content: lines.join("\n") }] });
    expect(response.status).toBe(200);
    expect(requests.map(request => request.body.raw_text.length)).toEqual([50, 1]);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: lines.map(line => `译:${line}`).join("\n") } }] });
  });

  it("splits batches at the upstream character limit", async () => {
    const { post, requests } = await setup();
    expect((await post({ messages: [{ role: "user", content: "a".repeat(6000) + "\n" + "b".repeat(6000) }] })).status).toBe(200);
    expect(requests.map(request => request.body.raw_text.length)).toEqual([1, 1]);
  });

  it("is compatible with OpenAI SDK non-streaming Chat Completions", async () => {
    const { mf } = await setup();
    const openai = new OpenAI({ apiKey: key, baseURL: `${(await mf.ready).href}v1`, maxRetries: 0 });
    const result = await openai.chat.completions.create({ model: "doubao-ai", messages: [{ role: "user", content: "hello" }] });
    expect(result.choices[0]?.message.content).toBe("译:hello");
  });

  it.each([
    { stream: true }, { tools: [] }, { model: "other" }, { messages: [] },
    { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
    { messages: [{ role: "user", content: "<p>hello</p>" }] },
    { messages: [{ role: "user", content: "%%\n%%" }] },
    { target_lang: "unsupported" },
    { messages: [{ role: "user", content: "a".repeat(10001) }] },
    { messages: [{ role: "user", content: Array(201).fill("x").join("\n") }] },
  ])("rejects unsupported requests before calling upstream: %j", async body => {
    const { post, requests } = await setup();
    expect((await post(body)).status).toBeGreaterThanOrEqual(400);
    expect(requests).toHaveLength(0);
  });

  it.each(["{bad", "null", "[]", JSON.stringify({ padding: "中".repeat(23000) })])("bounds and validates raw request bodies", async body => {
    const { mf, requests } = await setup();
    const response = await mf.dispatchFetch("https://worker.test/v1/chat/completions", {
      method: "POST", headers: { "x-api-key": key }, body,
    });
    expect(response.status).toBe(body.startsWith('{"padding"') ? 413 : 400);
    expect(requests).toHaveLength(0);
  });

  it.each([401, 403, 429, 302])("reports HTTP %s without inferring confirmed account expiry", async status => {
    const { post } = await setup(() => new MFResponse("secret upstream body", { status, headers: { location: "https://unexpected.test" } }));
    const response = await post();
    expect(response.status).toBe(status === 429 ? 429 : 502);
    expect(await response.json()).toMatchObject({ error: { code: status === 429 ? "upstream_rate_limit" : "upstream_http_error" } });
  });

  it("recognizes confirmed expiry in JSON even without a content-type", async () => {
    const { post } = await setup(() => new MFResponse('{"code":710012001,"msg":"secret"}'));
    expect(await (await post()).json()).toMatchObject({ error: { code: "upstream_auth_error" } });
  });

  it.each([
    sse([], true),
    sse([{ index: 0, res: "hello" }], false),
    sse([{ index: 1, res: "bad index" }]),
    sse([{ index: 0, res: "" }]),
    new MFResponse('event: err\ndata: {"code":0}\n\n'),
    new MFResponse('event: json\ndata: not-json\n\n'),
    sse([{ index: 0, res: "x".repeat(256 * 1024 + 1) }]),
    new MFResponse("x".repeat(512 * 1024 + 1)),
  ])("never exposes partial, malformed or oversized translations", async fixture => {
    const { post } = await setup(() => fixture.clone());
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toHaveProperty("error");
  });

  it.each(["\n", "\r\n", "\r"])("parses multiline SSE and split UTF-8 bytes with newline %j", async newline => {
    const text = [
      ": heartbeat", "event: json", 'data: {"code":0,"data":',
      'data: {"items":[{"index":0,"res":"中文"}]}}', "", "event: done", "data: {}", "", "",
    ].join(newline);
    const { post } = await setup(() => new MFResponse(new ReadableStream({
      start(controller) {
        for (const byte of new TextEncoder().encode(text)) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    })));
    expect(await (await post()).json()).toMatchObject({ choices: [{ message: { content: "中文" } }] });
  });

  it("maps abort and network exceptions to sanitized upstream errors", async () => {
    const request = () => new Request("https://worker.test/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private network details")));
    expect(await (await worker.fetch(request(), { API_KEY: key, DOUBAO_COOKIE: cookie })).json())
      .toMatchObject({ error: { code: "upstream_network_error" } });
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const timedOut = await worker.fetch(request(), { API_KEY: key, DOUBAO_COOKIE: cookie });
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({ error: { code: "upstream_timeout" } });
  });
});
