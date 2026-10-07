/* Self-contained Lite Worker: no runtime imports, frameworks, SDKs or Node APIs. */
type Env = { API_KEY?: string; DOUBAO_COOKIE?: string; DOUBAO_DEFAULT_TARGET_LANG?: string };
type Segment = { text: string; separator: string };
type Body = Record<string, unknown>;
type Message = { role?: string; content?: unknown };
const encoder = new TextEncoder();
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key, x-doubao-target-lang",
};

function fail(message: string, code: string, status = 400): never { throw [message, code, status]; }
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function object(value: unknown): value is Body {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parseJSON(text: string, upstream = false): Body {
  let value: unknown;
  try { value = JSON.parse(text); } catch { /* Report a sanitized error below. */ }
  if (!object(value)) fail("Invalid JSON object.", upstream ? "upstream_stream_error" : "invalid_request", upstream ? 502 : 400);
  return value;
}
async function readText(input: Request | Response, limit: number, upstream = false) {
  const reader = input.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limit) fail("Body is too large.", upstream ? "upstream_stream_error" : "request_too_large", upstream ? 502 : 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const names: Record<string, string> = {
  "traditional chinese": "zh-Hant", "simplified chinese": "zh", chinese: "zh",
  "繁体中文": "zh-Hant", "繁體中文": "zh-Hant", "简体中文": "zh", "中文": "zh",
  english: "en", "英文": "en", "英语": "en", japanese: "ja", "日文": "ja", "日语": "ja",
  korean: "ko", "韩文": "ko", "韩语": "ko", french: "fr", german: "de", spanish: "es",
  portuguese: "pt", russian: "ru", arabic: "ar", italian: "it", indonesian: "id",
  malay: "ms", thai: "th", vietnamese: "vi", filipino: "fil", tagalog: "fil", uzbek: "uz",
  "zh-cn": "zh", "zh-hans": "zh", "zh-tw": "zh-Hant", "zh-hk": "zh-Hant",
};
function language(value: unknown): string {
  if (typeof value !== "string") fail("Target language must be a string.", "unsupported_target_language");
  const key = value.trim().toLowerCase();
  const result = names[key] ?? key;
  const codes = ["zh", "zh-Hant", "en", "ja", "ko", "fr", "de", "es", "es-ES", "pt", "ru", "ar", "it", "id", "ms", "th", "vi", "fil", "uz"];
  const match = codes.find(code => code.toLowerCase() === result.toLowerCase());
  if (!match) fail("Unsupported target language. Use target_lang with a language code.", "unsupported_target_language");
  return match;
}
function input(body: Body, request: Request, env: Env) {
  if (!Array.isArray(body.messages) || !body.messages.every(object))
    fail("A messages array is required.", "invalid_request");
  const messages = body.messages as Message[];
  const user = messages.findLast(message => message.role === "user");
  if (typeof user?.content !== "string") fail("A plain-text user message is required.", "unsupported_input");
  const prefix = user.content.match(/^(?:please\s+)?translate[^\n:：]{1,160}[:：][ \t]*(?:\r\n|\r|\n)*/i) ??
    user.content.match(/^(?:请)?翻译(?:成|为)[^\n:：]{1,80}[:：][ \t]*(?:\r\n|\r|\n)*/);
  const contexts = messages.filter(message => message.role === "system" || message.role === "developer")
    .map(message => typeof message.content === "string" ? message.content : "").concat(prefix?.[0] ?? "");
  const directive = /(?:\btranslate\b[^\n:：]{0,160}?\b(?:to|into)\s+|翻译(?:成|为)|(?:target|output)\s+language\s*[:：]\s*)([^\n:：.!]+)(?=[:：.!]|$)/i;
  const explicit = body.target_lang ?? request.headers.get("x-doubao-target-lang");
  const targets = explicit === null ? contexts.map(context => context.match(directive)?.[1])
    .filter(value => value !== undefined).map(language) : [];
  if (new Set(targets).size > 1) fail("Conflicting target languages.", "invalid_request");
  const target = explicit !== null ? language(explicit) : targets[0] ?? language(env.DOUBAO_DEFAULT_TARGET_LANG ?? "zh");
  const text = prefix ? user.content.slice(prefix[0].length) : user.content;
  if (!text.trim()) fail("Translation input is empty.", "empty_translation_input");
  if (text.length > 20_000) fail("Text exceeds 20,000 characters.", "request_too_large", 413);
  if (/^\s*<(?:yaml|text)\b/i.test(text) || /<\/?(?:html|a|p|div|span|code|pre|h[1-6]|strong|em|br|ul|li|table)\b/i.test(text))
    fail("Use a plain-text template; HTML and YAML wrappers are unsupported.", "unsupported_input");
  const parts = text.split(/((?:\r\n|\r|\n)+)/), segments: Segment[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? "", separator = parts[i + 1] ?? "";
    if (!line.trim() || /^[ \t]*%%[ \t]*$/.test(line)) segments.push({ text: "", separator: line + separator });
    else {
      if (line.length > 10_000) fail("One line exceeds 10,000 characters.", "request_too_large", 413);
      segments.push({ text: line, separator });
    }
  }
  const texts = segments.filter(segment => segment.text).map(segment => segment.text);
  if (!texts.length) fail("Translation input is empty.", "empty_translation_input");
  const batches: string[][] = [];
  let batch: string[] = [], chars = 0;
  for (const line of texts) {
    if (batch.length === 50 || chars + line.length > 10_000) { batches.push(batch); batch = []; chars = 0; }
    batch.push(line); chars += line.length;
  }
  batches.push(batch);
  if (batches.length > 4) fail("Text exceeds four batches (50 lines / 10,000 characters each).", "request_too_large", 413);
  return { target, segments, batches };
}

function checkCode(value: Body) {
  if (value.code === undefined || value.code === 0) return;
  if (value.code === 710012001) fail("Doubao login has expired.", "upstream_auth_error", 502);
  fail("Doubao translation failed.", "upstream_stream_error", 502);
}
async function upstream(texts: string[], target: string, cookie: string, signal: AbortSignal) {
  try {
    const response = await fetch("https://www.doubao.com/samantha/plugin/stream_article_translate", {
      method: "POST", redirect: "manual", signal,
      headers: { "content-type": "application/json", accept: "*/*", cookie },
      body: JSON.stringify({ raw_text: texts, target_lang: target, translate_service: "1", scene: 2, frontend_source: 1 }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) fail("Doubao rate limit reached.", "upstream_rate_limit", 429);
      fail("Doubao access refused or request failed.", "upstream_http_error", 502);
    }
    // Bounded buffering handles arbitrary network chunks without a parser dependency.
    const text = (await readText(response, 512 * 1024, true)).replace(/\r\n|\r/g, "\n").trimStart();
    if (text.startsWith("{")) { checkCode(parseJSON(text, true)); fail("Upstream returned no translations.", "upstream_incomplete_result", 502); }
    const result = new Map<number, string>();
    let done = false;
    for (const frame of text.split("\n\n")) {
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!["json", "message", "err", "done"].includes(event)) continue;
      if (event === "done") { if (data.length) checkCode(parseJSON(data.join("\n"), true)); done = true; continue; }
      if (!data.length) continue;
      const value = parseJSON(data.join("\n"), true); checkCode(value);
      if (event === "err") fail("Upstream stream reported an error.", "upstream_stream_error", 502);
      const items = object(value.data) && Array.isArray(value.data.items) ? value.data.items : [];
      for (const item of items) {
        if (!object(item) || typeof item.index !== "number" || !Number.isInteger(item.index) ||
            item.index < 0 || item.index >= texts.length || typeof item.res !== "string" || !item.res.trim())
          fail("Invalid upstream translation item.", "upstream_stream_error", 502);
        if (!result.has(item.index)) result.set(item.index, item.res);
      }
    }
    if (!done || result.size !== texts.length) fail("Upstream translation is incomplete.", "upstream_incomplete_result", 502);
    return texts.map((_, index) => result.get(index)!);
  } catch (caught) {
    if (Array.isArray(caught)) throw caught;
    if (signal.aborted) fail("Doubao request timed out.", "upstream_timeout", 504);
    fail("Doubao connection failed.", "upstream_network_error", 502);
  }
}

async function handle(request: Request, env: Env, id: string) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health")
    return json({ status: "ok", runtime: "cloudflare-workers-lite" });
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (url.pathname !== "/v1/chat/completions") fail("Route not found.", "not_found", 404);
  if (request.method !== "POST") fail("POST is required.", "method_not_allowed", 405);
  const cookie = env.DOUBAO_COOKIE?.replace(/^Cookie:\s*/i, "").trim();
  if (!env.API_KEY || env.API_KEY.length < 16 || /\s/.test(env.API_KEY) || !cookie ||
      /[\r\n]/.test(cookie) || !["sessionid", "sid_tt", "uid_tt"].every(name => new RegExp(`(?:^|;\\s*)${name}=[^;\\s]+`).test(cookie)))
    fail("Worker secrets are missing or invalid.", "configuration_error", 503);
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.headers.get("x-api-key");
  if (supplied !== env.API_KEY) fail("Invalid or missing API Key.", "unauthorized", 401);
  const body = parseJSON(await readText(request, 64 * 1024));
  if (body.stream !== undefined && body.stream !== false) fail("Disable stream in Lite mode.", "unsupported_feature");
  if (["tools", "functions", "reasoning"].some(field => body[field] !== undefined))
    fail("Only plain-text translation is supported.", "unsupported_feature");
  if (body.model !== undefined && body.model !== "doubao-ai") fail("Only doubao-ai is supported.", "model_not_found", 404);
  const { target, segments, batches } = input(body, request, env);
  const translated: string[] = [], totalSignal = AbortSignal.timeout(90_000);
  let bytes = 0;
  for (const batch of batches) {
    const output = await upstream(batch, target, cookie, AbortSignal.any([totalSignal, request.signal, AbortSignal.timeout(45_000)]));
    for (const text of output) {
      bytes += encoder.encode(text).byteLength;
      if (bytes > 256 * 1024) fail("Translation output is too large.", "upstream_stream_error", 502);
      translated.push(text);
    }
  }
  let index = 0;
  const text = segments.map(segment => (segment.text ? translated[index++] : "") + segment.separator).join("");
  return json({
    id: `chatcmpl_${id.replaceAll("-", "")}`, object: "chat.completion",
    created: Math.floor(Date.now() / 1000), model: "doubao-ai",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const id = crypto.randomUUID();
  let response: Response;
  try { response = await handle(request, env, id); }
  catch (caught) {
    const [message, code, status] = Array.isArray(caught) ? caught : ["Lite Worker failed.", "internal_error", 500];
    response = json({ error: {
      type: status === 401 ? "authentication_error" : status < 500 ? "invalid_request_error" : "api_error",
      message, code, param: null,
    } }, status);
  }
  response.headers.set("x-request-id", id);
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  return response;
} };
