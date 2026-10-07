import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { DoubaoClient } from "../../src/doubao/client.js";
import { Translator } from "../../src/core/translator.js";
import { startMock, type Scenario } from "../fixtures/mock-doubao.js";
import { loadCookie } from "../../src/auth/cookie-store.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });
async function setup(scenario: Scenario = "ok", overrides: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), "doubao-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const cookieFile = join(dir, "cookie.txt");
  await writeFile(cookieFile, "sessionid=secret; sid_tt=secret; uid_tt=secret;\n");
  const mock = await startMock(scenario); cleanup.push(mock.close);
  const config = loadConfig({ API_KEY: "client-secret", DOUBAO_COOKIE_FILE: cookieFile, ...overrides });
  const warnings: string[] = [];
  const client = new DoubaoClient(config, mock.fetcher, code => warnings.push(code));
  return { dir, cookieFile, mock, client, config, warnings, translator: new Translator(config, client) };
}
const req = { texts: ["hello", "world"], targetLang: "zh", engine: "1", scene: 2 } as const;
const request = () => ({ ...req, texts: [...req.texts] });

describe("real HTTP upstream adapter", () => {
  it.each(["ok", "out-of-order", "duplicate-index", "no-done", "chunk-one-byte", "no-content-type-sse", "unknown-event", "no-content-type-byte-sse"] as Scenario[])("handles %s", async scenario => {
    const { client, mock, warnings } = await setup(scenario);
    expect((await client.translate(request(), new AbortController().signal)).texts).toEqual(["译:hello", "译:world"]);
    expect(mock.requests[0]?.body).toEqual({ raw_text: ["hello", "world"], target_lang: "zh", translate_service: "1", scene: 2, frontend_source: 1 });
    expect(mock.requests[0]?.authorization).toBeUndefined();
    if (scenario === "no-done") expect(warnings).toContain("missing_done_event");
    if (scenario === "duplicate-index") expect(warnings).toContain("duplicate_item_index");
  });
  it.each([
    ["partial-items", "upstream_incomplete_result"], ["invalid-index", "upstream_incomplete_result"],
    ["invalid-result", "upstream_incomplete_result"], ["done-only", "upstream_incomplete_result"],
    ["empty-result", "upstream_incomplete_result"],
    ["empty", "upstream_incomplete_result"], ["err-event", "upstream_stream_error"],
    ["err-event-after-items", "upstream_stream_error"], ["json-login-error", "upstream_auth_error"],
    ["no-content-type-json", "upstream_auth_error"], ["json-scene-error", "upstream_bad_request"],
    ["no-content-type-byte-json", "upstream_auth_error"],
    ["json-plugin-error", "upstream_bad_request"], ["http-500", "upstream_http_error"],
  ] as Array<[Scenario, string]>)("fails explicitly for %s", async (scenario, code) => {
    const { client } = await setup(scenario);
    await expect(client.translate(request(), new AbortController().signal)).rejects.toMatchObject({ code });
  });
  it("times out, forbids redirects and cancels upstream", async () => {
    const { client, mock } = await setup("slow-response", { DOUBAO_REQUEST_TIMEOUT_MS: "10" });
    await expect(client.translate(request(), new AbortController().signal)).rejects.toMatchObject({ code: "upstream_timeout" });
    mock.state.scenario = "slow-body";
    await expect(client.translate(request(), new AbortController().signal)).rejects.toMatchObject({ code: "upstream_timeout" });
    mock.state.scenario = "redirect";
    await expect(client.translate(request(), new AbortController().signal)).rejects.toMatchObject({ code: "upstream_network_error" });
    expect(mock.requests.some(x => x.path === "/unexpected")).toBe(false);
  });
  it("hot reads cookies and probes expiry and missing files", async () => {
    const { client, cookieFile, mock } = await setup();
    expect((await client.authStatus(new AbortController().signal)).authenticated).toBe(true);
    await writeFile(cookieFile, "sessionid=new; sid_tt=new; uid_tt=new");
    await client.translate(request(), new AbortController().signal);
    expect(mock.requests.at(-1)?.cookie).toContain("sessionid=new");
    mock.state.authCode = 710012001;
    expect((await client.authStatus(new AbortController().signal)).reason).toBe("cookie_expired");
    await rm(cookieFile);
    expect((await client.authStatus(new AbortController().signal)).reason).toBe("cookie_missing");
  });
  it("rejects unsafe and incomplete cookies", async () => {
    const { cookieFile, client } = await setup();
    await writeFile(cookieFile, "sessionid=x\nsid_tt=y; uid_tt=z");
    await expect(loadCookie(cookieFile)).rejects.toMatchObject({ code: "cookie_invalid" });
    await writeFile(cookieFile, "sessionid=x");
    expect((await client.authStatus(new AbortController().signal)).required_login_cookies_present).toBe(false);
  });
  it("retries only retryable failures and restores formatting", async () => {
    const { translator, mock } = await setup("json-login-error");
    const canonical = { protocol: "openai-chat", model: "doubao-ai", rawText: "hello\n\nworld\n", targetLang: "zh", scene: 2, stream: false, requestId: "test" } as const;
    await expect(translator.translate(canonical, new AbortController().signal)).rejects.toMatchObject({ code: "upstream_auth_error" });
    expect(mock.requests).toHaveLength(1);
    mock.state.scenario = "ok";
    expect((await translator.translate(canonical, new AbortController().signal)).text).toBe("译:hello\n\n译:world\n");
  });
  it("retries unknown business failures with bounded attempts", async () => {
    const { translator, mock } = await setup("json-unknown-error", { DOUBAO_MAX_RETRIES: "1" });
    await expect(translator.translate({
      protocol: "openai-chat", model: "doubao-ai", rawText: "hello", targetLang: "zh", scene: 2, stream: false, requestId: "test",
    }, new AbortController().signal)).rejects.toMatchObject({ upstreamCode: 999 });
    expect(mock.requests).toHaveLength(2);
  });
  it("splits 51 paragraphs into ordered batches without losing separators", async () => {
    const { translator, mock } = await setup();
    const text = Array.from({ length: 51 }, (_, i) => `item${i}`).join("\r\n\r\n");
    const result = await translator.translate({
      protocol: "openai-chat", model: "doubao-ai", rawText: text, targetLang: "zh", scene: 2, stream: false, requestId: "test",
    }, new AbortController().signal);
    expect(mock.requests.map(x => x.body.raw_text.length)).toEqual([50, 1]);
    expect(result.text).toBe(Array.from({ length: 51 }, (_, i) => `译:item${i}`).join("\r\n\r\n"));
  });
  it("releases the slot before backoff and cancels pending retries", async () => {
    const { translator, mock } = await setup("json-unknown-error", {
      DOUBAO_MAX_CONCURRENCY: "1", DOUBAO_QUEUE_MAX: "0",
    });
    const canonical = {
      protocol: "openai-chat", model: "doubao-ai", rawText: "hello", targetLang: "zh", scene: 2, stream: false, requestId: "test",
    } as const;
    const controller = new AbortController();
    const pending = translator.translate(canonical, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    for (let i = 0; i < 100 && !mock.requests.length; i++) await delay(5);
    await delay(20);
    mock.state.scenario = "ok";
    expect((await translator.translate(canonical, new AbortController().signal)).text).toBe("译:hello");
    controller.abort(); await rejected;
    await delay(400);
    expect(mock.requests).toHaveLength(2);
  });
});
