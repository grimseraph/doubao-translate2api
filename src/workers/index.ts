import { parseCookie } from "../auth/cookie.js";
import { concatBytes } from "../core/bytes.js";
import { asServiceError, ServiceError } from "../core/errors.js";
import { models } from "../core/models.js";
import { buildBatches, segmentText } from "../core/segmenter.js";
import { Translator } from "../core/translator.js";
import type { Protocol } from "../core/translation-request.js";
import { DoubaoTransport } from "../doubao/transport.js";
import { adaptRequest } from "../protocols/adapter.js";
import { formatJSON, formatSSE } from "../protocols/format.js";
import { listModels } from "../protocols/model-list.js";
import { workerConfig, type WorkerConfig, type WorkerEnv } from "./config.js";

const BODY_LIMIT = 64 * 1024;
const TEXT_LIMIT = 20000;
const BATCH_LIMIT = 4;
const translators = new WeakMap<WorkerEnv, Translator>();
const routes = new Map<string, Protocol>([
  ["/v1/chat/completions", "openai-chat"],
  ["/v1/responses", "openai-responses"],
  ["/v1/messages", "anthropic"],
]);
const allowedHeaders = ["content-type", "authorization", "x-api-key", "anthropic-version", "x-doubao-target-lang"];

async function authenticate(request: Request, key: string) {
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? request.headers.get("x-api-key");
  if (!supplied || supplied.length > 256)
    throw new ServiceError("unauthorized", 401, "Invalid or missing API Key.");
  const encoder = new TextEncoder();
  const hashes = await Promise.all([key, supplied].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const expected = new Uint8Array(hashes[0]!);
  const actual = new Uint8Array(hashes[1]!);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected[i]! ^ actual[i]!;
  if (mismatch) throw new ServiceError("unauthorized", 401, "Invalid or missing API Key.");
}

async function readJSON(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new ServiceError("invalid_request", 415, "Content-Type must be application/json.");
  const size = request.headers.get("content-length");
  if (size && Number(size) > BODY_LIMIT) throw new ServiceError("request_too_large", 413, "Request body exceeds 64 KiB.");
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError("invalid_request", 400, "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > BODY_LIMIT) throw new ServiceError("request_too_large", 413, "Request body exceeds 64 KiB.");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(concatBytes(chunks))); }
  catch { throw new ServiceError("invalid_request", 400, "Invalid JSON request body."); }
}

function translator(env: WorkerEnv, config: WorkerConfig) {
  let instance = translators.get(env);
  if (!instance) {
    const client = new DoubaoTransport(config, fetch, (code, fields) => console.warn({ code, ...fields }));
    instance = new Translator(config, client);
    translators.set(env, instance);
  }
  return instance;
}

function cors(request: Request, config: WorkerConfig): Headers {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("origin");
  if (config.origins.includes("*")) headers.set("Access-Control-Allow-Origin", "*");
  else if (origin && config.origins.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
  if (origin && !headers.has("Access-Control-Allow-Origin"))
    throw new ServiceError("origin_forbidden", 403, "Request origin is not allowed.");
  headers.set("Access-Control-Expose-Headers", "X-Request-Id");
  return headers;
}

async function handle(request: Request, env: WorkerEnv, id: string, headers: Headers): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && ["/", "/health"].includes(url.pathname))
    return Response.json({ status: "ok", ...(url.pathname === "/" ? {
      name: "doubao-translate2api", runtime: "cloudflare-workers", release: "experimental",
    } : {}) });
  const config = workerConfig(env);
  cors(request, config).forEach((value, key) => headers.set(key, value));
  const protocol = routes.get(url.pathname);
  const modelDetail = /^\/v1\/models\/([^/]+)$/.exec(url.pathname);
  const method = protocol ? "POST" :
    ["/v1/models", "/auth/status"].includes(url.pathname) || modelDetail ? "GET" : undefined;
  if (!method) throw new ServiceError("not_found", 404, "Route not found.");
  if (request.method === "OPTIONS") {
    if (request.headers.get("access-control-request-method") !== method)
      throw new ServiceError("method_not_allowed", 405, "Requested method is not supported.");
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some(header => !allowedHeaders.includes(header)))
      throw new ServiceError("invalid_request", 400, "Requested header is not supported.");
    headers.set("Access-Control-Allow-Methods", method);
    headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
    headers.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204 });
  }
  await authenticate(request, config.API_KEY);
  if (request.method !== method) {
    headers.set("Allow", `${method}, OPTIONS`);
    throw new ServiceError("method_not_allowed", 405, "Method not supported.");
  }
  if (url.pathname === "/v1/models") return Response.json(listModels(Object.fromEntries(url.searchParams)));
  if (modelDetail) {
    const model = models.find(value => value.id === modelDetail[1]);
    if (!model) throw new ServiceError("model_not_found", 404, "Model not found.", false, "model");
    return Response.json(model);
  }
  const instance = translator(env, config);
  const provider = async () => parseCookie(env.DOUBAO_COOKIE!);
  if (url.pathname === "/auth/status") return Response.json(await instance.authStatus(request.signal, provider));
  const adapted = adaptRequest(protocol!, await readJSON(request),
    request.headers.get("x-doubao-target-lang") ?? undefined, config.DOUBAO_DEFAULT_SCENE, id,
    config.DOUBAO_DEFAULT_TARGET_LANG);
  if (config.TRANSLATION_PROFILE === "immersive-translate") adapted.canonical.sourceFormat = "immersive-translate";
  if (adapted.canonical.rawText.length > TEXT_LIMIT)
    throw new ServiceError("request_too_large", 413, "Translation text exceeds 20,000 characters.");
  if (buildBatches(segmentText(adapted.canonical.rawText, adapted.canonical.sourceFormat).map(x => x.text)).length > BATCH_LIMIT)
    throw new ServiceError("request_too_large", 413, "Request exceeds four translation batches. Send smaller requests.");
  const result = await instance.translate(adapted.canonical, request.signal, provider);
  console.info({ request_id: id, model: result.model, batch_count: result.upstreamBatchCount,
    elapsed_ms: Math.round(result.elapsedMs), status_code: 200 });
  return adapted.canonical.stream
    ? new Response(formatSSE(protocol!, result, adapted), { headers: { "Content-Type": "text/event-stream" } })
    : Response.json(formatJSON(protocol!, result, adapted));
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const id = crypto.randomUUID();
    const headers = new Headers({ "X-Request-Id": id, "Cache-Control": "no-store" });
    let response: Response;
    try { response = await handle(request, env, id, headers); }
    catch (error) {
      let service = asServiceError(error);
      // An HTTP refusal alone does not prove that the Doubao login expired.
      if (service.code === "upstream_auth_error" && service.upstreamStatus)
        service = new ServiceError("upstream_http_error", 502, "Doubao refused the request; login expiry is unconfirmed.",
          false, null, undefined, service.upstreamStatus);
      if (service.upstreamStatus === 429)
        service = new ServiceError(service.code, 429, service.message, service.retryable, service.param,
          service.upstreamCode, service.upstreamStatus);
      const type = service.status === 401 ? "authentication_error" :
        service.status === 429 ? "rate_limit_error" : service.status < 500 ? "invalid_request_error" : "api_error";
      console.warn({ request_id: id, code: service.code, status_code: service.status,
        upstream_code: service.upstreamCode, upstream_status: service.upstreamStatus });
      response = Response.json(new URL(request.url).pathname === "/v1/messages"
        ? { type: "error", error: { type, message: service.message } }
        : { error: { type, message: service.message, code: service.code, param: service.param } },
      { status: service.status });
    }
    const output = new Response(response.body, response);
    headers.forEach((value, key) => output.headers.set(key, value));
    return output;
  },
};
