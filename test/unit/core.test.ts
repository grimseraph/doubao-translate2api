import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { normalizeLanguage, languages } from "../../src/doubao/languages.js";
import { determineLanguage, extractSource } from "../../src/core/prompt-parser.js";
import { buildBatches, segmentText } from "../../src/core/segmenter.js";
import { SSEParser } from "../../src/doubao/sse-parser.js";
import { Semaphore } from "../../src/core/concurrency.js";
import { buildRequestBody } from "../../src/doubao/client.js";
import { MODEL_ENGINE_MAP } from "../../src/core/models.js";

describe("configuration and request contract", () => {
  it("defaults to generated auth and validates numeric configuration without exposing secrets", () => {
    expect(loadConfig({}).keys).toEqual([]);
    expect(loadConfig({}).ALLOW_NO_AUTH).toBe(false);
    expect(loadConfig({}).DOUBAO_DEFAULT_TARGET_LANG).toBe("zh");
    expect(loadConfig({ DOUBAO_DEFAULT_TARGET_LANG: "zh-TW" }).DOUBAO_DEFAULT_TARGET_LANG).toBe("zh-Hant");
    expect(() => loadConfig({ DOUBAO_DEFAULT_TARGET_LANG: "Klingon" })).toThrow("DOUBAO_DEFAULT_TARGET_LANG");
    expect(() => loadConfig({ API_KEYS: "" })).toThrow("API_KEYS");
    expect(loadConfig({ ALLOW_NO_AUTH: "true" }).PORT).toBe(8000);
    expect(loadConfig({ API_KEY: "one", API_KEYS: "two,three" }).keys).toEqual(["two", "three"]);
    for (const env of [{ PORT: "65536" }, { DOUBAO_DEFAULT_SCENE: "7" }, { DOUBAO_MAX_CONCURRENCY: "0" }])
      expect(() => loadConfig({ API_KEY: "test", ...env })).toThrow();
  });
  it("maps all three engines with correct field types", () => {
    for (const [model, engine] of Object.entries(MODEL_ENGINE_MAP)) {
      const body = buildRequestBody({ texts: ["hello"], targetLang: "zh", engine, scene: 2 });
      expect(body).toEqual({ raw_text: ["hello"], target_lang: "zh", translate_service: engine, scene: 2, frontend_source: 1 });
      expect(typeof body.scene).toBe("number");
      expect(typeof body.translate_service).toBe("string");
      expect(model).toBeTruthy();
    }
  });
});

describe("language and prompt parsing", () => {
  it.each([["zh-CN", "zh"], ["zh-Hans", "zh"], ["zh-TW", "zh-Hant"], ["zh-Hant", "zh-Hant"],
    ["pt-BR", "pt"], ["es-MX", "es"], ["es-ES", "es-ES"], ["tl", "fil"]])("%s -> %s", (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });
  it("accepts all canonical languages and rejects unsupported ones", () => {
    expect(languages).toHaveLength(19);
    languages.forEach(lang => expect(normalizeLanguage(lang)).toBe(lang));
    expect(() => normalizeLanguage("xx")).toThrow();
  });
  it.each([
    ["Translate to Chinese", "zh"], ["Translate into Simplified Chinese", "zh"],
    ["Translate the following text into Japanese", "ja"], ["Please translate it to English", "en"],
    ["Target language: Korean", "ko"], ["Output language: French", "fr"],
    ["翻译成中文", "zh"], ["翻译为简体中文", "zh"], ["把以下内容翻译成日语", "ja"],
    ["目标语言：英文", "en"], ["请译为繁体中文", "zh-Hant"],
  ])("recognizes %s", (instruction, lang) => {
    expect(determineLanguage(undefined, undefined, [instruction], "hello")).toBe(lang);
  });
  it("enforces precedence, conflicts and absence", () => {
    expect(determineLanguage("ja", "ko", ["Translate to English"], "")).toBe("ja");
    expect(determineLanguage(undefined, "ko", ["Translate to English"], "")).toBe("ko");
    expect(() => determineLanguage("xx", "en", [], "")).toThrow();
    expect(() => determineLanguage(undefined, undefined, ["Translate to English", "Translate to Japanese"], "")).toThrow("Conflicting");
    expect(() => determineLanguage(undefined, undefined, [], "A story mentioning Chinese")).toThrow();
  });
  it("extracts only high confidence prefixes and retains source formatting", () => {
    const user = "Translate the following text into Chinese:\n\nHello world";
    expect(determineLanguage(undefined, undefined, [], user)).toBe("zh");
    expect(extractSource(user)).toBe("Hello world");
    expect(extractSource("Translate into Chinese:\n\n  indented\n")).toBe("  indented\n");
    expect(extractSource("把下面内容翻译成英文：\n今天天气很好。")).toBe("今天天气很好。");
    expect(determineLanguage(undefined, undefined, [], "Target language: Korean\nText:\nHello")).toBe("ko");
    expect(extractSource("Target language: Korean\nText:\nHello")).toBe("Hello");
    expect(extractSource("他告诉我翻译成英文：这是一段叙述。")).toBe("他告诉我翻译成英文：这是一段叙述。");
    expect(extractSource("原文：\n hello\n")).toBe(" hello\n");
    expect(extractSource("  Hello\n\nworld  ")).toBe("  Hello\n\nworld  ");
  });
  it("uses a configured fallback after all explicit language sources", () => {
    expect(determineLanguage(undefined, undefined, [], "Say OK", "zh")).toBe("zh");
    expect(determineLanguage(undefined, undefined, [], "A story mentioning Chinese", "ja")).toBe("ja");
    expect(determineLanguage("fr", "ko", ["Translate to English"], "Translate into Japanese:\nhello", "zh")).toBe("fr");
    expect(determineLanguage(undefined, "ko", ["Translate to English"], "hello", "zh")).toBe("ko");
    expect(determineLanguage(undefined, undefined, ["Translate to English"], "hello", "zh")).toBe("en");
    expect(determineLanguage(undefined, undefined, [], "翻译成日语：hello", "zh")).toBe("ja");
  });
  it("does not hide unsupported or conflicting language instructions behind the fallback", () => {
    expect(() => determineLanguage("xx", undefined, [], "hello", "zh")).toThrow();
    expect(() => determineLanguage(undefined, "xx", [], "hello", "zh")).toThrow();
    expect(() => determineLanguage(undefined, undefined, ["Translate to English", "Translate to Japanese"], "hello", "zh")).toThrow("Conflicting");
    expect(() => determineLanguage(undefined, undefined, ["Translate into Klingon"], "hello", "zh")).toThrow();
    expect(() => determineLanguage(undefined, undefined, [], "Translate into Klingon:\nhello", "zh")).toThrow();
  });
});

describe("segmentation and batching", () => {
  it.each([50, 51])("batches %s items", count => {
    expect(buildBatches(Array(count).fill("x"))).toHaveLength(count === 50 ? 1 : 2);
  });
  it("enforces 10000 chars, ignores empty items and preserves indexes", () => {
    expect(buildBatches(["a".repeat(5000), "b".repeat(5000)])).toHaveLength(1);
    expect(buildBatches(["a".repeat(5000), "b".repeat(5001)])).toHaveLength(2);
    expect(buildBatches(["", "a", "", "b"])[0]?.indexes).toEqual([1, 3]);
    expect(buildBatches([])).toEqual([]);
    expect(() => segmentText("  \n")).toThrow();
  });
  it("round trips paragraphs, Unicode and long sentences", () => {
    for (const text of ["\n\nhello\r\n\r\n world\rend\n", "hello\n  \nworld", "😀".repeat(12000), "A sentence. ".repeat(2000)]) {
      const segments = segmentText(text);
      expect(segments.map(x => x.text + x.separator).join("")).toBe(text);
      segments.forEach(x => {
        expect(x.text.length).toBeLessThanOrEqual(9000);
        expect(/[\uD800-\uDBFF]$/.test(x.text)).toBe(false);
        expect(/^[\uDC00-\uDFFF]/.test(x.text)).toBe(false);
      });
      const batches = buildBatches(segments.map(x => x.text));
      expect(batches.flatMap(x => x.indexes)).toEqual(segments.flatMap((x, i) => x.text ? [i] : []));
    }
  });
});

describe("incremental SSE", () => {
  it.each(["\n", "\r\n", "\r"])("handles every byte split with %j", newline => {
    const events: any[] = [];
    const parser = new SSEParser(x => events.push(x));
    const stream = [": heartbeat", "event: json", 'data: {"text":', 'data: "中文"}', "", "event: done", "data: {}", ""].join(newline);
    for (const byte of Buffer.from(stream)) parser.push(Uint8Array.of(byte));
    parser.finish();
    expect(events).toEqual([{ event: "json", data: '{"text":\n"中文"}' }, { event: "done", data: "{}" }]);
  });
  it("flushes a final unterminated line and default event", () => {
    const events: any[] = [];
    const parser = new SSEParser(x => events.push(x));
    parser.push(Buffer.from("data: hello")); parser.finish();
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });
});

describe("global semaphore", () => {
  it("bounds queue and removes cancelled waiters", async () => {
    const semaphore = new Semaphore(1, 1, 1000);
    const signal = new AbortController();
    const release = await semaphore.acquire(signal.signal);
    const queuedSignal = new AbortController();
    const queued = semaphore.acquire(queuedSignal.signal);
    const assertion = expect(queued).rejects.toThrow();
    await expect(semaphore.acquire(signal.signal)).rejects.toMatchObject({ code: "queue_full" });
    queuedSignal.abort(); await assertion;
    release(); release();
    const nextRelease = await semaphore.acquire(signal.signal);
    nextRelease();
  });
  it("expires waiting callers and transfers slots once", async () => {
    const semaphore = new Semaphore(1, 2, 10);
    const signal = new AbortController().signal;
    const release = await semaphore.acquire(signal);
    await expect(semaphore.acquire(signal)).rejects.toMatchObject({ code: "queue_timeout" });
    const queued = semaphore.acquire(signal);
    release();
    const nextRelease = await queued;
    nextRelease();
  });
});
